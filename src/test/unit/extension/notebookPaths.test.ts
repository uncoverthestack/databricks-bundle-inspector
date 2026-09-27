import { describe, test, expect, beforeAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  extractBundleGraph,
  type ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";
import { checkNotebookPath, isNotebookFile } from "../../../bundle/notebookFiles.js";

const bundleRoot = path.resolve(__dirname, "../../fixtures/notebook-paths");
const src = (name: string) => path.join(bundleRoot, "src", name);

const RESOURCE_FILES = [
  "resources/notebook_paths.job.yml",
  "resources/git_sourced.job.yml",
  "resources/notebook_paths.pipeline.yml",
];

// Without a target, `databricks bundle validate -o json` returns these paths unchanged
// (checked on CLI v1.17.0), so the fixture YAML stands in for the CLI output.
function fixtureConfig(): ParsedBundleConfig {
  const resources: Record<string, Record<string, unknown>> = {};
  for (const file of RESOURCE_FILES) {
    const parsed = parse(readFileSync(path.join(bundleRoot, file), "utf8")) as {
      resources: Record<string, Record<string, unknown>>;
    };
    for (const [group, entries] of Object.entries(parsed.resources)) {
      resources[group] = { ...resources[group], ...entries };
    }
  }
  return {
    bundle: { name: "notebook_paths" },
    include: RESOURCE_FILES,
    resources,
  } as ParsedBundleConfig;
}

describe("isNotebookFile", () => {
  // Expected values match the CLI; see the fixture README.
  test.each([
    ["nb_ok.sql", true],
    ["nb_crlf.py", true],
    ["nb_ok.ipynb", true],
    ["script_nb.py", true],
    ["nb_plain.sql", false],
    ["nb_bom.py", false],
    ["nb_trailing_space.py", false],
    ["nb_old.ipynb", false],
    ["plain.py", false],
  ])("%s is a notebook: %s", (file, expected) => {
    expect(isNotebookFile(src(file))).toBe(expected);
  });

  test("is undefined for a missing file or a folder", () => {
    expect(isNotebookFile(src("does_not_exist.py"))).toBeUndefined();
    expect(isNotebookFile(path.join(bundleRoot, "src"))).toBeUndefined();
  });
});

describe("checkNotebookPath", () => {
  test("suggests the extension for a notebook path without one", () => {
    expect(checkNotebookPath("../src/nb_noext", src("nb_noext"), "notebook")).toEqual({
      kind: "missing_extension",
      suggestedPath: "../src/nb_noext.sql",
    });
  });

  test("reports nothing extra when no file with a notebook extension exists", () => {
    expect(checkNotebookPath("../src/missing", src("missing"), "notebook")).toBeUndefined();
  });
});

describe("notebook path issues on the fixture bundle", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    const config = fixtureConfig();
    const graph = await extractBundleGraph(config, bundleRoot);
    issues = buildInspectorIssues(graph, config, [], bundleRoot).filter(
      (issue) => issue.kind === "missing_file" || issue.kind === "notebook_type_mismatch",
    );
  });

  function titleAt(yamlPathEnd: string): string | undefined {
    return issues.find((issue) => issue.yamlPath?.endsWith(yamlPathEnd))?.title;
  }

  test("job tasks follow the CLI's notebook rules", () => {
    expect(titleAt("tasks.no_extension.notebook_task.notebook_path")).toBe(
      'Notebook "../src/nb_noext" may not be found. Did you mean "../src/nb_noext.sql"?',
    );
    expect(titleAt("tasks.plain_sql.notebook_task.notebook_path")).toBe(
      '"../src/nb_plain.sql" may not be a notebook.',
    );
    expect(titleAt("tasks.bom.notebook_task.notebook_path")).toBe(
      '"../src/nb_bom.py" may not be a notebook.',
    );
    expect(titleAt("tasks.trailing_space.notebook_task.notebook_path")).toBe(
      '"../src/nb_trailing_space.py" may not be a notebook.',
    );
    expect(titleAt("tasks.old_ipynb.notebook_task.notebook_path")).toBe(
      '"../src/nb_old.ipynb" may not be a notebook.',
    );
    expect(titleAt("tasks.python_file_is_notebook.spark_python_task.python_file")).toBe(
      '"../src/script_nb.py" may be a notebook, not a file.',
    );
    expect(titleAt("tasks.sql_file_is_notebook.sql_task.file.path")).toBe(
      '"../src/query_nb.sql" may be a notebook, not a file.',
    );
  });

  test("pipeline libraries follow the CLI's notebook rules", () => {
    expect(titleAt("libraries[0].notebook.path")).toBe(
      'Notebook "../src/nb_noext" may not be found. Did you mean "../src/nb_noext.sql"?',
    );
    expect(titleAt("libraries[1].notebook.path")).toBe(
      '"../src/nb_plain.sql" may not be a notebook.',
    );
    expect(titleAt("libraries[2].file.path")).toBe(
      '"../src/script_nb.py" may be a notebook, not a file.',
    );
  });

  test("valid notebooks and files, and git-sourced jobs, have no issue", () => {
    for (const ok of [
      "tasks.ok_sql.notebook_task.notebook_path",
      "tasks.crlf.notebook_task.notebook_path",
      "tasks.ok_ipynb.notebook_task.notebook_path",
      "tasks.python_file_ok.spark_python_task.python_file",
      "tasks.from_git.notebook_task.notebook_path",
      "libraries[3].notebook.path",
    ]) {
      expect(titleAt(ok)).toBeUndefined();
    }
    expect(issues).toHaveLength(10);
  });

  test("the missing header hint names the header to add", () => {
    const issue = issues.find((i) => i.yamlPath?.endsWith("tasks.plain_sql.notebook_task.notebook_path"));
    expect(issue?.fixHint).toBe(
      'Add "-- Databricks notebook source" as its first line, or run it from a task that takes a file.',
    );
  });
});
