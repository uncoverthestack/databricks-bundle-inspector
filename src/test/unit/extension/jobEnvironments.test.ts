import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { findEnvironmentProblems, pyprojectNamesEnvironmentVersion } from "../../../bundle/jobStructure.js";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// Cases from the live tests in #418 (Databricks CLI v1.26.0, 2026-11-12): each passes
// `bundle validate`; the first two kinds fail `bundle deploy`, the third fails the run.

const sourceFile = (text: string, file = "/b/databricks.yml") => ({
  file,
  doc: parse(text, { merge: true }),
  text,
  locations: parseYamlLocations(file, text),
});
/** Checks the jobs as written, with their locations, as the preview resolves them. */
const check = (text: string, options: Parameters<typeof findEnvironmentProblems>[2] = {}) => {
  const file = sourceFile(text);
  return findEnvironmentProblems((file.doc as any).resources.jobs, [file], options);
};
const summary = (findings: { kind: string; title: string; location?: { line: number } }[]) =>
  findings.map((f) => `${f.kind} @${f.location?.line ?? "-"}: ${f.title}`);

describe("environment_version_missing", () => {
  test.each([
    ["only dependencies", "spec:\n            dependencies: [simplejson]"],
    ["an empty spec", "spec: {}"],
    ["a version that is an empty string", 'spec:\n            environment_version: ""'],
  ])("%s fails deploy", (_case, spec) => {
    const findings = check(`
resources:
  jobs:
    j:
      environments:
        - environment_key: e
          ${spec}
`);
    expect(summary(findings)).toEqual(['environment_version_missing @6: Environment "e" has no version. Deploy may fail.']);
    expect(findings[0]!.fixHint).toContain("Either base environment, version, or project_environment must be provided");
  });

  test("no spec at all points at the environment's key", () => {
    expect(summary(check("resources:\n  jobs:\n    j:\n      environments:\n        - environment_key: e\n"))).toEqual([
      'environment_version_missing @5: Environment "e" has no version. Deploy may fail.',
    ]);
  });

  test.each([
    ["environment_version", 'environment_version: "5"'],
    ["a number", "environment_version: 5"],
    ["client, the older field (deploys and runs on v1.26.0)", 'client: "2"'],
    ["base_environment", "base_environment: workspace-base-environments/databricks_ml_v5"],
    ["a variable the preview leaves unresolved", "environment_version: ${var.env_version}"],
  ])("%s gives a version", (_case, field) => {
    expect(check(`resources:\n  jobs:\n    j:\n      environments:\n        - environment_key: e\n          spec:\n            ${field}\n`)).toEqual([]);
  });

  test("one finding per environment that lacks a version, on its own line", () => {
    const findings = check(`
resources:
  jobs:
    j:
      environments:
        - environment_key: ok
          spec: { environment_version: "5" }
        - environment_key: bad
          spec: { dependencies: [x] }
`);
    expect(summary(findings)).toEqual(['environment_version_missing @8: Environment "bad" has no version. Deploy may fail.']);
  });

  test("an environment only a target defines is found in the target's list", () => {
    const text = `
resources:
  jobs:
    j:
      tasks: [{ task_key: t, environment_key: e }]
targets:
  dev:
    resources:
      jobs:
        j:
          environments:
            - environment_key: e
              spec: { dependencies: [x] }
`;
    const file = sourceFile(text);
    const resolved = { j: { tasks: [{ task_key: "t", environment_key: "e" }], environments: [{ environment_key: "e", spec: { dependencies: ["x"] } }] } };
    const findings = findEnvironmentProblems(resolved, [file], { activeTarget: "dev" });
    expect(summary(findings)).toEqual(['environment_version_missing @12: Environment "e" has no version. Deploy may fail.']);
  });

  test("a version the CLI dropped as unknown (project_environment before v1.20.0) is not called missing", () => {
    const text = "resources:\n  jobs:\n    j:\n      environments:\n        - environment_key: e\n          spec:\n            project_environment: ./pyproject.toml\n";
    const file = sourceFile(text);
    // What CLI v0.299.2 outputs: the spec without the field it doesn't know.
    const resolved = { j: { environments: [{ environment_key: "e", spec: {} }] } };
    expect(findEnvironmentProblems(resolved, [file])).toEqual([]);
  });

  test("no environments, no finding", () => {
    expect(check("resources:\n  jobs:\n    j:\n      tasks: [{ task_key: t, notebook_task: { notebook_path: ./nb.py } }]\n")).toEqual([]);
  });
});

describe("unknown_environment_key", () => {
  const job = (tasks: string) => `
resources:
  jobs:
    j:
      environments:
        - environment_key: default
          spec: { environment_version: "5" }
      tasks:
${tasks}`;

  test("a typo gets a suggestion, on the task's environment_key line", () => {
    const findings = check(job("        - task_key: script\n          environment_key: defualt\n"));
    expect(summary(findings)).toEqual(['unknown_environment_key @10: Environment "defualt" may not exist. Did you mean "default"?']);
    expect(findings[0]).toMatchObject({ jobKey: "j", taskKey: "script" });
    expect(findings[0]!.fixHint).toContain("Job environment 'defualt' used by task script is not defined in field 'environments'");
  });

  test("no suggestion when nothing is close", () => {
    expect(check(job("        - task_key: s\n          environment_key: gpu_heavy\n"))[0]!.title).toBe('Environment "gpu_heavy" may not exist.');
  });

  test("a for-each task's inner task is checked", () => {
    const findings = check(job("        - task_key: loop\n          for_each_task:\n            inputs: '[1]'\n            task:\n              task_key: inner\n              environment_key: defalt\n"));
    expect(summary(findings)).toEqual(['unknown_environment_key @14: Environment "defalt" may not exist. Did you mean "default"?']);
  });

  test("tasks without an environment_key, or with a known one, are fine", () => {
    expect(check(job("        - task_key: a\n          environment_key: default\n        - task_key: b\n          existing_cluster_id: abc\n"))).toEqual([]);
  });

  test("a job with no environments at all", () => {
    const findings = check("resources:\n  jobs:\n    j:\n      tasks:\n        - task_key: s\n          environment_key: e\n");
    expect(findings[0]!.kind).toBe("unknown_environment_key");
    expect(findings[0]!.fixHint).toContain("or add one");
  });

  test("an environment key the preview can't resolve leaves the job's tasks unjudged", () => {
    const text = job("        - task_key: s\n          environment_key: other\n").replace("environment_key: default", "environment_key: ${var.env}");
    expect(check(text)).toEqual([]);
  });

  test("a task key resolved from a variable is compared as its value", () => {
    const text = job("        - task_key: s\n          environment_key: ${var.env}\n");
    const findings = check(text, { resolve: (value) => (value === "${var.env}" ? "default" : undefined) });
    expect(findings).toEqual([]);
  });
});

describe("project_environment_version_missing", () => {
  const job = `
resources:
  jobs:
    j:
      environments:
        - environment_key: e
          spec:
            project_environment: ./pyproject.toml
`;
  const withFile = (text: string | undefined) => check(job, { readProjectFile: () => text });

  test("a pyproject.toml with only [project] fails the run", () => {
    const findings = withFile('[project]\nname = "x"\ndependencies = ["simplejson==3.19.*"]\n');
    expect(summary(findings)).toEqual([
      'project_environment_version_missing @8: Environment "e": its pyproject.toml has no environment version. The job may fail when it runs.',
    ]);
  });

  test.each([
    ["a [tool.databricks.environment] table", '[tool.databricks.environment]\nenvironment_version = "5"\n'],
    ["base_environment", '[tool.databricks.environment]\nbase_environment = "workspace-base-environments/databricks_ml_v5"\n'],
    ["dotted keys", 'tool.databricks.environment.environment_version = "5"\n'],
    ["an inline table", '[tool.databricks]\nenvironment = { environment_version = "5" }\n'],
    ["spaces and a comment after the value", '[tool.databricks.environment]\n  environment_version   =   "5"  # pinned\n'],
  ])("%s names a version", (_case, text) => {
    expect(pyprojectNamesEnvironmentVersion(text)).toBe(true);
    expect(withFile(text)).toEqual([]);
  });

  test("a commented-out version doesn't count", () => {
    expect(pyprojectNamesEnvironmentVersion('[tool.databricks.environment]\n# environment_version = "5"\n')).toBe(false);
  });

  test("a file that can't be read is not checked", () => {
    expect(withFile(undefined)).toEqual([]);
  });

  test("another version field next to it: only the file isn't read", () => {
    let read = false;
    const text = job.replace("project_environment: ./pyproject.toml", 'project_environment: ./pyproject.toml\n            environment_version: "5"');
    expect(check(text, { readProjectFile: () => ((read = true), "[project]\n") })).toEqual([]);
    expect(read).toBe(false);
  });
});

describe("through the real pipeline", () => {
  let parent: string;
  let bundleRoot: string;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(tmpdir(), "bdi-env-"));
    bundleRoot = path.join(parent, "proj");
    await mkdir(path.join(bundleRoot, "src"), { recursive: true });
    await writeFile(path.join(bundleRoot, "src", "probe.py"), "print(1)\n");
    await writeFile(path.join(bundleRoot, "pyproject.toml"), '[project]\nname = "probe"\ndependencies = ["simplejson"]\n');
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  const yaml = `bundle:
  name: envtest
resources:
  jobs:
    j:
      environments:
        - environment_key: deps
          spec:
            dependencies: [simplejson]
        - environment_key: project
          spec:
            project_environment: ./pyproject.toml
      tasks:
        - task_key: script
          environment_key: dep
          spark_python_task:
            python_file: ./src/probe.py
`;
  const jobOutput = (projectPath: string, pythonFile: string) => ({
    environments: [
      { environment_key: "deps", spec: { dependencies: ["simplejson"] } },
      { environment_key: "project", spec: { project_environment: projectPath } },
    ],
    tasks: [{ task_key: "script", environment_key: "dep", spark_python_task: { python_file: pythonFile } }],
  });

  test("the structural preview reports all three as errors on their lines", async () => {
    await writeFile(path.join(bundleRoot, "databricks.yml"), yaml);
    // `bundle validate -o json` in the preview keeps paths as written (checked on v1.26.0).
    const output = { bundle: { name: "envtest" }, resources: { jobs: { j: jobOutput("./pyproject.toml", "./src/probe.py") } } } as unknown as ParsedBundleConfig;
    const graph = await extractBundleGraph(output, bundleRoot);
    const issues = buildInspectorIssues(graph, output, [], bundleRoot)
      .filter((issue) => issue.kind.includes("environment"))
      .map((issue) => `${issue.severity} ${issue.kind} ${path.basename(issue.file ?? "")}:${issue.line}`);
    expect(issues.sort()).toEqual([
      "error environment_version_missing databricks.yml:7",
      "error project_environment_version_missing databricks.yml:12",
      "error unknown_environment_key databricks.yml:15",
    ]);
  });

  test("a real target's workspace path is read back as the local pyproject.toml", async () => {
    await writeFile(path.join(bundleRoot, "databricks.yml"), yaml);
    const files = "/Workspace/Users/someone@example.com/.bundle/envtest/dev/files";
    // A fully resolved real target, as `bundle validate -o json -t dev` writes it (v1.26.0).
    const output = {
      bundle: { name: "envtest", target: "dev" },
      workspace: { file_path: files },
      resources: { jobs: { j: jobOutput(`${files}/pyproject.toml`, `${files}/src/probe.py`) } },
    } as unknown as ParsedBundleConfig;
    const graph = await extractBundleGraph(output, bundleRoot);
    const kinds = buildInspectorIssues(graph, output, [], bundleRoot, "dev").map((issue) => issue.kind);
    expect(kinds).toContain("project_environment_version_missing");
  });

  test("a pinned pyproject.toml, a known key and a version give no findings", async () => {
    await writeFile(path.join(bundleRoot, "pyproject.toml"), '[project]\nname = "probe"\n\n[tool.databricks.environment]\nenvironment_version = "5"\n');
    await writeFile(path.join(bundleRoot, "databricks.yml"), yaml.replace("environment_key: dep\n", "environment_key: deps\n").replace("dependencies: [simplejson]", 'environment_version: "5"'));
    const job = jobOutput("./pyproject.toml", "./src/probe.py");
    job.environments[0]!.spec = { environment_version: "5" } as never;
    job.tasks[0]!.environment_key = "deps";
    const output = { bundle: { name: "envtest" }, resources: { jobs: { j: job } } } as unknown as ParsedBundleConfig;
    const graph = await extractBundleGraph(output, bundleRoot);
    expect(buildInspectorIssues(graph, output, [], bundleRoot).filter((issue) => issue.kind.includes("environment"))).toEqual([]);
  });
});
