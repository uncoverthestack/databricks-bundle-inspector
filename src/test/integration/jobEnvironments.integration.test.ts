import { afterAll, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { validateBundle } from "../../bundle/validateBundle.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const created: string[] = [];

/** Whether the CLI under test is this version or newer. */
function cliIsAtLeast(...minimum: [number, number, number]): boolean {
  const output = spawnSync(cli, ["--version"], { encoding: "utf-8" });
  const version = `${output.stdout ?? ""}${output.stderr ?? ""}`.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number);
  if (!version) throw new Error(`Could not read the version of ${cli}`);
  for (let i = 0; i < 3; i++) if (version[i] !== minimum[i]) return version[i]! > minimum[i]!;
  return true;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Job environments that `bundle validate` accepts and Databricks rejects (#418). Each
 * broken case here was deployed or run on Databricks CLI v1.26.0 and failed; each clean
 * case deployed and ran. This runs the real CLI's preview output through the inspector,
 * so a CLI that changes how it writes these fields fails this test.
 */
describe(`job environments that pass validate and fail later (${cli})`, () => {
  test("each broken environment gets one error at its line, and nothing else does", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbi-environments-"));
    created.push(dir);
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "resources"));
    await mkdir(path.join(dir, "projects", "pinned"), { recursive: true });
    await writeFile(path.join(dir, "src", "probe.py"), "print(1)\n");
    await writeFile(path.join(dir, "projects", "pyproject.toml"), '[project]\nname = "probe"\ndependencies = ["simplejson"]\n');
    await writeFile(
      path.join(dir, "projects", "pinned", "pyproject.toml"),
      '[project]\nname = "probe"\n\n[tool.databricks.environment]\nenvironment_version = "5"\n',
    );
    await writeFile(
      path.join(dir, "databricks.yml"),
      [
        "bundle:",
        "  name: environments",
        "include:",
        "  - resources/*.yml",
        "variables:",
        "  env_version:",
        '    default: "5"',
        "targets:",
        "  dev:",
        "    default: true",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(dir, "resources", "job.yml"),
      [
        "resources:",
        "  jobs:",
        "    envs:",
        "      environments:",
        "        - environment_key: deps_only", //                       5: no version
        "          spec:",
        "            dependencies: [simplejson]",
        "        - environment_key: empty", //                           8: empty spec
        "          spec: {}",
        "        - environment_key: no_spec", //                        10: no spec
        "        - environment_key: version",
        '          spec: { environment_version: "5" }',
        "        - environment_key: from_variable",
        '          spec: { environment_version: "${var.env_version}" }',
        "        - environment_key: old_client",
        '          spec: { client: "2" }',
        "        - environment_key: base",
        "          spec: { base_environment: workspace-base-environments/databricks_ml_v5 }",
        "        - environment_key: project",
        "          spec:",
        "            project_environment: ../projects/pyproject.toml", // 21: no version in the file
        "        - environment_key: pinned_project",
        "          spec:",
        "            project_environment: ../projects/pinned/pyproject.toml",
        "      tasks:",
        "        - task_key: typo",
        "          environment_key: versoin", //                         27: did you mean "version"
        "          spark_python_task:",
        "            python_file: ../src/probe.py",
        "        - task_key: fine",
        "          environment_key: version",
        "          spark_python_task:",
        "            python_file: ../src/probe.py",
        "        - task_key: loop",
        "          for_each_task:",
        '            inputs: "[1, 2]"',
        "            task:",
        "              task_key: loop_inner",
        "              environment_key: bse", //                         39: did you mean "base"
        "              spark_python_task:",
        "                python_file: ../src/probe.py",
        "",
      ].join("\n"),
    );

    const result = await validateBundle(dir, undefined, cli);
    if (!result.ok) throw new Error(result.error.details ?? result.error.error);
    // The CLI loaded the job: a YAML mistake in the test itself would otherwise pass as "no findings".
    expect(Object.keys(result.data.resources?.jobs ?? {})).toEqual(["envs"]);
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
    const issues = buildInspectorIssues(graph, result.data, result.issues ?? [], dir);
    const findings = issues
      .filter((issue) => issue.kind.includes("environment"))
      .map((issue) => ({ kind: issue.kind, file: path.relative(dir, issue.file ?? ""), line: issue.line, severity: issue.severity, title: issue.title }))
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

    // project_environment arrived in CLI v1.20.0. An older CLI drops it with an "unknown
    // field" warning, and the inspector must not then say the environment has no version.
    const knowsProjectEnvironment = cliIsAtLeast(1, 20, 0);
    expect(findings).toEqual([
      { kind: "environment_version_missing", file: "resources/job.yml", line: 5, severity: "error", title: 'Environment "deps_only" has no version. Deploy may fail.' },
      { kind: "environment_version_missing", file: "resources/job.yml", line: 8, severity: "error", title: 'Environment "empty" has no version. Deploy may fail.' },
      { kind: "environment_version_missing", file: "resources/job.yml", line: 10, severity: "error", title: 'Environment "no_spec" has no version. Deploy may fail.' },
      ...(knowsProjectEnvironment
        ? [
            {
              kind: "project_environment_version_missing",
              file: "resources/job.yml",
              line: 21,
              severity: "error",
              title: 'Environment "project": its pyproject.toml has no environment version. The job may fail when it runs.',
            },
          ]
        : []),
      { kind: "unknown_environment_key", file: "resources/job.yml", line: 27, severity: "error", title: 'Environment "versoin" may not exist. Did you mean "version"?' },
      { kind: "unknown_environment_key", file: "resources/job.yml", line: 39, severity: "error", title: 'Environment "bse" may not exist. Did you mean "base"?' },
    ]);
    if (!knowsProjectEnvironment) {
      const unknownField = issues.filter((issue) => issue.kind === "unknown_or_deprecated_field").map((issue) => issue.line);
      expect(unknownField).toEqual(expect.arrayContaining([21, 24]));
    }
  });
});
