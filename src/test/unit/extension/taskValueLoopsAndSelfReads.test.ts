import { beforeAll, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

/**
 * Task values of a for-each loop, and a task reading its own values (#601), from the
 * task-value-loops fixture's recorded `bundle validate` output: one job per case. What
 * Databricks did, Databricks CLI v1.28.0, serverless, probes in src/test/liveRules/probes:
 * after a for-each task "loop" whose inner task "inner" sets "result",
 * `get(taskKey="loop", key="result")` fails the run with `No task values with key "result"`,
 * and `get(taskKey="inner", key="result")` works (the documented form,
 * https://docs.databricks.com/aws/en/jobs/tasks/for-each). A task reading its own key that
 * it never sets fails the same way.
 */
const ROOT = path.resolve("src/test/fixtures/task-value-loops");
let byJob: Map<string, string[]>;

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
  const jobOf = new Map(graph.nodes.map((node) => [node.id, node.parentId]));
  byJob = new Map();
  for (const issue of buildInspectorIssues(graph, bundle, [], ROOT)) {
    if (!issue.kind.startsWith("task_value_")) continue;
    const job = String(jobOf.get(issue.taskId ?? "") ?? "").replace(/^resources\.jobs\./, "");
    byJob.set(job, [...(byJob.get(job) ?? []), `${issue.kind} ${issue.title}`]);
  }
});

const findings = (job: string) => byJob.get(job) ?? [];
const LOOP_KEY = 'task_value_key_not_set Task value "result" is read from for-each task "loop", which may not set values. Did you mean its inner task "inner"?';

describe("for-each task values (#601)", () => {
  test("a read by the loop's key warns and names the inner task", () => {
    expect(findings("loop_key")).toEqual([LOOP_KEY]);
  });

  test("near miss (task_value_unknown_task): a read by the inner task's key after the loop", () => {
    expect(findings("inner_key")).toEqual([]);
  });

  test("near miss (task_value_key_not_set): a read by the loop's key with a default", () => {
    expect(findings("loop_key_default")).toEqual([]);
  });

  test("a read by the inner task's key of a key the inner task doesn't set", () => {
    expect(findings("inner_key_typo")).toEqual(['task_value_key_not_set Task "inner" may not set value "resutl". Did you mean "result"?']);
  });

  test("a read by the inner task's key without depends_on on the loop names the loop", () => {
    expect(findings("inner_key_no_depends")).toEqual([
      'task_value_not_upstream Add "loop" to this task\'s depends_on: reading values of its inner task "inner" doesn\'t make this task wait, so they may not be set yet.',
    ]);
  });

  test("{{tasks.<key>.values.<name>}} in the YAML follows the same rule", () => {
    expect(findings("yaml_inner_key")).toEqual([]);
    expect(findings("yaml_loop_key")).toEqual([LOOP_KEY]);
  });
});

describe("a task reading its own task values (#601)", () => {
  test("a key it never sets warns", () => {
    expect(findings("self_never_set")).toEqual(['task_value_key_not_set This task reads its own value "never_set", which it may not set.']);
  });

  test("near miss (task_value_key_not_set): a key it sets itself", () => {
    expect(findings("self_sets")).toEqual([]);
  });

  test("near miss (task_value_key_not_set): a key it never sets, read with a default", () => {
    expect(findings("self_default")).toEqual([]);
  });

  test("near miss (task_value_key_not_set): a %run notebook may set it", () => {
    expect(findings("self_runs_other")).toEqual([]);
  });
});
