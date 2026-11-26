import { describe, test, expect, beforeAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  extractBundleGraph,
  type ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";

const bundleRoot = path.resolve(__dirname, "../../fixtures/task-values");

// Relative path with "/" on every OS, so expectations read the same on Windows.
function posixRelative(file: string): string {
  return path.relative(bundleRoot, file).split(path.sep).join("/");
}
const JOB_FILE = "resources/task_values.job.yml";

// Without a target, `databricks bundle validate -o json` returns these values unchanged
// (checked on CLI v1.17.0), so the fixture YAML stands in for the CLI output.
function fixtureConfig(): ParsedBundleConfig {
  const parsed = parse(readFileSync(path.join(bundleRoot, JOB_FILE), "utf8")) as {
    resources: ParsedBundleConfig["resources"];
  };
  return {
    bundle: { name: "task_values" },
    include: [JOB_FILE],
    resources: parsed.resources,
  } as ParsedBundleConfig;
}

describe("task values", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    const config = fixtureConfig();
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
    issues = buildInspectorIssues(graph, config, [], bundleRoot).filter(
      (issue) => issue.kind.startsWith("task_value_"),
    );
  });

  test("each read gets the code that names its fix", () => {
    expect(issues.map((issue) => `${issue.taskName}: ${issue.kind}`).sort()).toEqual([
      "consumer: task_value_key_not_set",
      "defaults: task_value_key_not_set",
      "defaults: task_value_key_not_set",
      "defaults: task_value_key_not_set",
      "not_upstream: task_value_not_upstream",
      "wrong_task: task_value_unknown_task",
      "yaml_refs: task_value_key_not_set",
    ]);
  });

  // See the fixture README for why each read is or isn't reported.
  test("reports reads of values that are missing, misnamed or not upstream", () => {
    expect(
      issues
        .map((issue) => `${issue.taskName}: ${issue.title} @ ${posixRelative(issue.file ?? "")}:${issue.line}`)
        .sort(),
    ).toEqual([
      'consumer: Task "producer" may not set value "rowcount". Did you mean "row_count"? @ src/consumer.py:3',
      'defaults: Task "producer" may not set value "debug_only". @ src/defaults.py:5',
      'defaults: Task "producer" may not set value "none_default". @ src/defaults.py:4',
      'defaults: Task "producer" may not set value "read_twice". @ src/defaults.py:7',
      'not_upstream: Add "producer" to this task\'s depends_on: reading its value "run_id" doesn\'t make this task wait, so the value may not be set yet. @ src/not_upstream.py:2',
      'wrong_task: Task value "row_count" is read from task "prodcer", which may not exist. Did you mean "producer"? @ src/wrong_task.py:2',
      'yaml_refs: Task "producer" may not set value "missing". @ resources/task_values.job.yml:43',
    ]);
  });

  test("are warnings", () => {
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });
});
