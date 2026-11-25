import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { findEnvironmentProblems } from "../../../bundle/jobStructure.js";
import { findJobSettingProblems } from "../../../bundle/jobSettings.js";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";

// #612: regression tests for the deploy failures established by the audit's CLI v1.28.0
// live tests. These run locally; they do not deploy or run a Databricks workload.
const source = (text: string, file = "/bundle/databricks.yml") => ({
  file, text, doc: parse(text), locations: parseYamlLocations(file, text),
});

describe("library uploads require files", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "dbi-library-files-"));
    mkdirSync(path.join(root, "folder.whl"));
    mkdirSync(path.join(root, "folder.jar"));
    writeFileSync(path.join(root, "file.whl"), "wheel");
    writeFileSync(path.join(root, "file.jar"), "jar");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const issuesFor = async (field: "whl" | "jar", value: string, environment = false) => {
    const text = `bundle: { name: libraries }
resources:
  jobs:
    j:
      environments:
        - environment_key: e
          spec:
            environment_version: "5"
            dependencies: ${environment ? `[${JSON.stringify(value)}]` : "[]"}
      tasks:
        - task_key: t
          python_wheel_task: { package_name: example, entry_point: main }
          libraries: ${environment ? "[]" : `[{ ${field}: ${JSON.stringify(value)} }]`}
`;
    const file = source(text, path.join(root, "databricks.yml"));
    writeFileSync(file.file, text);
    const config = file.doc as ParsedBundleConfig;
    const graph = await extractBundleGraph(config, root);
    return buildInspectorIssues(graph, config, [], root).filter((issue) => issue.kind === "missing_library");
  };

  test.each([
    ["whl", "./folder.whl"], ["jar", "./folder.jar"],
    ["whl", "./folder*.whl"], ["jar", "./folder*.jar"],
    ["whl", "./*.whl"], ["jar", "./*.jar"],
  ] as const)("%s %s reports directories, even beside valid matches", async (field, value) => {
    const issues = await issuesFor(field, value);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", title: "Local library path must name a file", file: path.join(root, "databricks.yml"), line: 13 });
    expect(issues[0]!.detail).toContain("not a regular file");
  });
  test.each([["whl", "./file.whl"], ["jar", "./file*.jar"]] as const)("%s %s accepts real files", async (field, value) => {
    expect(await issuesFor(field, value)).toEqual([]);
  });
  test("a missing glob still says no file matches", async () => {
    const issues = await issuesFor("whl", "./missing*.whl");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toContain("no file matches");
  });
  test("an environment dependency reports a directory accurately", async () => {
    const issues = await issuesFor("whl", "./folder.whl", true);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toContain("not a regular file");
    expect(issues[0]!.line).toBe(9);
  });
});

describe("project_environment must be the only environment source", () => {
  const check = (fields: string) => {
    const file = source(`resources:
  jobs:
    j:
      environments:
        - environment_key: e
          spec:
            project_environment: ./pyproject.toml
            ${fields}
`);
    return findEnvironmentProblems((file.doc as any).resources.jobs, [file], {
      readProjectFile: () => '[tool.databricks.environment]\nenvironment_version = "5"\n',
    });
  };
  test.each([
    'environment_version: "5"', 'client: "2"', "base_environment: some-base",
    "image_uri: image", "dependencies: [six]", "java_dependencies: [org.example:lib:1]",
  ])("reports project_environment beside %s", (field) => {
    const issues = check(field);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "project_environment_conflict", location: { file: "/bundle/databricks.yml", line: 7 } });
    expect(issues[0]!.title).toContain(field.split(":")[0]);
  });
  test.each(["", "dependencies: []", "java_dependencies: []", 'environment_version: ""'])("does not reject an empty accompanying setting: %s", (field) => {
    expect(check(field)).toEqual([]);
  });
});

describe("for-each dynamic references must occupy the whole value", () => {
  const check = (inputs: string) => {
    const file = source(`resources:
  jobs:
    j:
      parameters: [{ name: items, default: '[1]' }]
      tasks:
        - task_key: loop
          for_each_task:
            inputs: ${JSON.stringify(inputs)}
            task: { task_key: inner, notebook_task: { notebook_path: ./nb.py } }
`);
    return findJobSettingProblems((file.doc as any).resources.jobs, [file])
      .filter((finding) => finding.kind === "for_each_inputs_not_array");
  };
  test.each([
    '["{{job.parameters.items}}"]', '["{{job.parameters.items}}", null]',
    '["{{job.parameters.items}}", "literal"]', '[{"key":"{{job.parameters.items}}"}]',
    '["{{tasks.producer.values.items}}"]',
  ])("reports embedded references: %s", (inputs) => {
    const issues = check(inputs);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ location: { line: 8 } });
    expect(issues[0]!.title).toContain("reference inside a JSON list");
    expect(issues[0]!.fixHint).toContain("whole value");
  });
  test.each([
    "{{job.parameters.items}}", " {{ tasks.producer.values.items }} ",
    '["literal", 1, true]', '[{"key":null}]', '["unfinished {{text"]',
  ])("keeps valid inputs quiet: %s", (inputs) => expect(check(inputs)).toEqual([]));
});
