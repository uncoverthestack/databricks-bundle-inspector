import { describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { validateBundle } from "../../bundle/validateBundle.js";

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const FIXTURE = path.resolve("src/test/fixtures/job-environments");

/** Whether the CLI under test is this version or newer. */
function cliIsAtLeast(...minimum: [number, number, number]): boolean {
  const output = spawnSync(cli, ["--version"], { encoding: "utf-8" });
  const version = `${output.stdout ?? ""}${output.stderr ?? ""}`.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number);
  if (!version) throw new Error(`Could not read the version of ${cli}`);
  for (let i = 0; i < 3; i++) if (version[i] !== minimum[i]) return version[i]! > minimum[i]!;
  return true;
}

/**
 * Job environments that `bundle validate` accepts and Databricks rejects (#418). Each
 * broken case here was deployed or run on Databricks CLI v1.26.0 and failed; each clean
 * case deployed and ran. This runs the real CLI's preview output for the fixture through
 * the inspector, so a CLI that changes how it writes these fields fails this test.
 */
describe(`job environments that pass validate and fail later (${cli})`, () => {
  test("each broken environment gets one error at its line, and nothing else does", async () => {
    // The fixture's README lists each case and what deploy and run did with it.
    const dir = FIXTURE;
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
