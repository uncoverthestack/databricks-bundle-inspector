import { describe, test, expect, afterAll } from "@jest/globals";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tokenizePython } from "../../../bundle/code/pythonTokenizer.js";
import { tokenizeSql } from "../../../bundle/code/sqlTokenizer.js";
import { notebookViews } from "../../../bundle/code/notebookViews.js";
import {
  detectSecretInNotebook,
  detectWidgetsInFile,
  detectWidgetUsageInFile,
} from "../../../bundle/taskFileDetections.js";

const created: string[] = [];

async function file(name: string, content: string): Promise<string> {
  const filePath = path.join(tmpdir(), `bdi-tokens-${process.pid}-${name}`);
  await writeFile(filePath, content, "utf8");
  created.push(filePath);
  return filePath;
}

afterAll(async () => {
  await Promise.all(created.map((f) => unlink(f).catch(() => undefined)));
});

const names = (tokens: Array<{ kind: string; value: string }>) =>
  tokens.filter((t) => t.kind === "name" || t.kind === "word").map((t) => t.value);

describe("tokenizePython", () => {
  test("keeps triple-quoted strings, comments and plain strings out of the code", () => {
    const tokens = tokenizePython(
      ['doc = """', 'dbutils.widgets.get("in_docstring")', '"""', "x = 'dbutils'  # dbutils"].join("\n"),
    );
    expect(names(tokens)).toEqual(["doc", "x"]);
  });

  test("emits the code inside f-string expressions, including nested quotes", () => {
    const tokens = tokenizePython(`v = f"{dbutils.widgets.get("a")} and {{literal}}"`);
    expect(names(tokens)).toEqual(["v", "dbutils", "widgets", "get"]);
  });

  test("ends an unterminated string at the line break", () => {
    expect(names(tokenizePython('a = "open\nb = 1'))).toEqual(["a", "b"]);
  });
});

describe("tokenizeSql", () => {
  test("skips nested block comments, line comments and strings with doubled quotes", () => {
    const tokens = tokenizeSql("/* a /* nested */ :x */ SELECT 'it''s :y' -- :z\nFROM t");
    expect(names(tokens)).toEqual(["SELECT", "FROM", "t"]);
  });

  test("reads $$ bodies and raw strings as strings, and :: as one operator", () => {
    const tokens = tokenizeSql("AS $$ return ':x' $$; SELECT r'\\d:' , ts::string");
    expect(tokens.filter((t) => t.kind === "string").map((t) => t.value)).toEqual([
      " return ':x' ",
      "\\d:",
    ]);
    expect(tokens.some((t) => t.kind === "op" && t.value === "::")).toBe(true);
  });
});

describe("notebookViews", () => {
  test("gives each language only its own cells, at the same offsets", () => {
    const content = [
      "# Databricks notebook source",
      "x = 1",
      "# COMMAND ----------",
      "# MAGIC %sql",
      "# MAGIC SELECT :catalog",
    ].join("\n");
    const views = notebookViews(content, { jupyter: false, fileLanguage: "python" });
    expect(views.python.length).toBe(content.length);
    expect(views.sql.length).toBe(content.length);
    expect(views.sql.trim()).toBe("SELECT :catalog");
    expect(views.python.trim()).toBe("x = 1");
  });
});

// Shapes found by comparing the old and new scanners on Databricks' bundle-examples
// and delta-live-tables-notebooks repositories.
describe("detections on real-world shapes", () => {
  test("a JSON path with a space before the colon is not a parameter", async () => {
    const f = await file(
      "json-path.sql",
      "SELECT Double(details :cluster_utilization.num_executors), details:flow_progress.metrics FROM t WHERE d = :run_date",
    );
    expect((await detectWidgetsInFile(f)).map((w) => w.name)).toEqual(["run_date"]);
  });

  test("finds legacy ${name} inside a backtick identifier", async () => {
    const f = await file("backtick.sql", "SELECT * FROM delta.`${storage_location}/system/events`");
    expect((await detectWidgetsInFile(f)).map((w) => [w.name, w.method])).toEqual([
      ["storage_location", "sqlLegacyReference"],
    ]);
  });

  test("reads %sql cells of a Python notebook as SQL", async () => {
    const f = await file(
      "py-notebook-sql-cells.py",
      [
        "# Databricks notebook source",
        'catalog = dbutils.widgets.get("catalog")',
        "# COMMAND ----------",
        "# MAGIC %sql",
        "# MAGIC CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog || '.' || :database);",
      ].join("\n"),
    );
    expect((await detectWidgetsInFile(f)).map((w) => [w.line, w.name, w.method])).toEqual([
      [2, "catalog", "get"],
      [5, "catalog", "sqlParameterMarker"],
      [5, "database", "sqlParameterMarker"],
    ]);
  });

  test("reads %python cells of a SQL notebook as Python", async () => {
    const f = await file(
      "sql-notebook-python-cells.sql",
      [
        "-- Databricks notebook source",
        "-- MAGIC %python",
        "-- MAGIC dbutils.widgets.text('storage_location', '/home/PipelineStorage')",
        "-- MAGIC display(dbutils.fs.ls(dbutils.widgets.get('storage_location')))",
        "",
        "-- COMMAND ----------",
        "",
        "SELECT * FROM t WHERE p = '${latest_update_id}'",
      ].join("\n"),
    );
    const usage = await detectWidgetUsageInFile(f);
    expect(usage.reads).toEqual([
      { name: "storage_location", line: 4, language: "python" },
      { name: "latest_update_id", line: 8, language: "sql" },
    ]);
    expect(usage.defaults).toEqual(["storage_location"]);
  });

  test("ignores widget and secret calls in docstrings and markdown cells", async () => {
    const py = await file(
      "docstring.py",
      ['"""', 'Usage: dbutils.widgets.get("in_docstring")', 'dbutils.secrets.get("s", "k")', '"""', 'x = dbutils.widgets.get("real")'].join("\n"),
    );
    expect((await detectWidgetsInFile(py)).map((w) => w.name)).toEqual(["real"]);
    expect(await detectSecretInNotebook(py)).toEqual([]);

    const ipynb = await file(
      "markdown.ipynb",
      JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ['Call dbutils.widgets.get("from_markdown")'] },
          { cell_type: "code", source: ['x = dbutils.widgets.get("from_code")'] },
          { cell_type: "code", source: ["%sql\n", "SELECT :from_sql_cell"] },
        ],
        metadata: {},
      }),
    );
    expect((await detectWidgetsInFile(ipynb)).map((w) => [w.line, w.name])).toEqual([
      [2, "from_code"],
      [4, "from_sql_cell"],
    ]);
  });

  test("keeps scope and key null when they come from variables", async () => {
    const f = await file(
      "secret-vars.py",
      'a = dbutils.secrets.get(scope=scope_name, key="example-key")\nb = dbutils.secrets.get(\n  "oetrta",\n  "brokers",\n)',
    );
    expect((await detectSecretInNotebook(f)).map((s) => [s.line, s.scope, s.key])).toEqual([
      [1, null, "example-key"],
      [2, "oetrta", "brokers"],
    ]);
  });
});

describe("dbutils under other names", () => {
  test("follows aliases of dbutils and of its modules", async () => {
    const f = await file(
      "aliases.py",
      [
        "from pyspark.dbutils import DBUtils",
        "dbu = DBUtils(spark)",
        'env = dbu.widgets.get("env")',
        "helper = get_dbutils(spark)",
        'region = helper.widgets.get("region")',
        "w = dbutils.widgets",
        'w.text("run_date", "2026-01-01")',
        'run_date = w.get("run_date")',
        "d2 = dbu",
        'table = d2.widgets.get("table")',
      ].join("\n"),
    );
    expect(await detectWidgetUsageInFile(f)).toEqual({
      reads: [
        { name: "env", line: 3, language: "python" },
        { name: "region", line: 5, language: "python" },
        { name: "run_date", line: 8, language: "python" },
        { name: "table", line: 10, language: "python" },
      ],
      defaults: ["run_date"],
      defaultLanguages: { run_date: ["python"] },
      // `w = dbutils.widgets` is followed, not treated as passing the widgets on.
      hasDynamicReads: false,
      hasUnresolvedRuns: false,
      runReadNames: [],
      unsetRunReads: [],
    });
  });

  test("still treats a widgets alias passed to other code as dynamic", async () => {
    const f = await file("alias-passed.py", "w = dbutils.widgets\nconfig = load(w)");
    expect((await detectWidgetUsageInFile(f)).hasDynamicReads).toBe(true);
  });

  // https://databricks-sdk-py.readthedocs.io/en/latest/dbutils.html, SDK 0.143.0
  test("finds secrets read through the Databricks SDK", async () => {
    const f = await file(
      "sdk.py",
      [
        "from databricks.sdk import WorkspaceClient",
        "from databricks.sdk.runtime import dbutils as rt_dbutils",
        "w = WorkspaceClient()",
        "dbutils = w.dbutils",
        'a = dbutils.secrets.get("scope-a", "key-a")',
        'b = w.dbutils.secrets.get(scope="scope-b", key="key-b")',
        'c = WorkspaceClient().dbutils.secrets.get("scope-c", "key-c")',
        'd = w.secrets.get_secret(scope="scope-d", key="key-d")',
        'e = WorkspaceClient(profile="DEFAULT").secrets.get_secret("scope-e", "key-e")',
        'f = rt_dbutils.secrets.get("scope-f", "key-f")',
        "broken = WorkspaceClient(",
      ].join("\n"),
    );
    expect((await detectSecretInNotebook(f)).map((s) => [s.line, s.scope, s.key])).toEqual([
      [5, "scope-a", "key-a"],
      [6, "scope-b", "key-b"],
      [7, "scope-c", "key-c"],
      [8, "scope-d", "key-d"],
      [9, "scope-e", "key-e"],
      [10, "scope-f", "key-f"],
    ]);
  });
});

describe("dbutils in any form", () => {
  test("finds widget reads whatever the receiver is called", async () => {
    const f = await file(
      "any-receiver.py",
      [
        "from databricks.sdk.runtime import (dbutils, spark)",
        "def main(dbu):",
        '    return dbu.widgets.get("from_param")',
        "class Job:",
        "    def run(self):",
        '        self.dbutils.widgets.get("from_attribute")',
        '        get_dbutils(spark).widgets.get("from_helper")',
        '        ctx["dbu"].widgets.get("from_index")',
      ].join("\n"),
    );
    const usage = await detectWidgetUsageInFile(f);
    expect(usage.reads.map((r) => r.name)).toEqual([
      "from_param",
      "from_attribute",
      "from_helper",
      "from_index",
    ]);
    // A name in an import list is not dbutils being handed to other code.
    expect(usage.hasDynamicReads).toBe(false);
  });

  test("treats dbutils handed to other code as reads it can't see", async () => {
    const f = await file("handed-on.py", "run_pipeline(spark, dbutils)");
    expect((await detectWidgetUsageInFile(f)).hasDynamicReads).toBe(true);
  });

  test("needs a scope and a key before an unknown receiver's secrets.get counts", async () => {
    const f = await file(
      "secrets-shape.py",
      ['cfg.secrets.get("password")', 'self.dbutils.secrets.get(scope="s", key="k")'].join("\n"),
    );
    expect((await detectSecretInNotebook(f)).map((s) => [s.line, s.scope, s.key])).toEqual([[2, "s", "k"]]);
  });

  test("follows classes imported under another name", async () => {
    const f = await file(
      "import-as.py",
      [
        "from pyspark.dbutils import DBUtils as DBU",
        "from databricks.sdk import WorkspaceClient as WC",
        "x = DBU(spark)",
        'a = x.secrets.get("s1", "k1")',
        "c = WC()",
        'b = c.secrets.get_secret("s2", "k2")',
      ].join("\n"),
    );
    expect((await detectSecretInNotebook(f)).map((s) => [s.line, s.scope, s.key])).toEqual([
      [4, "s1", "k1"],
      [6, "s2", "k2"],
    ]);
  });
});

// https://docs.databricks.com/aws/en/notebooks/notebook-limitations
describe("SQL getArgument", () => {
  test("reads a widget with the deprecated getArgument() in SQL", async () => {
    const f = await file("get-argument.sql", "SELECT * FROM t WHERE d = getArgument('run_day') AND x = 'getArgument(\"no\")'");
    expect((await detectWidgetsInFile(f)).map((w) => [w.name, w.method])).toEqual([["run_day", "sqlGetArgument"]]);
  });
});

