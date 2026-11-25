import { describe, expect, test } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { buildIssueItems } from "../../../webview/lib/issueItems.js";

// The job-settings fixture through the inspector, from the Databricks CLI's own output for
// the structural preview. See the fixture's README for what deploy did with each case
// (CLI v1.28.0, 2026-11-25).
const ROOT = path.resolve("src/test/fixtures/job-settings");
const KINDS = new Set([
  "multiple_job_triggers",
  "invalid_job_parameter_name",
  "invalid_task_key",
  "outcome_without_condition",
  "invalid_outcome",
  "for_each_inputs_not_array",
]);

/** `file: line text` for each finding, so a test reads the line it points at. */
async function findings() {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
  return buildInspectorIssues(graph, bundle, [], ROOT)
    .filter((issue) => KINDS.has(issue.kind))
    .map((issue) => {
      // Forward slashes on every OS, so the expected paths read the same on Windows.
      const file = path.relative(ROOT, issue.file ?? "").split(path.sep).join("/");
      const text = readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/)[issue.line! - 1]!.trim();
      return { kind: issue.kind, severity: issue.severity, task: issue.taskName, at: `${file}: ${text}`, title: issue.title };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.title.localeCompare(b.title));
}

describe("job-settings fixture", () => {
  test("the structural preview reports each broken case at its line, and no working case", async () => {
    const at = (line: string) => `resources/jobs.yml: ${line}`;
    const loop = (inputs: string) => at(`for_each_task: { inputs: ${inputs}, task: { task_key: i, notebook_task: { notebook_path: ../src/nb.py } } }`);
    const inputs = (task: string, problem: string) => ({
      kind: "for_each_inputs_not_array",
      task,
      title: `Make the inputs of task "${task}" a JSON array, like ["a", "b"]: it ${problem}, so deploy may fail.`,
    });
    const rows = (await findings()).map(({ severity, ...rest }) => {
      expect(severity).toBe("error");
      return rest;
    });
    expect(rows).toEqual([
      {
        at: at("- name: bad name"),
        kind: "invalid_job_parameter_name",
        task: undefined,
        title: 'Rename job parameter "bad name": names can only use letters, digits, "-", "_" and ".", so deploy may fail.',
      },
      {
        at: at('- task_key: "load "'),
        kind: "invalid_task_key",
        task: "load ",
        title: 'Rename task "load ": task keys can only use letters, digits, "-" and "_", so deploy may fail.',
      },
      {
        at: at('depends_on: [{ task_key: check, outcome: "True" }]'),
        kind: "invalid_outcome",
        task: "capital",
        title: 'Change outcome "True" to "true" or "false": deploy may fail with any other value.',
      },
      {
        at: at('depends_on: [{ task_key: plain, outcome: "true" }]'),
        kind: "outcome_without_condition",
        task: "after_plain",
        title: 'Remove outcome "true" from the dependency on "plain": only an if/else condition task has an outcome, so deploy may fail.',
      },
      { at: loop(`'["a", {"k": "v"}]'`), ...inputs("mixed", "mixes objects with plain values") },
      { at: loop(`'{"a": 1}'`), ...inputs("an_object", "is not a JSON array") },
      { at: loop('"[[1, 2]]"'), ...inputs("nested", "has a list inside the list") },
      { at: loop('"[null, 1]"'), ...inputs("has_null", "has null in the list") },
      { at: loop('"not json"'), ...inputs("not_json", "is not valid JSON") },
      {
        at: at("task_key: in ner"),
        kind: "invalid_task_key",
        task: "loop",
        title: 'Rename task "in ner": task keys can only use letters, digits, "-" and "_", so deploy may fail.',
      },
      {
        at: at("trigger:"),
        kind: "multiple_job_triggers",
        task: undefined,
        title: 'Keep only one of schedule and trigger on job "two_triggers": a job can have one, so deploy may fail.',
      },
    ]);
  });
});

describe("a task key from a variable, in the structural preview", () => {
  // The preview prints `task_key: ${var.key}` as written, and the graph names the task by it.
  const TEXT = `bundle: { name: b }
variables:
  key: { default: "bad key" }
resources:
  jobs:
    j:
      name: j
      tasks:
        - task_key: \${var.key}
          notebook_task: { notebook_path: ./nb.py }
`;
  async function inspect() {
    const root = mkdtempSync(path.join(os.tmpdir(), "dbi-task-key-"));
    try {
      writeFileSync(path.join(root, "databricks.yml"), TEXT);
      writeFileSync(path.join(root, "nb.py"), "# Databricks notebook source\nprint(1)\n");
      const bundle = parse(TEXT) as ParsedBundleConfig;
      const graph = await extractBundleGraph(bundle, root);
      return { bundle, graph, issues: buildInspectorIssues(graph, bundle, [], root) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("an invalid default stays on the task's box and in its job's list", async () => {
    const { bundle, graph, issues } = await inspect();
    const invalid = issues.filter((issue) => issue.kind === "invalid_task_key");
    expect(invalid.map((issue) => issue.title)).toEqual([
      'Rename task "bad key": task keys can only use letters, digits, "-" and "_", so deploy may fail.',
    ]);
    expect(graph.nodes.some((node) => node.id === invalid[0]!.taskId)).toBe(true);
    const job = graph.nodes.find((node) => node.nodeType === "job")!;
    const items = buildIssueItems(graph as never, job, bundle, null, [], issues);
    expect(items.some((item) => item.id === invalid[0]!.id)).toBe(true);
  });

  test("a BUNDLE_VAR_ environment variable wins over the default, so the default is not judged", async () => {
    const before = process.env.BUNDLE_VAR_key;
    process.env.BUNDLE_VAR_key = "valid_key";
    try {
      const { issues } = await inspect();
      expect(issues.filter((issue) => issue.kind === "invalid_task_key")).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.BUNDLE_VAR_key;
      else process.env.BUNDLE_VAR_key = before;
    }
  });
});
