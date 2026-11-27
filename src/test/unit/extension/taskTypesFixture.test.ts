import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// The task-types fixture (#646), from the Databricks CLI's own output with target prod. See
// the fixture's README for what deploy did with each case (CLI v1.28.0, 2026-11-27).
const ROOT = path.resolve("src/test/fixtures/task-types");

async function findings() {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
  return buildInspectorIssues(graph, bundle, [], ROOT)
    .filter((issue) => issue.kind === "multiple_task_types")
    .map((issue) => {
      const text = readFileSync(issue.file!, "utf8").split(/\r?\n/)[issue.line! - 1]!.trim();
      return { task: issue.taskName, severity: issue.severity, at: text, title: issue.title, line: issue.line };
    })
    .sort((a, b) => String(a.task).localeCompare(String(b.task)));
}

describe("multiple_task_types", () => {
  test("a task with two task types is reported, on the type a target adds", async () => {
    expect(await findings()).toEqual([
      {
        task: "both_in_base",
        severity: "error",
        line: 17,
        at: "notebook_task: { notebook_path: ./src/nb.py }",
        title: 'Keep one task type on task "both_in_base": it has notebook_task and spark_python_task, and Databricks may run only one.',
      },
      {
        task: "loop",
        severity: "error",
        line: 26,
        at: "notebook_task: { notebook_path: ./src/nb.py }",
        title: 'Keep one task type on task "loop_inner": it has notebook_task and condition_task, and Databricks may run only one.',
      },
      {
        task: "nb_to_py",
        severity: "error",
        line: 49,
        at: "spark_python_task: { python_file: ./src/s.py }",
        title: 'Keep one task type on task "nb_to_py": it has notebook_task and spark_python_task, and Databricks may run only one.',
      },
      {
        task: "py_to_nb",
        severity: "error",
        line: 47,
        at: "notebook_task: { notebook_path: ./src/nb.py }",
        title: 'Keep one task type on task "py_to_nb": it has notebook_task and spark_python_task, and Databricks may run only one.',
      },
    ]);
  });

  test("near miss (multiple_task_types): a target that keeps the type, or one type alone, is not reported", async () => {
    const tasks = (await findings()).map((finding) => finding.task);
    for (const quiet of ["same_type_new_path", "other_setting", "one_type"]) expect(tasks).not.toContain(quiet);
  });
});
