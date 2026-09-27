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
      (issue) => issue.kind === "task_value_mismatch",
    );
  });

  // See the fixture README for why each read is or isn't reported.
  test("reports reads of values that are missing, misnamed or not upstream", () => {
    expect(
      issues
        .map((issue) => `${issue.taskName}: ${issue.title} @ ${path.relative(bundleRoot, issue.file ?? "")}:${issue.line}`)
        .sort(),
    ).toEqual([
      'consumer: Task "producer" may not set value "rowcount". Did you mean "row_count"? @ src/consumer.py:3',
      'not_upstream: Task "producer" isn\'t upstream of this task, so its value "run_id" may not be set yet. @ src/not_upstream.py:2',
      'wrong_task: Task value "row_count" is read from task "prodcer", which may not exist. Did you mean "producer"? @ src/wrong_task.py:2',
      'yaml_refs: Task "producer" may not set value "missing". @ resources/task_values.job.yml:36',
    ]);
  });

  test("are warnings", () => {
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
  });
});
