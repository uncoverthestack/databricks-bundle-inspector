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

const bundleRoot = path.resolve(__dirname, "../../fixtures/widget-parameters");

const RESOURCE_FILES = ["resources/widget_parameters.job.yml", "resources/git_sourced.job.yml"];

// Without a target, `databricks bundle validate -o json` returns these values unchanged
// (checked on CLI v1.17.0), so the fixture YAML stands in for the CLI output.
function fixtureConfig(): ParsedBundleConfig {
  const jobs: Record<string, unknown> = {};
  for (const file of RESOURCE_FILES) {
    const parsed = parse(readFileSync(path.join(bundleRoot, file), "utf8")) as {
      resources: { jobs: Record<string, unknown> };
    };
    Object.assign(jobs, parsed.resources.jobs);
  }
  return {
    bundle: { name: "widget_parameters" },
    include: RESOURCE_FILES,
    resources: { jobs },
  } as ParsedBundleConfig;
}

describe("widget and parameter mismatches", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    const config = fixtureConfig();
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
    issues = buildInspectorIssues(graph, config, [], bundleRoot).filter(
      (issue) => issue.kind === "widget_parameter_mismatch",
    );
  });

  function summary(issue: InspectorIssue): string {
    return `${issue.severity} ${issue.taskName}: ${issue.title} @ ${path.relative(bundleRoot, issue.file ?? "")}:${issue.line}`;
  }

  // See the fixture README for why each case is or isn't reported.
  test("reports widgets no one passes, task parameters the notebook never reads, and what it couldn't check", () => {
    expect(issues.map(summary).sort()).toEqual([
      'info dynamic_reads: Not checked whether the notebook uses "a", "c": it reads widgets by names only known at runtime. @ src/dynamic_reads.py:undefined',
      'info python_notebook: Parameter "unused_flag" may not be used: the notebook doesn\'t read a widget with that name. @ resources/widget_parameters.job.yml:14',
      'info widgets_object: Not checked whether the notebook uses "warehouse_id": it reads widgets by names only known at runtime. @ src/widgets_object.py:undefined',
      'warning for_each_item: Notebook reads widget "missing_inner", which this task may not pass. @ src/item_notebook.py:3',
      'warning python_notebook: Notebook reads widget "run_date", which this task may not pass. @ src/py_notebook.py:9',
      'warning python_notebook: Notebook reads widget "schema", which this task may not pass. Did you mean "schema_name"? @ src/py_notebook.py:7',
      'warning sql_notebook: Notebook reads widget "region", which this task may not pass. @ src/sql_notebook.sql:10',
    ]);
  });

  test("does not report the parameter already offered as a suggestion", () => {
    expect(issues.some((issue) => issue.title.startsWith('Parameter "schema_name"'))).toBe(false);
  });
});
