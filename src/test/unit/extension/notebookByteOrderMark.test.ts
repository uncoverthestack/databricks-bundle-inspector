import { describe, expect, test, afterAll } from "@jest/globals";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import type { NotebookHeaderRule } from "../../../bundle/notebookFiles.js";
import { detectWidgetsInFile } from "../../../bundle/taskFileDetections.js";

// Expected answers come from job runs and pipeline updates on Databricks CLI v1.28.0,
// 2026-11-25, two runs each (#589): with a byte order mark first, a .py notebook failed with
// "SyntaxError: invalid non-printable character U+FEFF" and a .sql one with PARSE_SYNTAX_ERROR,
// as job tasks and as pipeline notebook libraries. A plain .py file with one ran fine.
// The files are written here, so no editor or tool can strip the mark from a fixture.

const BOM = "﻿";
const PY = "# Databricks notebook source\nprint(1)\n";
const SQL = "-- Databricks notebook source\nSELECT 1\n";
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

async function bomFindings(
  files: Record<string, string>,
  resources: Record<string, unknown>,
  notebookRule: NotebookHeaderRule = "contains",
): Promise<Array<{ kind: string; title: string; where: string }>> {
  const root = mkdtempSync(path.join(tmpdir(), "bom-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text, "utf8");
  }
  const config = { bundle: { name: "bom" }, resources } as unknown as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root, { notebookRule }));
  return buildInspectorIssues(graph, config, [], root)
    .filter((issue) => issue.kind === "notebook_byte_order_mark" || issue.kind === "not_a_notebook")
    .map((issue) => ({ kind: issue.kind, title: issue.title, where: issue.taskName ?? issue.resourceId ?? "" }));
}

const job = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({ jobs: { j: { name: "j", tasks, ...extra } } });
const notebookTask = (key: string, file: string) => ({ task_key: key, notebook_task: { notebook_path: `./${file}` } });

const JOB_TITLE =
  "This notebook starts with an invisible byte-order mark, so the job may fail when it runs. Save it as UTF-8 without BOM.";

describe("a notebook that starts with a byte order mark (#589)", () => {
  test("a Python and a SQL notebook task each get the error", async () => {
    const found = await bomFindings(
      { "py.py": BOM + PY, "sql.sql": BOM + SQL },
      job([notebookTask("py", "py.py"), { ...notebookTask("sql", "sql.sql"), notebook_task: { notebook_path: "./sql.sql", warehouse_id: "w" } }]),
    );
    expect(found).toEqual([
      { kind: "notebook_byte_order_mark", title: JOB_TITLE, where: "py" },
      { kind: "notebook_byte_order_mark", title: JOB_TITLE, where: "sql" },
    ]);
  });

  test("no error without the mark (control)", async () => {
    expect(await bomFindings({ "py.py": PY }, job([notebookTask("py", "py.py")]))).toEqual([]);
  });

  test("no error for a plain Python file with the mark, which runs fine", async () => {
    const tasks = [{ task_key: "script", spark_python_task: { python_file: "./script.py" } }];
    expect(await bomFindings({ "script.py": BOM + "print(1)\n" }, job(tasks))).toEqual([]);
  });

  test("a CLI before v1.24.0 doesn't take it as a notebook, which not_a_notebook reports instead", async () => {
    const found = await bomFindings({ "py.py": BOM + PY }, job([notebookTask("py", "py.py")]), "exact");
    expect(found.map((finding) => finding.kind)).toEqual(["not_a_notebook"]);
  });

  test("R and Scala notebooks weren't run, so they get nothing", async () => {
    const found = await bomFindings(
      { "r.r": BOM + "# Databricks notebook source\n1\n", "s.scala": BOM + "// Databricks notebook source\n1\n" },
      job([notebookTask("r", "r.r"), notebookTask("s", "s.scala")]),
    );
    expect(found).toEqual([]);
  });

  test("a job with a git_source runs the repository's notebook, so nothing", async () => {
    const found = await bomFindings(
      { "py.py": BOM + PY },
      job([notebookTask("py", "py.py")], { git_source: { git_url: "https://example.com/r.git", git_provider: "gitHub", git_branch: "main" } }),
    );
    expect(found).toEqual([]);
  });

  test("a pipeline notebook library gets the error, worded for the pipeline", async () => {
    const found = await bomFindings(
      { "dlt.sql": BOM + SQL },
      { pipelines: { p: { name: "p", libraries: [{ notebook: { path: "./dlt.sql" } }] } } },
    );
    expect(found).toEqual([
      {
        kind: "notebook_byte_order_mark",
        title: "This notebook starts with an invisible byte-order mark, so the pipeline may fail when it runs. Save it as UTF-8 without BOM.",
        where: "resources.pipelines.p",
      },
    ]);
  });

  test("its cells are still read, so other checks see the code", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bom-cells-"));
    roots.push(root);
    const file = path.join(root, "nb.py");
    writeFileSync(file, BOM + "# Databricks notebook source\n# COMMAND ----------\n# MAGIC %sql\n# MAGIC SELECT :needed\n", "utf8");
    expect((await detectWidgetsInFile(file)).map((read) => read.name)).toEqual(["needed"]);
  });
});
