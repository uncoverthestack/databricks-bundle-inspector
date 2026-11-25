import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

/** A task value read written in the YAML is reported where it is written, not at its task. */
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

async function taskValueFindings(jobYaml: string, withoutLocatedReads = false) {
  const root = mkdtempSync(path.join(tmpdir(), "dbi-tv-lines-"));
  roots.push(root);
  mkdirSync(path.join(root, "resources"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "nb.py"), "# Databricks notebook source\nx = 1\n");
  writeFileSync(path.join(root, "databricks.yml"), "bundle:\n  name: tv\ninclude:\n  - resources/*.yml\n");
  writeFileSync(path.join(root, "resources", "job.yml"), jobYaml);
  const config = {
    bundle: { name: "tv" },
    include: ["resources/job.yml"],
    resources: (parse(jobYaml) as { resources: ParsedBundleConfig["resources"] }).resources,
  } as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
  if (withoutLocatedReads) for (const node of graph.nodes) if (node.taskData) delete node.taskData.taskValueReferences;
  return buildInspectorIssues(graph, config, [], root)
    .filter((issue) => issue.kind.startsWith("task_value"))
    .map((issue) => `${issue.kind} ${path.basename(issue.file ?? "")}:${issue.line ?? "-"}:${issue.column ?? "-"}`);
}

const job = (task: string) => `resources:
  jobs:
    j:
      name: j
      tasks:
        - task_key: a
          notebook_task:
            notebook_path: ../src/nb.py
${task}`;

describe("task value reads written in YAML: where they are reported", () => {
  test("a base parameter's read is reported at its own line and column", async () => {
    const yaml = job(`        - task_key: b
          depends_on: [{task_key: a}]
          notebook_task:
            notebook_path: ../src/nb.py
            base_parameters:
              first: plain
              n: "{{tasks.zzz.values.x}}"
`);
    // Line 15 is `n: "{{tasks.zzz.values.x}}"`, its value at column 18.
    expect(yaml.split("\n")[14]).toContain("{{tasks.zzz.values.x}}");
    expect(await taskValueFindings(yaml)).toEqual(["task_value_unknown_task job.yml:15:18"]);
  });

  test("a read in a list and one in a for-each loop's inner task", async () => {
    const yaml = job(`        - task_key: b
          spark_python_task:
            python_file: ../src/nb.py
            parameters: ["--n", "{{tasks.zzz.values.x}}"]
        - task_key: loop
          for_each_task:
            inputs: "[1]"
            task:
              task_key: inner
              notebook_task:
                notebook_path: ../src/nb.py
                base_parameters:
                  n: "{{tasks.yyy.values.x}}"
`);
    const lines = yaml.split("\n");
    const lineOf = (text: string) => lines.findIndex((line) => line.includes(text)) + 1;
    const result = await taskValueFindings(yaml);
    expect(result.map((r) => r.split(":")[1])).toEqual([String(lineOf("tasks.zzz")), String(lineOf("tasks.yyy"))]);
  });

  test("task data from before this list existed falls back to the task's own line", async () => {
    const yaml = job(`        - task_key: b
          notebook_task:
            notebook_path: ../src/nb.py
            base_parameters:
              n: "{{tasks.zzz.values.x}}"
`);
    // Line 9 is `- task_key: b`.
    expect(yaml.split("\n")[8]).toContain("task_key: b");
    expect(await taskValueFindings(yaml, true)).toEqual(["task_value_unknown_task job.yml:9:-"]);
  });
});
