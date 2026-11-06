import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectRunTargetsInFile, detectWidgetUsageInFile } from "../../../bundle/taskFileDetections.js";
import { checkRunTarget } from "../../../bundle/runTargets.js";
import { notebookViews } from "../../../bundle/code/notebookViews.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "run-target-stress-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("run-target parsing and file boundaries", () => {
  test.each(["./shared helpers", "./données/helper notebook", "./helper's copy"])("a quoted notebook path stays intact: %s", async (target) => {
    const file = path.join(root, "main.py");
    await mkdir(path.dirname(path.resolve(root, target)), { recursive: true });
    await writeFile(path.resolve(root, target) + ".py", "# Databricks notebook source\nprint('ok')\n");
    await writeFile(file, `# Databricks notebook source\r\n# MAGIC %run "${target}" $name="value with spaces"\r\n`);
    const found = await detectRunTargetsInFile(file);
    expect(found[0]).toMatchObject({ target: `"${target}"`, line: 2 });
    expect(checkRunTarget(file, found[0]!.target).status).toBe("notebook");
  });

  test("quoted SQL and Jupyter run paths preserve widget arguments", () => {
    const line = '%run "./shared helpers" $env="dev" $limit=10';
    const sql = notebookViews(`-- Databricks notebook source\n-- MAGIC ${line}\n`, { jupyter: false, fileLanguage: "sql" });
    const ipynb = notebookViews(JSON.stringify({ cells: [{ cell_type: "code", source: [line] }], metadata: {}, nbformat: 4 }), { jupyter: true, fileLanguage: "python" });
    for (const views of [sql, ipynb]) {
      expect(views.runs[0]).toMatchObject({ target: '"./shared helpers"', args: { env: "dev", limit: "10" } });
    }
  });

  test("a task's run-target scan does not traverse child notebook contexts", async () => {
    const file = path.join(root, "main.py");
    await writeFile(file, '# Databricks notebook source\n# MAGIC %run ./child\n');
    await writeFile(path.join(root, "child.py"), '# Databricks notebook source\n# MAGIC %run ./main\n# COMMAND ----------\ndbutils.notebook.run("./missing_in_child", 60)\n');
    const found = await detectRunTargetsInFile(file);
    expect(found.map(({ target }) => target)).toEqual(["./child"]);
  });

  test("Python literals, dynamic arguments and comments remain distinct", async () => {
    const file = path.join(root, "main.py");
    await writeFile(file, `# Databricks notebook source
# dbutils.notebook.run("./comment", 60)
text = 'dbutils.notebook.run("./string", 60)'
dbutils.notebook.run(path="./real", timeout_seconds=60)
dbutils.notebook.run(f"./{name}", 60)
dbutils.notebook.run("./" + name, 60)
other.notebook.run("./other", 60)
`);
    const found = await detectRunTargetsInFile(file);
    expect(found.map(({ target }) => target)).toEqual(["./real", null, null]);
  });

  test("header classification follows the selected CLI version", async () => {
    const file = path.join(root, "main.py");
    await writeFile(path.join(root, "child.py"), "\uFEFF# Databricks notebook source\n");
    expect(checkRunTarget(file, "./child", "exact").status).toBe("file");
    expect(checkRunTarget(file, "./child", "contains").status).toBe("notebook");
  });

  test("widgets in a quoted child path are still followed", async () => {
    const file = path.join(root, "main.py");
    await writeFile(file, '# Databricks notebook source\n# MAGIC %run "./shared helpers"\n');
    await writeFile(path.join(root, "shared helpers.py"), '# Databricks notebook source\ndbutils.widgets.text("environment", "dev")\n');
    const usage = await detectWidgetUsageInFile(file);
    expect(usage.defaults).toContain("environment");
  });

  test.each(["python", "sql", "jupyter"])("quoted paths produce correct findings through the full pipeline: %s", async (format) => {
    const fileName = format === "jupyter" ? "main.ipynb" : format === "sql" ? "main.sql" : "main.py";
    const lines = ['%run "./existing helper"', '%run "./absent helper"'];
    const content = format === "jupyter"
      ? JSON.stringify({ cells: lines.map((line) => ({ cell_type: "code", source: [line] })), metadata: {}, nbformat: 4 })
      : `${format === "sql" ? "--" : "#"} Databricks notebook source\n` + lines.map((line) => `${format === "sql" ? "--" : "#"} MAGIC ${line}`).join(`\n${format === "sql" ? "--" : "#"} COMMAND ----------\n`);
    await writeFile(path.join(root, fileName), content);
    await writeFile(path.join(root, "existing helper.py"), "# Databricks notebook source\n");
    const config = { bundle: { name: "stress" }, resources: { jobs: { stress: { tasks: [{ task_key: "main", notebook_task: { notebook_path: `./${fileName}` } }] } } } } as unknown as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
    const issues = buildInspectorIssues(graph, config, [], root).filter((issue) => issue.kind === "run_target_not_found");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: path.join(root, fileName), taskName: "main", line: format === "jupyter" ? 2 : 4 });
    expect(issues[0]!.title).toContain('./absent helper');
  });

  test("many repeated includes do not expand child run graphs", async () => {
    const file = path.join(root, "main.py");
    const count = 2000;
    const childRuns = Array.from({ length: 20 }, () => '# MAGIC %run ./child').join('\n# COMMAND ----------\n');
    await writeFile(path.join(root, "child.py"), `# Databricks notebook source\n${childRuns}\n`);
    await writeFile(file, '# Databricks notebook source\n' + Array.from({ length: count }, () => '# MAGIC %run ./child').join('\n# COMMAND ----------\n'));
    const found = await detectRunTargetsInFile(file);
    expect(found).toHaveLength(count);
    expect(found[0]).toMatchObject({ target: "./child", line: 2 });
    expect(found[count - 1]).toMatchObject({ target: "./child", line: count * 2 });
  });

  test("generated notebook paths classify consistently across extensions and header rules", async () => {
    const file = path.join(root, "main.py");
    const headers: Record<string, string> = { py: "#", sql: "--", scala: "//", r: "#" };
    let checks = 0;
    for (const [extension, prefix] of Object.entries(headers)) {
      for (const name of ["simple", "has spaces", "café", "has.dots", "dollar$name", "hash#name"]) {
        const target = `./${extension}-${name}`;
        await writeFile(path.resolve(root, target) + `.${extension}`, `${prefix} Databricks notebook source\r\n`);
        for (const rule of ["exact", "contains"] as const) {
          for (const written of [target, `"${target}"`, `'${target}'`, `${target}.${extension}`]) {
            expect({ written, rule, status: checkRunTarget(file, written, rule).status }).toEqual({ written, rule, status: "notebook" });
            checks++;
          }
        }
      }
    }
    expect(checks).toBe(192);
  });
});

// Each case was run as a job task on a serverless workspace (Databricks CLI v1.24.0,
// 2026-11-06): "Notebook not found" for ./Helper, ./helper/ runs helper, and a %run
// cell is read whole, so "%run" further down a cell is not a run.
describe("run-target cases checked on a workspace", () => {
  const header = "# Databricks notebook source\n";

  test("%run text in a %md cell is not a run; lower in a Python cell it is", async () => {
    const file = path.join(root, "main.py");
    await writeFile(
      file,
      header +
        "# MAGIC %md\n# MAGIC Load helpers with:\n# MAGIC %run ./not_real\n\n# COMMAND ----------\n\n" +
        "x = 1\n# MAGIC %run ./mid_python\n\n# COMMAND ----------\n\n\n# MAGIC %run ./starts_cell\n",
    );
    expect((await detectRunTargetsInFile(file)).map((run) => run.target)).toEqual(["./mid_python", "./starts_cell"]);
  });

  test("%run lower in a SQL cell is not a run", async () => {
    const file = path.join(root, "main.sql");
    await writeFile(file, "-- Databricks notebook source\nSELECT 1;\n-- MAGIC %run ./mid_sql\n\n-- COMMAND ----------\n\n-- MAGIC %run ./starts_cell\n");
    expect((await detectRunTargetsInFile(file)).map((run) => run.target)).toEqual(["./starts_cell"]);
  });

  test("the widget scan follows the notebook %run runs, not a plain file of the same name", async () => {
    const file = path.join(root, "main.py");
    await writeFile(file, header + "# MAGIC %run ./two\n");
    await writeFile(path.join(root, "two.py"), "import os\n");
    await writeFile(path.join(root, "two.sql"), "-- Databricks notebook source\nCREATE WIDGET TEXT region DEFAULT 'eu';\n");
    const usage = await detectWidgetUsageInFile(file);
    expect(usage.defaults).toContain("region");
    expect(usage.hasUnresolvedRuns).toBe(false);
  });

  test("a %run of a plain file, or of an R notebook, leaves the widget checks to the run-target error", async () => {
    const file = path.join(root, "main.py");
    await writeFile(file, header + "# MAGIC %run ./plain\n\n# COMMAND ----------\n\n# MAGIC %run ./child_r\n");
    await writeFile(path.join(root, "plain.py"), 'dbutils.widgets.text("from_plain", "x")\n');
    await writeFile(path.join(root, "child_r.r"), "# Databricks notebook source\nx <- 1\n");
    const usage = await detectWidgetUsageInFile(file);
    expect(usage.defaults).not.toContain("from_plain");
    expect(usage.hasUnresolvedRuns).toBe(true);
  });

  test("a path in the wrong case is missing on every disk, with the right spelling offered", async () => {
    const file = path.join(root, "jobs", "main.py");
    await mkdir(path.join(root, "jobs", "lib"), { recursive: true });
    await writeFile(path.join(root, "jobs", "helper.py"), header);
    await writeFile(path.join(root, "jobs", "lib", "util.py"), header);
    expect(checkRunTarget(file, "./Helper")).toEqual({ status: "missing", suggestion: "./helper" });
    expect(checkRunTarget(file, "./helper.PY").status).toBe("missing");
    expect(checkRunTarget(file, "./Lib/util").status).toBe("missing");
    expect(checkRunTarget(file, "../Jobs/helper").status).toBe("missing");
    expect(checkRunTarget(file, "./helper").status).toBe("notebook");
    expect(checkRunTarget(file, "../jobs/lib/../helper").status).toBe("notebook");
    expect(checkRunTarget(file, "./helper/").status).toBe("notebook");
  });
});
