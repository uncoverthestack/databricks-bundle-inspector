import { describe, test, expect, beforeAll } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, issueHighlight, type InspectorIssue } from "../../../bundle/issues.js";
import { detectSqlTextParametersInFile } from "../../../bundle/taskFileDetections.js";

// Expected answers come from the live run recorded in the fixture README (issue 484,
// 2026-11-24, CLI v1.27.0): each warning names a case that failed or gave a wrong result.
const bundleRoot = path.resolve(__dirname, "../../fixtures/sql-text-parameters");
const RESOURCE_FILES = ["resources/sql_text.yml"];

// Without a target, `databricks bundle validate -o json` returns these values unchanged,
// so the fixture YAML stands in for the CLI output.
function fixtureConfig(): ParsedBundleConfig {
  const parsed = parse(readFileSync(path.join(bundleRoot, RESOURCE_FILES[0]!), "utf8")) as {
    resources: { jobs: Record<string, unknown> };
  };
  return {
    bundle: { name: "sql_text_parameters" },
    include: RESOURCE_FILES,
    resources: { jobs: parsed.resources.jobs },
  } as ParsedBundleConfig;
}

describe("SQL file {{name}} text parameters (issue 484)", () => {
  let issues: InspectorIssue[];

  beforeAll(async () => {
    const config = fixtureConfig();
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
    issues = buildInspectorIssues(graph, config, [], bundleRoot).filter(
      (issue) => issue.kind === "sql_parameter_not_set" || issue.kind === "sql_parameter_quoted",
    );
  });

  function summary(issue: InspectorIssue): string {
    const file = path.relative(bundleRoot, issue.file ?? "").split(path.sep).join("/");
    return `${issue.kind} ${issue.taskName}: ${issue.title} @ ${file}:${issue.line}:${issue.column}-${issue.endColumn}`;
  }

  test("warns on exactly the cases that failed or gave a wrong result live", () => {
    expect(issues.map(summary).sort()).toEqual([
      'sql_parameter_not_set near_name: Pass "run_date" to this task: without it, the query may succeed with wrong results. Did you mean "run_dt"? @ src/u_string.sql:2:21-33',
      'sql_parameter_not_set u_string: Pass "run_date" to this task: without it, the query may succeed with wrong results. @ src/u_string.sql:2:21-33',
      'sql_parameter_not_set u_table: Pass "table_name" to this task: without it, the run may fail. @ src/u_table.sql:2:15-29',
      'sql_parameter_not_set u_twice: Pass "run_date" to this task: without it, the query may succeed with wrong results. @ src/u_twice.sql:2:9-21',
      'sql_parameter_not_set u_value: Pass "run_date" to this task: without it, the run may fail. @ src/u_value.sql:2:8-20',
      'sql_parameter_not_set u_where: Pass "run_date" to this task: without it, the query may succeed with wrong results. @ src/u_where.sql:2:65-77',
      'sql_parameter_quoted p_double: Remove the quotes around "{{run_date}}": Databricks already adds quotes, so the run may fail. @ src/p_double.sql:2:8-22',
      'sql_parameter_quoted p_string: Remove the quotes around "{{run_date}}": Databricks already adds quotes, so the run may fail. @ src/p_string.sql:2:8-22',
    ]);
  });

  test("the highlight covers the placeholder, and its quotes when they are the problem", () => {
    // What the editor highlights, through the same helper the Problems panel uses.
    const text = (issue: InspectorIssue | undefined) => {
      const line = readFileSync(issue!.file!, "utf8").split("\n")[issue!.line! - 1]!;
      const { start, end } = issueHighlight(issue!);
      return line.slice(start, end);
    };
    expect(text(issues.find((i) => i.taskName === "p_string"))).toBe("'{{run_date}}'");
    expect(text(issues.find((i) => i.taskName === "u_where"))).toBe("{{run_date}}");
    expect(text(issues.find((i) => i.taskName === "u_table"))).toBe("{{table_name}}");
  });

  test("other warnings still highlight to the end of the line", () => {
    expect(issueHighlight({ column: 3 })).toEqual({ start: 2, end: Number.MAX_SAFE_INTEGER });
    expect(issueHighlight({})).toEqual({ start: 0, end: Number.MAX_SAFE_INTEGER });
  });

  test("says how to fix it", () => {
    expect(issues.find((i) => i.taskName === "u_string")?.fixHint).toBe(
      'Pass "run_date" in the task\'s sql_task.parameters or the job\'s parameters.',
    );
    expect(issues.find((i) => i.taskName === "p_string")?.fixHint).toBe("Write {{run_date}} without quotes.");
  });
});

describe("detectSqlTextParametersInFile", () => {
  const detect = async (sql: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "sql-text-"));
    try {
      const file = path.join(dir, "q.sql");
      writeFileSync(file, sql);
      return (await detectSqlTextParametersInFile(file)).map((use) => `${use.name}@${use.line}:${use.column}${use.inString ? " string" : ""}${use.wholeString ? " whole" : ""}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test.each([
    ["SELECT {{a}}", ["a@1:8"]],
    ["SELECT '{{a}}'", ["a@1:9 string whole"]],
    ['SELECT "{{a}}"', ["a@1:9 string whole"]],
    ["SELECT 'x {{a}} {{b}}'", ["a@1:11 string", "b@1:17 string"]],
    ["-- {{a}}\nSELECT 1", []],
    ["/* {{a}} */ SELECT 1", []],
    ["SELECT { {a} }", []],
    ["SELECT {{ a }}", []],
    ["SELECT {{a.b}}", []],
    ["SELECT '{{ a }}'", []],
    ["SELECT r'{{a}}'", ["a@1:10 string"]],
    ["SELECT 1\r\nFROM {{t}}", ["t@2:6"]],
  ])("%j", async (sql, expected) => {
    expect(await detect(sql)).toEqual(expected);
  });
});
