import { describe, expect, test } from "@jest/globals";
import { readPipelineSql } from "../../../bundle/pipelineSql.js";
import { buildPipelineDataFlow, dataFlowColumns } from "../../../bundle/pipelineDataFlow.js";
import { findEnvironmentProblems } from "../../../bundle/jobStructure.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { bundleReviewReport } from "../../../bundle/bundleReviewReport.js";
import { REVIEW_REPORT_MAX_CHARACTERS } from "../../../bundle/reviewReport.js";
import { buildBundleOverview } from "../../../bundle/bundleOverview.js";

/** Generated inputs for the features added after v0.7.0. Keep the dependencies explicit
 * in the generator so the expected graph is independent of the SQL reader. */
describe("changes since 0.7.0: stress", () => {
  test("500 quoted CTEs and datasets preserve exactly the generated dependencies", () => {
    const statements: string[] = [];
    const expected: string[] = [];
    for (let i = 0; i < 500; i++) {
      const source = `raw.orders_${i}`;
      const name = `view_${i}`;
      const alias = ["`SELECT`", "`stage`", "`with.dot`", "`with``tick`"][i % 4]!;
      statements.push(`CREATE MATERIALIZED VIEW ${name} AS WITH ${alias}(id) AS (SELECT id FROM ${source}) SELECT * FROM ${alias};`);
      expected.push(`${source}->${name}`);
    }
    const parsed = readPipelineSql(statements.join("\n"));
    expect(parsed.datasets).toHaveLength(500);
    expect(parsed.unread).toEqual([]);
    expect(parsed.reads.map(read => `${read.source}->${read.target}`)).toEqual(expected);
    const flow = buildPipelineDataFlow([{ file: "generated.sql", result: parsed }], []);
    expect(flow.nodes).toHaveLength(1000);
    expect(flow.edges).toHaveLength(500);
    expect(dataFlowColumns(flow).map(column => column.length)).toEqual([500, 500]);
  });

  test("unfinished SQL at every truncation point terminates without invalid graph edges", () => {
    const sql = "USE CATALOG main; USE SCHEMA sales; CREATE MATERIALIZED VIEW `a``b` AS WITH `stage` AS (SELECT * FROM STREAM(raw.orders)) SELECT * FROM `stage` JOIN read_files(concat('/Volumes/in/', '${folder}')) ON true; /* nested /* comment */ */";
    for (let end = 0; end <= sql.length; end++) {
      const parsed = readPipelineSql(sql.slice(0, end), { folder: "orders" });
      const flow = buildPipelineDataFlow([{ file: "incomplete.sql", result: parsed }], []);
      const ids = new Set(flow.nodes.map(node => node.id));
      for (const edge of flow.edges) {
        expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true);
      }
      expect(dataFlowColumns(flow).flat()).toHaveLength(flow.nodes.length);
    }
  });

  test("10,000 nested parentheses and block comments do not exhaust the stack", () => {
    const depth = 10_000;
    const parsed = readPipelineSql(`/*${"/*".repeat(depth)} ignored ${"*/".repeat(depth)}*/ CREATE MATERIALIZED VIEW m AS SELECT * FROM ${"(".repeat(depth)}SELECT * FROM orders${")".repeat(depth)}`);
    expect(parsed.reads.map(read => read.source)).toEqual(["orders"]);
  });

  test("1,000 cross-file datasets keep the same links when files are reversed", () => {
    const files = Array.from({ length: 1000 }, (_, i) => ({
      file: `${i}.sql`, result: readPipelineSql(`CREATE MATERIALIZED VIEW t${i} AS SELECT * FROM ${i ? `t${i - 1}` : "raw.orders"}`),
    }));
    const edges = (input: typeof files) => buildPipelineDataFlow(input, []).edges.map(edge => `${edge.from}->${edge.to}`).sort();
    expect(edges(files)).toEqual(edges([...files].reverse()));
    expect(dataFlowColumns(buildPipelineDataFlow(files, []))).toHaveLength(1001);
  });

  test("1,000 job environments distinguish known, missing and unresolved keys", () => {
    const jobs = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`j${i}`, {
      environments: [{ environment_key: "env", spec: { environment_version: "5" } }],
      tasks: [
        { task_key: "known", environment_key: "env" },
        { task_key: "missing", environment_key: "absent" },
        { task_key: "unknown", environment_key: "${var.environment}" },
      ],
    }]));
    const findings = findEnvironmentProblems(jobs, []);
    expect(findings).toHaveLength(1000);
    expect(findings.every(finding => finding.kind === "unknown_environment_key" && finding.taskKey === "missing")).toBe(true);
  });

  test("500 resources retain schema links and compute settings while copied reports stay bounded and redact outside values", async () => {
    const count = 100;
    const parsed = {
      bundle: { name: "stress", target: "dev" },
      variables: { private: { default: "default", value: "OUTSIDE-PRIVATE-OVERRIDE" } },
      resources: {
        jobs: Object.fromEntries(Array.from({ length: count }, (_, i) => [`j${i}`, { name: `job-${i}-OUTSIDE-PRIVATE-OVERRIDE`, tasks: [] }])),
        pipelines: Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { name: `pipeline-${i}`, schema: `\${resources.schemas.s${i}.name}`, libraries: [] }])),
        schemas: Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, { name: `schema-${i}`, catalog_name: "main" }])),
        clusters: Object.fromEntries(Array.from({ length: count }, (_, i) => [`c${i}`, { cluster_name: `cluster-${i}`, num_workers: 0, spark_version: "15.4.x-scala2.12" }])),
        sql_warehouses: Object.fromEntries(Array.from({ length: count }, (_, i) => [`w${i}`, { name: `warehouse-${i}`, auto_stop_mins: 0, enable_serverless_compute: true }])),
      },
    } as unknown as ParsedBundleConfig;
    const graph = await extractBundleGraph(parsed);
    const overview = buildBundleOverview(graph);
    expect(overview.links.filter(link => link.from.startsWith("resources.pipelines.") && link.to.startsWith("resources.schemas."))).toHaveLength(count);
    const compute = overview.groups.flatMap(group => group.items).filter(item => item.settings);
    expect(compute).toHaveLength(count * 2);
    const markdown = bundleReviewReport(parsed, graph, [], {
      bundleRoot: "/repo", structuralPreview: false, targetName: "dev", targetLabel: "dev",
      outsideVariables: [{ name: "private", source: "environment" }],
      extensionVersion: "test", checkedAt: new Date("2026-11-15T00:00:00Z"),
    });
    expect(markdown.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
    expect(markdown).not.toContain("OUTSIDE-PRIVATE-OVERRIDE");
    expect(markdown).toContain("500 resources");
    expect(markdown).toContain("### Not checked");
  });
});
