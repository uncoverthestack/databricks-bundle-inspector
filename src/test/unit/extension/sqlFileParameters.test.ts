import { describe, test, expect, beforeAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";

const bundleRoot = path.resolve(__dirname, "../../fixtures/sql-file-parameters");
const RESOURCE_FILES = ["resources/sql_files.yml"];

// Without a target, `databricks bundle validate -o json` returns these values unchanged,
// so the fixture YAML stands in for the CLI output (validate says "Validation OK!", v1.25.0).
function fixtureConfig(): ParsedBundleConfig {
  const parsed = parse(readFileSync(path.join(bundleRoot, RESOURCE_FILES[0]!), "utf8")) as {
    resources: { jobs: Record<string, unknown> };
  };
  return {
    bundle: { name: "sql_file_parameters" },
    include: RESOURCE_FILES,
    resources: { jobs: parsed.resources.jobs },
  } as ParsedBundleConfig;
}

describe("SQL file task parameters (issue 234)", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    const config = fixtureConfig();
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
    issues = buildInspectorIssues(graph, config, [], bundleRoot);
  });

  function summary(issue: InspectorIssue): string {
    const file = path.relative(bundleRoot, issue.file ?? "").split(path.sep).join("/");
    return `${issue.severity} ${issue.taskName}: ${issue.title} @ ${file}:${issue.line}`;
  }

  // See the fixture README for why each case is or isn't reported.
  test("reports each :name the task and the job don't pass, once per file and task", () => {
    expect(issues.filter((issue) => issue.kind === "sql_parameter_not_set").map(summary).sort()).toEqual([
      'warning each_day: SQL file reads parameter ":catalog", which this task may not pass. @ src/day_and_catalog.sql:2',
      'warning near_name: SQL file reads parameter ":schema", which this task may not pass. Did you mean "schema_name"? @ src/uses_schema.sql:2',
      'warning not_passed: SQL file reads parameter ":catalog", which this task may not pass. @ src/uses_catalog.sql:2',
      'warning other_case: SQL file reads parameter ":Catalog", which this task may not pass. Did you mean "catalog"? @ src/upper_case.sql:1',
    ]);
  });

  test("says how to fix it", () => {
    const issue = issues.find((i) => i.kind === "sql_parameter_not_set" && i.taskName === "not_passed");
    expect(issue?.fixHint).toBe('Pass "catalog" in the task\'s sql_task.parameters or the job\'s parameters.');
  });

  test("a SQL file task's parameters are not called unused and are not notebook widgets", () => {
    expect(issues.filter((issue) => issue.kind === "unused_parameter" || issue.kind === "widget_not_set")).toEqual([]);
  });
});
