import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { readPipelineSql } from "../../../bundle/pipelineSql.js";
import { buildPipelineDataFlow, dataFlowColumns } from "../../../bundle/pipelineDataFlow.js";

// #607, CLI v1.28.0, controlled workspace runs on 2026-11-25: short flow names
// fail, qualified names work, including a materialized view's implicit flow.
// These tests stay offline; the same SQL shape is recorded in the issue.
const SQL = "CREATE STREAMING TABLE t;\nCREATE FLOW seed AS INSERT ONCE INTO t BY NAME SELECT 1 AS id;\nCREATE MATERIALIZED VIEW m AS SELECT 1 AS id;\n";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function selection(name: string, options: { field?: string; pipeline?: Record<string, unknown>; sql?: string; inner?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "flow-names-"));
  roots.push(root);
  mkdirSync(path.join(root, "sql"));
  writeFileSync(path.join(root, "sql/pipeline.sql"), options.sql ?? SQL);
  const task = { task_key: "refresh", pipeline_task: { pipeline_id: "${resources.pipelines.p.id}", [options.field ?? "refresh_flow_selection"]: [name] } };
  const config = {
    bundle: { name: "flow_names" },
    resources: {
      pipelines: { p: { catalog: "main", schema: "sales", libraries: [{ file: { path: "./sql/pipeline.sql" } }], ...options.pipeline } },
      jobs: { j: { tasks: [options.inner ? { task_key: "loop", for_each_task: { inputs: "[1]", task } } : task] } },
    },
  } as ParsedBundleConfig;
  writeFileSync(path.join(root, "databricks.yml"), stringify(config));
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
  return buildInspectorIssues(graph, config, [], root).filter((issue) => issue.kind === "pipeline_selection_not_found");
}

describe("flow selection names (#607)", () => {
  test.each(["m", "seed", "sales.seed"])("%s needs its full flow name", async (name) => {
    const issues = await selection(name);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toContain(`Did you mean "main.sales.${name.split(".").at(-1)}"?`);
  });

  test.each(["main.sales.m", "main.sales.seed"])("%s is accepted without a wrong rename suggestion", async (name) => {
    expect(await selection(name)).toEqual([]);
  });

  test("an unknown full flow still gets a warning", async () => {
    expect(await selection("main.sales.nope")).toHaveLength(1);
  });

  test.each(["refresh_selection", "full_refresh_selection"])("%s still accepts a short table name", async (field) => {
    expect(await selection("m", { field })).toEqual([]);
  });

  test("the old target field supplies the schema too", async () => {
    expect(await selection("main.sales.seed", { pipeline: { schema: undefined, target: "sales" } })).toEqual([]);
  });

  test("a short name is invalid even when the namespace is not known, without inventing its prefix", async () => {
    const issues = await selection("m", { pipeline: { schema: "${var.schema}" } });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toContain("full catalog.schema.flow name");
    expect(issues[0]!.title).not.toContain("Did you mean");
    expect(await selection("main.sales.m", { pipeline: { schema: "${var.schema}" } })).toEqual([]);
  });

  test("an incomplete source cannot justify a missing-flow finding", async () => {
    expect(await selection("main.sales.nope", { sql: "CREATE MATERIALIZED VIEW m AS SELECT * FROM IDENTIFIER('other');" })).toEqual([]);
  });

  test("after USE, a full flow name is not compared with a guessed namespace", async () => {
    expect(await selection("main.archive.seed", { sql: `USE SCHEMA archive;\n${SQL}` })).toEqual([]);
  });

  test("the inner task has the same flow-name rule and a YAML location", async () => {
    const issues = await selection("seed", { inner: true });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.taskName).toBe("loop");
    expect(issues[0]!.file).toMatch(/databricks\.yml$/);
    expect(issues[0]!.line).toBeGreaterThan(1);
  });
});

describe("pipeline reads retained by the data flow (#607)", () => {
  test("a constant flow has an identity without an invented source edge", () => {
    const result = readPipelineSql(SQL);
    const flow = buildPipelineDataFlow([{ file: "pipeline.sql", result }], []);
    expect(flow).toHaveProperty("flows", [{ name: "seed" }]);
    expect(flow.edges).toEqual([]);
  });

  test("a self-read is preserved and its layout finishes", () => {
    const result = readPipelineSql("CREATE MATERIALIZED VIEW t AS SELECT * FROM t;");
    const flow = buildPipelineDataFlow([{ file: "self.sql", result }], []);
    expect(flow.edges).toHaveLength(1);
    expect(flow.edges[0]!.from).toBe(flow.edges[0]!.to);
    expect(dataFlowColumns(flow).flat().map((node) => node.name)).toEqual(["t"]);
  });

  test("LATERAL reads the relation or records the unsupported function", () => {
    const result = readPipelineSql("CREATE MATERIALIZED VIEW t AS SELECT * FROM LATERAL read_files('/Volumes/c/s/v/data');");
    expect(result.reads.map((read) => read.source)).toEqual(["files:/Volumes/c/s/v/data"]);
    expect(result.unread).toEqual([]);
    expect(readPipelineSql("CREATE MATERIALIZED VIEW t AS SELECT * FROM LATERAL custom_reader();").unread).toHaveLength(1);
  });

  test("a recursive CTE is local inside its recursive term, but its real source remains", () => {
    const result = readPipelineSql("CREATE MATERIALIZED VIEW t AS WITH RECURSIVE r(n) AS (SELECT n FROM source UNION ALL SELECT n+1 FROM r WHERE n<3) SELECT * FROM r;");
    expect(result.reads.map((read) => read.source)).toEqual(["source"]);
  });

  test("ordinary CTEs still read an outside table with their own name", () => {
    const result = readPipelineSql("CREATE MATERIALIZED VIEW t AS WITH r AS (SELECT * FROM r) SELECT * FROM r;");
    expect(result.reads.map((read) => read.source)).toEqual(["r"]);
  });
});
