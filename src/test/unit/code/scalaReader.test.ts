// Scala files are read with the tokenizer, not tree-sitter (#649), for `dbutils` calls
// written as they are in Python and for `%run` lines (docs/checks.md). These tests cover
// that reader for each kind of call, and check it agrees with the tree-sitter reader on
// the same calls in a Python file.
import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectRunTargetsInFile,
  detectSecretInNotebook,
  detectTaskValuesInFile,
  detectWidgetUsageInFile,
} from "../../../bundle/taskFileDetections.js";

const folders: string[] = [];

async function file(name: string, lines: string[]): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "dbi-scala-"));
  folders.push(folder);
  const target = path.join(folder, name);
  await writeFile(target, lines.join("\n"), "utf8");
  return target;
}

afterAll(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

const SCALA = "// Databricks notebook source";

describe("Scala task values", () => {
  test.each([
    ["a literal key", 'dbutils.jobs.taskValues.set("rows", 10)', "rows"],
    ["a named key", 'dbutils.jobs.taskValues.set(key = "rows", value = 10)', "rows"],
    ["a key that isn't a literal", "dbutils.jobs.taskValues.set(name, 10)", null],
    ["a receiver not traced to dbutils", 'helper.jobs.taskValues.set("rows", 10)', null],
  ])("set with %s", async (_case, line, key) => {
    const usage = await detectTaskValuesInFile(await file("set.scala", [SCALA, line]));
    expect(usage.sets).toEqual([{ key, line: 2 }]);
  });

  test.each([
    ["no default", 'val a = dbutils.jobs.taskValues.get("ingest", "rows")', false],
    ["a named default", 'val a = dbutils.jobs.taskValues.get(taskKey = "ingest", key = "rows", default = 0)', true],
    ["a third positional default", 'val a = dbutils.jobs.taskValues.get("ingest", "rows", 5)', true],
    // `default=None` still fails the run in Python (#586).
    ["a None default", 'val a = dbutils.jobs.taskValues.get("ingest", "rows", None)', false],
  ])("get with %s", async (_case, line, hasDefault) => {
    const usage = await detectTaskValuesInFile(await file("get.scala", [SCALA, line]));
    expect(usage.gets).toEqual([{ taskKey: "ingest", key: "rows", hasDefault, line: 2 }]);
  });

  test("a get on a receiver not traced to dbutils is left out", async () => {
    const usage = await detectTaskValuesInFile(await file("other.scala", [SCALA, 'val a = helper.jobs.taskValues.get("ingest", "rows")']));
    expect(usage.gets).toEqual([]);
  });

  test("calls in comments are not read", async () => {
    const usage = await detectTaskValuesInFile(
      await file("comments.scala", [SCALA, '// dbutils.jobs.taskValues.set("line", 1)', '/* dbutils.jobs.taskValues.get("t", "block") */']),
    );
    expect(usage).toEqual({ sets: [], gets: [], runsOtherNotebooks: false });
  });

  test("a %run marks the notebook as running others", async () => {
    const usage = await detectTaskValuesInFile(await file("runs.scala", [SCALA, "// COMMAND ----------", "// MAGIC %run ./helper"]));
    expect(usage.runsOtherNotebooks).toBe(true);
  });
});

describe("Scala secrets", () => {
  test("reads scope and key for each secrets method", async () => {
    const found = await detectSecretInNotebook(
      await file("secrets.scala", [
        SCALA,
        'val a = dbutils.secrets.get("s1", "k1")',
        'val b = dbutils.secrets.get(scope = "s2", key = "k2")',
        'val c = dbutils.secrets.getBytes("s3", "k3")',
        'val d = dbutils.secrets.list("s4")',
        'val e = settings.secrets.get("not", "dbutils")',
        '// val f = dbutils.secrets.get("in", "comment")',
      ]),
    );
    expect(found.map((s) => [s.line, s.scope, s.key])).toEqual([
      [2, "s1", "k1"],
      [3, "s2", "k2"],
      [4, "s3", "k3"],
      [5, "s4", null],
    ]);
  });

  test("a scope taken from a widget names that widget", async () => {
    const found = await detectSecretInNotebook(
      await file("scope-widget.scala", [SCALA, 'val env = dbutils.widgets.get("env")', 'val a = dbutils.secrets.get(env, "k")']),
    );
    expect(found.map((s) => [s.scope, s.key, s.scopeParameter])).toEqual([[null, "k", "env"]]);
  });
});

describe("Scala notebook runs and widgets", () => {
  test("reads %run lines and dbutils.notebook.run", async () => {
    const runs = await detectRunTargetsInFile(
      await file("runs.scala", [
        SCALA,
        'dbutils.notebook.run("./child", 60)',
        "dbutils.notebook.run(childPath, 60)",
        'helper.notebook.run("./not_dbutils", 60)',
        "// COMMAND ----------",
        "// MAGIC %run ./helper",
      ]),
    );
    expect(runs.map((r) => [r.kind, r.target, r.line])).toEqual([
      ["notebook_run", "./child", 2],
      ["notebook_run", null, 3],
      ["run", "./helper", 6],
    ]);
  });

  test("reads widget reads and the defaults the notebook creates", async () => {
    const usage = await detectWidgetUsageInFile(
      await file("widgets.scala", [SCALA, 'dbutils.widgets.text("region", "eu")', 'val r = dbutils.widgets.get("region")', 'val e = dbutils.widgets.get("env")']),
    );
    expect(usage.reads.map((r) => [r.name, r.line])).toEqual([
      ["region", 3],
      ["env", 4],
    ]);
    expect(usage.defaults).toEqual(["region"]);
  });
});

// Calls written the same way in both languages: the two readers must give the same answers.
describe("the Scala reader agrees with the Python reader", () => {
  const calls = [
    'dbutils.jobs.taskValues.set("rows", 10)',
    'dbutils.jobs.taskValues.set(key = "named", value = 1)',
    'a = dbutils.jobs.taskValues.get("ingest", "rows")',
    'b = dbutils.jobs.taskValues.get(taskKey = "ingest", key = "count", default = 0)',
    'c = dbutils.jobs.taskValues.get("ingest", "n", None)',
    'd = dbutils.secrets.get("s1", "k1")',
    'e = dbutils.secrets.list("s2")',
    'dbutils.widgets.text("region", "eu")',
    'f = dbutils.widgets.get("region")',
    'dbutils.notebook.run("./child", 60)',
  ];
  const both = async () => {
    const scala = await file("same.scala", [SCALA, ...calls]);
    const python = await file("same.py", ["# Databricks notebook source", ...calls]);
    return [scala, python] as const;
  };

  test("task values", async () => {
    const [scala, python] = await both();
    expect(await detectTaskValuesInFile(scala)).toEqual(await detectTaskValuesInFile(python));
  });

  test("secrets", async () => {
    const [scala, python] = await both();
    const facts = (found: Awaited<ReturnType<typeof detectSecretInNotebook>>) => found.map((s) => [s.line, s.scope, s.key]);
    expect(facts(await detectSecretInNotebook(scala))).toEqual(facts(await detectSecretInNotebook(python)));
  });

  test("widgets and runs", async () => {
    const [scala, python] = await both();
    const widgets = async (f: string) => {
      const usage = await detectWidgetUsageInFile(f);
      return { reads: usage.reads.map((r) => [r.name, r.line]), defaults: usage.defaults };
    };
    const runs = async (f: string) => (await detectRunTargetsInFile(f)).map((r) => [r.kind, r.target, r.line]);
    expect(await widgets(scala)).toEqual(await widgets(python));
    expect(await runs(scala)).toEqual(await runs(python));
  });
});
