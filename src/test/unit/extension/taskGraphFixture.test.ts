import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// The task-graph fixture through the inspector, from the Databricks CLI's own output for
// the structural preview and for the dev target, where the CLI sorts the tasks and
// merges duplicates. See the fixture's README for what deploy does with each job.
const ROOT = path.resolve("src/test/fixtures/task-graph");
const KINDS = new Set(["unknown_task_dependency", "task_dependency_loop", "duplicate_task_key", "duplicate_job_parameter"]);

/** `file: line text` for each finding, so a test reads the line it points at. */
async function findings(capture: string, target?: string) {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, capture), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
  return buildInspectorIssues(graph, bundle, [], ROOT, target)
    .filter((issue) => KINDS.has(issue.kind))
    .map((issue) => {
      const file = path.relative(ROOT, issue.file ?? "");
      const text = readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/)[issue.line! - 1]!.trim();
      return { kind: issue.kind, severity: issue.severity, task: issue.taskName, at: `${file}: ${text}`, title: issue.title };
    })
    .sort((a, b) => `${a.at}${a.task}`.localeCompare(`${b.at}${b.task}`));
}

const EXPECTED = [
  { kind: "duplicate_task_key", severity: "warning", task: "twice", at: "databricks.yml: - task_key: twice" },
  { kind: "task_dependency_loop", severity: "error", task: "c", at: "resources/mistakes.yml: - task_key: b" },
  { kind: "task_dependency_loop", severity: "error", task: "x", at: "resources/mistakes.yml: - task_key: y" },
  { kind: "task_dependency_loop", severity: "error", task: "a", at: "resources/mistakes.yml: - task_key: c" },
  { kind: "task_dependency_loop", severity: "error", task: "y", at: "resources/mistakes.yml: - task_key: x" },
  { kind: "task_dependency_loop", severity: "error", task: "b", at: "resources/mistakes.yml: - task_key: a" },
  { kind: "task_dependency_loop", severity: "error", task: "alone", at: "resources/mistakes.yml: - task_key: alone" },
  { kind: "unknown_task_dependency", severity: "error", task: "report", at: "resources/mistakes.yml: - task_key: laod" },
  { kind: "unknown_task_dependency", severity: "error", task: "wait", at: "resources/mistakes.yml: - task_key: only_in_first_job" },
  { kind: "duplicate_job_parameter", severity: "warning", task: undefined, at: "resources/mistakes.yml: - name: env" },
  { kind: "duplicate_task_key", severity: "warning", task: "same", at: "resources/mistakes.yml: - task_key: same" },
];
const sorted = (rows: typeof EXPECTED) => [...rows].sort((a, b) => `${a.at}${a.task}`.localeCompare(`${b.at}${b.task}`));

describe("task-graph fixture", () => {
  test("the structural preview reports each mistake at the line that makes it, and nothing else", async () => {
    const preview = await findings("validated-bundle.json");
    expect(preview.map(({ title: _title, ...rest }) => rest)).toEqual(sorted(EXPECTED));
  });

  test("the dev target, where the CLI sorted the tasks and merged duplicates, reports the same", async () => {
    expect(await findings("validated-bundle.dev.json", "dev")).toEqual(await findings("validated-bundle.json"));
  });

  test("the wording names the suggestion, the other job and every task in a loop", async () => {
    const titles = (await findings("validated-bundle.json")).map((f) => f.title);
    expect(titles).toContain('Task "report" depends on "laod", but job "unknown_dependency" has no task with that key. Did you mean "load"?');
    expect(titles).toContain('Task "wait" depends on "only_in_first_job", which is a task of job "first_job", not of job "other_job_dependency".');
    expect(titles).toContain('Tasks "a", "b" and "c" depend on each other in a loop, so none of them can start.');
    expect(titles).toContain('Task "alone" depends on itself, so it can never start.');
  });
});
