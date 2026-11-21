import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { decodeEscapes, tokenizePython } from "../../../bundle/code/pythonTokenizer.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { detectSecretInNotebook, detectWidgetUsageInFile } from "../../../bundle/taskFileDetections.js";

// Each expected value is what Python 3 reads for the literal (checked with ast.literal_eval,
// and on 23,707 generated literals during development).
describe("a Python string as Python reads it", () => {
  test.each([
    [`"reg\\u0069on"`, "region"],
    [`"reg\\x69on"`, "region"],
    [`"reg\\151on"`, "region"],
    [`"\\U0001F600"`, "😀"],
    [`"a\\\\b"`, "a\\b"],
    [`"it\\'s"`, "it's"],
    [`"tab\\there"`, "tab\there"],
    [`"keep\\q"`, "keep\\q"],
    [`"\\8"`, "\\8"],
    [`"one\\\ntwo"`, "onetwo"],
    [`r"reg\\u0069on"`, "reg\\u0069on"],
    [`b"\\u0069"`, "\\u0069"],
    [`b"\\777"`, "ÿ"],
    [`"""a\r\nb"""`, "a\nb"],
    [`"plain"`, "plain"],
  ])("%s is %j", (source, expected) => {
    const [token, ...rest] = tokenizePython(source);
    expect(rest).toEqual([]);
    expect(token).toMatchObject({ kind: "string", decoded: expected });
  });

  test("a name from the Unicode table, a short or bad escape, can't be read", () => {
    expect(tokenizePython(`"\\N{BULLET}"`)[0]?.decoded).toBeNull();
    expect(decodeEscapes("\\x4", false)).toBeNull();
    expect(decodeEscapes("\\u12", false)).toBeNull();
    expect(decodeEscapes("\\U00110000", false)).toBeNull();
  });

  test("an f-string has no decoded value", () => {
    expect(tokenizePython(`f"{x}\\u0069"`)[0]).not.toHaveProperty("decoded");
  });

  test("a line continuation in a string, in a file with Windows line ends, keeps the string whole", () => {
    const tokens = tokenizePython(`x = "one\\\r\ntwo"\r\ny = 1`);
    expect(tokens.map((token) => token.kind)).toEqual(["name", "op", "string", "name", "op", "number"]);
    expect(tokens[2]?.decoded).toBe("onetwo");
  });

  test("the raw text stays as written, for finding names inside it", () => {
    expect(tokenizePython(`"reg\\u0069on"`)[0]?.value).toBe("reg\\u0069on");
  });
});

describe("widget and secret names with escapes (reported against `reg\\u0069on`)", () => {
  let dir: string;
  let issues: ReturnType<typeof buildInspectorIssues>;
  const yaml = `bundle:
  name: escapes
resources:
  jobs:
    job:
      name: j
      tasks:
        - task_key: reads
          notebook_task:
            notebook_path: ./reads.py
            base_parameters:
              region: eu
`;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dbi-escapes-"));
    writeFileSync(path.join(dir, "databricks.yml"), yaml);
    writeFileSync(path.join(dir, "reads.py"), `# Databricks notebook source\nregion = dbutils.widgets.get("reg\\u0069on")\n`);
    const bundle = parse(yaml) as ParsedBundleConfig;
    issues = buildInspectorIssues(await enrichGraphWithFileContent(await extractBundleGraph(bundle, dir)), bundle, [], dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a widget read with an escape is the parameter the task passes: no missing widget, no unused parameter", () => {
    expect(issues.filter((issue) => issue.kind === "widget_not_set" || issue.kind === "unused_parameter")).toEqual([]);
  });

  test("a raw string keeps its backslash, as Python does", async () => {
    const file = path.join(dir, "raw.py");
    writeFileSync(file, `# Databricks notebook source\ndbutils.widgets.get(r"reg\\u0069on")\n`);
    expect((await detectWidgetUsageInFile(file)).reads.map((read) => read.name)).toEqual(["reg\\u0069on"]);
  });

  test("a name the inspector can't decode is read as unknown, not as the text", async () => {
    const file = path.join(dir, "named.py");
    writeFileSync(file, `# Databricks notebook source\ndbutils.widgets.get("\\N{BULLET}")\n`);
    const usage = await detectWidgetUsageInFile(file);
    expect(usage.reads).toEqual([]);
    expect(usage.hasDynamicReads).toBe(true);
  });

  test("a secret scope written with an escape is the scope Python reads", async () => {
    const file = path.join(dir, "secret.py");
    writeFileSync(file, `# Databricks notebook source\ndbutils.secrets.get(scope="app\\x2dsecrets", key="token")\n`);
    expect((await detectSecretInNotebook(file)).map((found) => found.scope)).toEqual(["app-secrets"]);
  });
});
