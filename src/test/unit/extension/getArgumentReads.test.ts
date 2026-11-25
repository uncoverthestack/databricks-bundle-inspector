import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

/**
 * getArgument reads, against what Databricks did (serverless notebook tasks, Databricks CLI
 * v1.28.0, 2026-11-25, two runs each): `getArgument("region")` and
 * `dbutils.widgets.getArgument("region")` returned the task's base parameter, and failed with
 * "No input widget named region is defined" when it wasn't passed; with a second argument,
 * `getArgument("region", "dflt")` returned "dflt" in both spellings. A `%python` cell in a SQL
 * notebook read it the same way.
 */
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

async function findings(files: Record<string, string>, baseParameters: Record<string, string>, notebook = "src/nb.py") {
  const root = mkdtempSync(path.join(tmpdir(), "dbi-getargument-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  const config = {
    bundle: { name: "getargument" },
    resources: {
      jobs: { j: { name: "j", tasks: [{ task_key: "a", notebook_task: { notebook_path: `./${notebook}`, base_parameters: baseParameters } }] } },
    },
  } as unknown as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
  return buildInspectorIssues(graph, config, [], root)
    .filter((issue) => issue.kind === "widget_not_set" || issue.kind === "unused_parameter")
    .map((issue) => `${issue.kind} ${issue.title}`);
}

const pythonNotebook = (body: string) => ({ "src/nb.py": `# Databricks notebook source\n${body}\n` });
const NOT_SET = 'widget_not_set Notebook reads widget "region", which this task may not pass.';
const REGION_UNUSED = 'unused_parameter Parameter "region" may not be used: the notebook doesn\'t read a widget with that name.';

describe("getArgument reads, as Databricks runs them", () => {
  test.each([
    ["getArgument, passed", 'v = getArgument("region")', { region: "eu" }, []],
    ["getArgument, not passed: the run fails", 'v = getArgument("region")', { other: "1" }, [NOT_SET]],
    ["getArgument with a default, not passed: returns the default", 'v = getArgument("region", "dflt")', { other: "1" }, []],
    ["dbutils.widgets.getArgument, not passed: the run fails", 'v = dbutils.widgets.getArgument("region")', { other: "1" }, [NOT_SET]],
    ["dbutils.widgets.getArgument with a default, not passed", 'v = dbutils.widgets.getArgument("region", "dflt")', { other: "1" }, []],
    ["dbutils.widgets.get, not passed (control)", 'v = dbutils.widgets.get("region")', { other: "1" }, [NOT_SET]],
  ])("%s", async (_, body, parameters, expected) => {
    const result = (await findings(pythonNotebook(body), parameters)).filter((line) => !line.includes('"other"'));
    expect(result).toEqual(expected);
  });

  test("a %python cell in a SQL notebook reads with getArgument too", async () => {
    const files = { "src/q.sql": '-- Databricks notebook source\n-- MAGIC %python\n-- MAGIC v = getArgument("region")\n' };
    expect(await findings(files, { region: "eu" }, "src/q.sql")).toEqual([]);
  });

  test("a notebook run with %run that calls getArgument with no default needs the widget", async () => {
    const files = {
      "src/nb.py": "# Databricks notebook source\n# MAGIC %run ./child\n",
      "src/child.py": '# Databricks notebook source\nv = getArgument("batch")\nw = getArgument("mode", "full")\n',
    };
    const result = await findings(files, { other: "1" });
    expect(result.filter((line) => line.startsWith("widget_not_set"))).toEqual([
      'widget_not_set Notebook "./child", run with %run, reads widget "batch", which may not be set.',
    ]);
  });
});

describe("what is not a getArgument read", () => {
  test("another object's getArgument", async () => {
    expect(await findings(pythonNotebook('v = helper.getArgument("region")'), { region: "eu" })).toEqual([REGION_UNUSED]);
  });

  test.each([
    ["defines its own getArgument", 'def getArgument(name):\n    return name\nv = getArgument("region")'],
    ["imports its own getArgument", 'from mylib import getArgument\nv = getArgument("region")'],
    ["assigns its own getArgument", 'getArgument = lambda name: name\nv = getArgument("region")'],
  ])("a notebook that %s", async (_, body) => {
    expect(await findings(pythonNotebook(body), { other: "1" })).toEqual([
      'unused_parameter Parameter "other" may not be used: the notebook doesn\'t read a widget with that name.',
    ]);
  });

  test("getArgument in a comment or a string", async () => {
    expect(await findings(pythonNotebook('# getArgument("region")\ns = \'getArgument("region")\''), { region: "eu" })).toEqual([REGION_UNUSED]);
  });

  test("a default given by keyword is not taken as a default: only the positional form was checked", async () => {
    expect(await findings(pythonNotebook('v = getArgument("region", defaultValue="dflt")'), { other: "1" })).toContain(NOT_SET);
  });

  test("a read with a default still counts as reading the parameter", async () => {
    expect(await findings(pythonNotebook('v = getArgument("region", "dflt")'), { region: "eu" })).toEqual([]);
  });
});
