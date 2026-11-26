import { beforeAll, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

/**
 * `{{name}}` used where SQL needs a name (#707), from the sql-parameter-names fixture's
 * recorded `bundle validate` output: one job per case. Databricks fills `{{name}}` in with the
 * value in quotes (`'system'`), so in a name position the run fails, and `USE CATALOG` and
 * `IDENTIFIER(...)`, which take a quoted name, run. Checked with job runs on a serverless SQL
 * warehouse, Databricks CLI v1.28.0; probes in src/test/liveRules/probes.
 */
const ROOT = path.resolve("src/test/fixtures/sql-parameter-names");
let byJob: Map<string, string[]>;

beforeAll(async () => {
  const bundle = JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
  const jobOf = new Map(graph.nodes.map((node) => [node.id, node.parentId]));
  byJob = new Map();
  for (const issue of buildInspectorIssues(graph, bundle, [], ROOT)) {
    if (!issue.kind.startsWith("sql_")) continue;
    const job = String(jobOf.get(issue.taskId ?? "") ?? "").replace(/^resources\.jobs\./, "");
    byJob.set(job, [...(byJob.get(job) ?? []), `${issue.kind} ${issue.line}:${issue.column}`]);
  }
});

const findings = (job: string) => byJob.get(job) ?? [];

describe("{{name}} used as a name (#707)", () => {
  test.each([
    ["from_dotted", ["sql_parameter_as_name 1:15"]],
    ["from_two_parts", ["sql_parameter_as_name 1:15", "sql_parameter_as_name 1:23"]],
    ["backticks", ["sql_parameter_as_name 1:16"]],
    ["use_bare", ["sql_parameter_as_name 2:5"]],
    ["use_schema", ["sql_parameter_as_name 2:12"]],
    ["use_database", ["sql_parameter_as_name 2:14"]],
    ["from_single", ["sql_parameter_as_name 1:15"]],
    ["join_single", ["sql_parameter_as_name 1:57"]],
    ["dot_before", ["sql_parameter_as_name 1:22"]],
    ["from_in_subquery", ["sql_parameter_as_name 1:98"]],
    // As `databricks bundle init default-sql` writes it since CLI v1.13.0: the job deploys and
    // fails with "Catalog ''workspace'' was not found" (2 runs, control without backticks ran).
    ["use_catalog_backticks", ["sql_parameter_as_name 1:14"]],
  ])("%s warns at the parameter", (job, expected) => {
    expect(findings(job)).toEqual(expected);
  });

  test("in backticks and not passed: both fixes are needed", () => {
    expect(findings("backticks_not_passed")).toEqual(["sql_parameter_as_name 1:16", "sql_parameter_not_set 1:16"]);
  });

  test("the title names IDENTIFIER()", async () => {
    const bundle = JSON.parse(readFileSync(path.join(ROOT, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, ROOT));
    const titles = new Set(buildInspectorIssues(graph, bundle, [], ROOT).filter((issue) => issue.kind === "sql_parameter_as_name").map((issue) => issue.title));
    expect(titles).toContain('Wrap "{{cat}}" in IDENTIFIER(): it is used as a name, and Databricks puts the value in quotes, so the run may fail.');
  });

  test.each([
    ["use_catalog", "USE CATALOG {{cat}}, which takes a quoted name"],
    ["identifier", "USE IDENTIFIER({{schema}}) and FROM IDENTIFIER({{cat}} || ...)"],
    ["value_position", "a value: WHERE schema_name = {{schema}}"],
    ["extract_from", "FROM inside a function call: EXTRACT(YEAR FROM {{day}})"],
    ["distinct_from", "IS DISTINCT FROM {{schema}}, a comparison"],
  ])("near miss (sql_parameter_as_name): %s, %s", (job) => {
    expect(findings(job)).toEqual([]);
  });
});
