import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { findEnvironmentProblems } from "../../../bundle/jobStructure.js";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";

// #604: local regression tests for the four live CLI v1.28.0 cases recorded in the issue.
const yaml = `resources:
  jobs:
    j:
      environments:
        - environment_key: e
          spec:
            project_environment: ./pyproject.toml
`;
const check = (text: string) => {
  const file = { file: "/b/databricks.yml", text: yaml, doc: parse(yaml), locations: parseYamlLocations("/b/databricks.yml", yaml) };
  return findEnvironmentProblems(file.doc.resources.jobs, [file], { readProjectFile: () => text });
};

describe("the project's own Databricks environment table", () => {
  test.each([
    '[tool.other]\nenvironment_version = "5"',
    '[tool.other]\nbase_environment = "some-base"',
    '[tool.databricks.environment]\nenvironment_version = ""',
    '[tool.databricks.environment]\nenvironment_version = "  "',
    '[tool.databricks.environment]\nbase_environment = ""',
    '[tool.databricks.environment]\n# environment_version = "5"',
    '[project]\ndescription = """\nenvironment_version = "5"\n"""',
    '["tool.databricks.environment"]\nenvironment_version = "5"',
  ])("does not accept a misleading version: %s", (text) => {
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "project_environment_version_missing", location: { file: "/b/databricks.yml", line: 7 } });
  });
  test.each(['"4"', '"1"', '"0"', '4'])("reports an unsupported project version %s", (version) => {
    const findings = check(`[tool.databricks.environment]\nenvironment_version = ${version}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "project_environment_version_unsupported", location: { line: 7 } });
    expect(findings[0]!.fixHint).toContain("5 or later");
  });
  test.each([
    '[tool.databricks.environment]\nenvironment_version = "5"',
    '[tool.databricks.environment]\nenvironment_version = "6"',
    '[tool.databricks.environment]\nbase_environment = "some-base"',
    'tool.databricks.environment.environment_version = "5"',
    '[tool.databricks]\nenvironment = { environment_version = "5" }',
    '["tool"."databricks"."environment"]\n"environment_version" = "5"',
    '[tool.databricks.environment]\nenvironment_version = "5" # comment',
    '[tool.databricks.environment]\nbase_environment = "workspace#base"',
    '[tool.other]\nenvironment_version = "4"\n[tool.databricks.environment]\nenvironment_version = "5"',
    '[project]\nlarge_number = 9223372036854775807\n[tool.databricks.environment]\nenvironment_version = "5"',
  ])("near miss (project_environment_version_unsupported): keeps valid project settings quiet: %s", (text) => expect(check(text)).toEqual([]));
  test("a parser failure is not misreported as a missing version", () => {
    expect(check('[tool.databricks.environment]\nenvironment_version = "5')).toEqual([]);
  });
});

describe("project file upload coverage through the graph", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dbi-project-env-"));
    await mkdir(path.join(root, "resources"));
    await writeFile(path.join(root, "resources", "pyproject.toml"), '[tool.databricks.environment]\nenvironment_version = "5"\n');
    await writeFile(path.join(root, "resources", "job.yml"), yaml);
    await writeFile(path.join(root, "databricks.yml"), 'bundle: { name: project-env }\ninclude: [resources/job.yml]\n');
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const issuesFor = async (sync?: ParsedBundleConfig["sync"], targetName?: string) => {
    const config = { bundle: { name: "project-env" }, include: ["resources/job.yml"], resources: parse(yaml).resources, ...(sync ? { sync } : {}) } as ParsedBundleConfig;
    const graph = await extractBundleGraph(config, root);
    return buildInspectorIssues(graph, config, [], root, targetName).filter((issue) => issue.kind === "excluded_from_sync");
  };
  test("a project file in .gitignore is reported at its included YAML location", async () => {
    await writeFile(path.join(root, ".gitignore"), "pyproject.toml\n");
    const issues = await issuesFor();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", resourceId: "resources.jobs.j", file: path.join(root, "resources", "job.yml"), line: 7 });
    expect(issues[0]!.title).toContain("not uploaded");
  });
  test("sync.exclude is reported even if sync.include adds the file", async () => {
    expect(await issuesFor({ include: ["resources/pyproject.toml"], exclude: ["resources/pyproject.toml"] })).toHaveLength(1);
  });
  test("sync.include can restore a gitignored file", async () => {
    await writeFile(path.join(root, ".gitignore"), "pyproject.toml\n");
    expect(await issuesFor({ include: ["resources/pyproject.toml"] })).toEqual([]);
  });
  test("a normally uploaded project file stays quiet", async () => {
    expect(await issuesFor()).toEqual([]);
  });
  test("the default sync.paths in a selected target still checks exclusion", async () => {
    await writeFile(path.join(root, ".gitignore"), "pyproject.toml\n");
    expect(await issuesFor({ paths: ["."] }, "prod")).toHaveLength(1);
  });
  test("an unmodelled external sync root is not judged by bundle-root patterns", async () => {
    await writeFile(path.join(root, ".gitignore"), "pyproject.toml\n");
    expect(await issuesFor({ paths: [".", "../shared"] })).toEqual([]);
  });
});
