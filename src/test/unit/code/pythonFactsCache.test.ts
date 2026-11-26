import { afterAll, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The real parser, counted: the checks below must share one parse per file (#716).
jest.mock("../../../bundle/code/pythonParser.js", () => {
  const actual = jest.requireActual<typeof import("../../../bundle/code/pythonParser.js")>("../../../bundle/code/pythonParser.js");
  return { ...actual, withPythonTree: jest.fn(actual.withPythonTree) };
});

import { withPythonTree } from "../../../bundle/code/pythonParser.js";
import { pythonFacts } from "../../../bundle/code/pythonFacts.js";
import {
  detectRunTargetsInFile,
  detectSecretInNotebook,
  detectTaskValuesInFile,
  detectWidgetsInFile,
  detectWidgetUsageInFile,
} from "../../../bundle/taskFileDetections.js";

const parse = withPythonTree as jest.MockedFunction<typeof withPythonTree>;
const folders: string[] = [];

afterAll(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("each Python file is parsed once for all its checks (#716)", () => {
  test("five reads of the same text at once share one parse", async () => {
    const text = 'x = dbutils.widgets.get("shared_once")\n';
    const results = await Promise.all(Array.from({ length: 5 }, () => pythonFacts(text)));
    expect(parse).toHaveBeenCalledTimes(1);
    for (const facts of results) expect(facts).toBe(results[0]);
  });

  test("the checks a task file gets, started together as enrichGraph starts them, parse it once", async () => {
    // A slow parse, as for a large notebook or a busy machine: every check asks while the
    // first parse still runs. With one small file and a fast parse they rarely overlap.
    const actual = jest.requireActual<typeof import("../../../bundle/code/pythonParser.js")>("../../../bundle/code/pythonParser.js");
    parse.mockImplementation(async (text, read) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return actual.withPythonTree(text, read);
    });
    const folder = await mkdtemp(path.join(tmpdir(), "dbi-parse-once-"));
    folders.push(folder);
    const file = path.join(folder, "nb.py");
    await writeFile(
      file,
      [
        "# Databricks notebook source",
        'region = dbutils.widgets.get("region_once")',
        'dbutils.widgets.text("other_once", "")',
        'key = dbutils.secrets.get(scope="scope_once", key="k")',
        'dbutils.jobs.taskValues.set(key="count_once", value=1)',
        'dbutils.notebook.run("./child_once", 60)',
        "",
      ].join("\n"),
      "utf8",
    );
    const [secrets, widgets, usage, taskValues, runs] = await Promise.all([
      detectSecretInNotebook(file),
      detectWidgetsInFile(file),
      detectWidgetUsageInFile(file),
      detectTaskValuesInFile(file),
      detectRunTargetsInFile(file),
    ]);
    expect(parse).toHaveBeenCalledTimes(1);
    // Each check still found its part of the file.
    expect(secrets.map((s) => s.scope)).toEqual(["scope_once"]);
    expect(widgets.map((w) => w.name)).toEqual(["region_once"]);
    expect(JSON.stringify(usage)).toContain("region_once");
    expect(JSON.stringify(taskValues)).toContain("count_once");
    expect(JSON.stringify(runs)).toContain("child_once");
  });

  test("different texts are parsed separately", async () => {
    await Promise.all([pythonFacts("a_separate = 1\n"), pythonFacts("b_separate = 2\n")]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  test("a parse that fails isn't kept: the next read tries again", async () => {
    const text = 'y = dbutils.widgets.get("retried")\n';
    parse.mockRejectedValueOnce(new Error("parser not loaded"));
    await expect(pythonFacts(text)).rejects.toThrow("parser not loaded");
    const facts = await pythonFacts(text);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(facts)).toContain("retried");
  });

  test("blank text needs no parse", async () => {
    await pythonFacts("   \n");
    expect(parse).not.toHaveBeenCalled();
  });
});
