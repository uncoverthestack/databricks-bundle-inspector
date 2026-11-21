import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { emptyRecord, hasOwnKey, own } from "../../../bundle/ownKeys.js";
import { readPipelineSql } from "../../../bundle/pipelineSql.js";
import { isVariableResolvedForTarget, resolveVariableForTarget } from "../../../bundle/targetResolution.js";
import { findVariableSources } from "../../../bundle/variableSources.js";
import { variableSourceLocation } from "../../../webview/lib/variableSource.js";

// Names every JavaScript object already has. A widget, variable, target or setting with one of
// them crashed the checks, which cleared every problem in the bundle, or was treated as defined.
const BUILT_IN = ["constructor", "toString", "hasOwnProperty", "valueOf"] as const;

describe("own keys", () => {
  test("a plain object's built-in names are not its own values", () => {
    const record: Record<string, number> = { a: 1 };
    for (const name of BUILT_IN) {
      expect(own(record, name)).toBeUndefined();
      expect(hasOwnKey(record, name)).toBe(false);
    }
    expect(own(record, "a")).toBe(1);
    expect(own(undefined, "a")).toBeUndefined();
  });

  test("an empty record stores __proto__ like any other name", () => {
    const record = emptyRecord<string>();
    record["__proto__"] = "x";
    expect(own(record, "__proto__")).toBe("x");
    expect(Object.keys(record)).toEqual(["__proto__"]);
  });
});

describe.each(BUILT_IN)("a bundle using the name %s", (name) => {
  let dir: string;
  let issues: ReturnType<typeof buildInspectorIssues>;
  const bundleYaml = `bundle:
  name: built-in-names
variables:
  ${name}:
    default: v
targets:
  ${name}:
    variables:
      ${name}: t
resources:
  jobs:
    job:
      name: j
      tasks:
        - task_key: reads
          notebook_task:
            notebook_path: ./reads.py
        - task_key: defines
          notebook_task:
            notebook_path: ./defines.py
        - task_key: runs
          notebook_task:
            notebook_path: ./runs.py
        - task_key: broken
          depends_on: [{ task_key: nope }]
          notebook_task:
            notebook_path: ./defines.py
`;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dbi-built-in-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "databricks.yml"), bundleYaml);
    writeFileSync(path.join(dir, "reads.py"), `# Databricks notebook source\ndbutils.widgets.get("${name}")\n`);
    writeFileSync(
      path.join(dir, "defines.py"),
      `# Databricks notebook source\ndbutils.widgets.text("${name}", "x")\ndbutils.widgets.get("${name}")\ndbutils.widgets.get("really_missing")\n`,
    );
    writeFileSync(path.join(dir, "runs.py"), `# Databricks notebook source\n# MAGIC %run ./child\n`);
    writeFileSync(path.join(dir, "child.py"), `# Databricks notebook source\ndbutils.widgets.get("${name}")\n`);
    const bundle = parse(bundleYaml) as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, dir));
    issues = buildInspectorIssues(graph, bundle, [], dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const titles = (task: string) => issues.filter((issue) => issue.taskName === task).map((issue) => issue.title);

  test("reading it as a widget is a missing widget, and the bundle's other problems stay", () => {
    expect(titles("reads")).toEqual([`Notebook reads widget "${name}", which this task may not pass.`]);
    expect(issues.some((issue) => issue.kind === "unknown_task_dependency")).toBe(true);
  });

  test("a notebook that creates it is still checked", () => {
    expect(titles("defines")).toEqual(['Notebook reads widget "really_missing", which this task may not pass.']);
  });

  test("a %run notebook that reads it, with no value on the %run line, is reported", () => {
    expect(titles("runs").some((title) => title.includes(`reads widget "${name}"`))).toBe(true);
  });

  test("its variable's lines are found, for the target named after it too", () => {
    const sources = findVariableSources([{ file: path.join(dir, "databricks.yml"), text: bundleYaml }]);
    expect(own(sources, name)?.definition?.line).toBe(5);
    expect(own(own(sources, name)?.targets, name)?.line).toBe(9);
    expect(variableSourceLocation(sources, name, name)?.line).toBe(9);
    expect(variableSourceLocation(sources, "other", name)).toBeUndefined();
  });

  test("a variable with the name is resolved, and one without it is not defined", () => {
    const bundle = parse(bundleYaml) as ParsedBundleConfig;
    expect(resolveVariableForTarget(bundle, name, name)).toMatchObject({ status: "resolved", value: "t", source: "target_override" });
    expect(resolveVariableForTarget(bundle, name, null)).toMatchObject({ status: "resolved", value: "v" });
    const without = { bundle: { name: "b" }, variables: { real: { default: "r" } } } as unknown as ParsedBundleConfig;
    expect(isVariableResolvedForTarget(without, name, null)).toBe(false);
    expect(isVariableResolvedForTarget(without, `real.${name}`, null)).toBe(false);
  });

  test("a pipeline SQL name filled by a configuration key the pipeline doesn't set is not read", () => {
    const result = readPipelineSql(`CREATE MATERIALIZED VIEW \${${name}}.t AS SELECT 1;`, { other: "main" });
    expect(result.datasets).toEqual([]);
    expect(result.unread).toHaveLength(1);
  });
});
