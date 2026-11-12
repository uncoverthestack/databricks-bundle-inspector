import { describe, expect, test } from "@jest/globals";
import { buildPipelineDataFlow, dataFlowColumns } from "../../../bundle/pipelineDataFlow.js";
import { readPipelineSql } from "../../../bundle/pipelineSql.js";

const flowOf = (files: Record<string, string>, defaults?: { catalog?: string; schema?: string }, notRead: { file: string; reason: string }[] = []) =>
  buildPipelineDataFlow(Object.entries(files).map(([file, sql]) => ({ file, result: readPipelineSql(sql) })), notRead, defaults);
const edgeNames = (flow: ReturnType<typeof flowOf>) => {
  const name = new Map(flow.nodes.map((node) => [node.id, node.name]));
  return flow.edges.map((edge) => `${name.get(edge.from)} -> ${name.get(edge.to)}`);
};

describe("pipeline data flow: joining a pipeline's SQL files", () => {
  test("Databricks' lakeflow_pipelines_sql example: a read in one file names a table made in another", () => {
    const flow = flowOf({
      "sample_trips.sql": "CREATE MATERIALIZED VIEW sample_trips AS SELECT pickup_zip, fare_amount FROM samples.nyctaxi.trips",
      "sample_zones.sql": "CREATE MATERIALIZED VIEW sample_zones AS SELECT pickup_zip, SUM(fare_amount) FROM sample_trips GROUP BY pickup_zip",
    });
    expect(edgeNames(flow)).toEqual(["samples.nyctaxi.trips -> sample_trips", "sample_trips -> sample_zones"]);
    expect(flow.nodes.map((node) => `${node.kind} ${node.name}`)).toEqual([
      "materialized_view sample_trips", "materialized_view sample_zones", "outside samples.nyctaxi.trips",
    ]);
    expect(dataFlowColumns(flow).map((column) => column.map((node) => node.name))).toEqual([
      ["samples.nyctaxi.trips"], ["sample_trips"], ["sample_zones"],
    ]);
  });

  test("a full name is the pipeline's own table only when its catalog and schema match the defaults", () => {
    const sql = { "a.sql": "CREATE MATERIALIZED VIEW orders AS SELECT 1; CREATE MATERIALIZED VIEW report AS SELECT * FROM main.sales.orders" };
    expect(edgeNames(flowOf(sql, { catalog: "main", schema: "sales" }))).toEqual(["orders -> report"]);
    expect(edgeNames(flowOf(sql, { catalog: "main", schema: "other" }))).toEqual(["main.sales.orders -> report"]);
  });

  test("with defaults from unresolved variables, a full name stays outside and says it may be the same", () => {
    const flow = flowOf(
      { "a.sql": "CREATE MATERIALIZED VIEW orders AS SELECT 1; CREATE MATERIALIZED VIEW report AS SELECT * FROM main.sales.orders" },
      { catalog: "${var.catalog}", schema: "${var.schema}" },
    );
    expect(flow.nodes.find((node) => node.name === "main.sales.orders")).toEqual(expect.objectContaining({ kind: "outside", maybeSameAs: "orders" }));
  });

  test("a table only a flow writes is still drawn, as written by a flow", () => {
    const flow = flowOf({ "a.sql": "CREATE FLOW f AS INSERT INTO landing BY NAME SELECT * FROM STREAM(raw.events)" });
    expect(flow.nodes.find((node) => node.name === "landing")?.kind).toBe("flow_target");
    expect(edgeNames(flow)).toEqual(["raw.events -> landing"]);
  });

  test("a flow target created in another file takes that file's kind", () => {
    const flow = flowOf({
      "flows.sql": "CREATE FLOW f AS INSERT INTO landing BY NAME SELECT * FROM STREAM(raw.events)",
      "tables.sql": "CREATE OR REFRESH STREAMING TABLE landing",
    });
    expect(flow.nodes.find((node) => node.name === "landing")).toEqual(expect.objectContaining({ kind: "streaming_table", file: "tables.sql" }));
  });

  test("a table created twice is drawn once and says where the second one is", () => {
    const flow = flowOf({ "a.sql": "CREATE MATERIALIZED VIEW t AS SELECT 1", "b.sql": "\nCREATE MATERIALIZED VIEW t AS SELECT 2" });
    expect(flow.nodes).toHaveLength(1);
    expect(flow.nodes[0]!.definedAgain).toEqual({ file: "b.sql", line: 2 });
  });

  test("files and outside tables sit in the first column; a loop does not grow forever", () => {
    const flow = flowOf({ "a.sql": "CREATE STREAMING TABLE raw AS SELECT * FROM STREAM read_files('/Volumes/in'); CREATE MATERIALIZED VIEW a AS SELECT * FROM b; CREATE MATERIALIZED VIEW b AS SELECT * FROM a" });
    const columns = dataFlowColumns(flow).map((column) => column.map((node) => node.name).sort());
    expect(columns[0]).toEqual(["/Volumes/in"]);
    expect(columns.flat().sort()).toEqual(["/Volumes/in", "a", "b", "raw"]);
  });

  test("an outside source sits just before the table it feeds, so its line never runs behind a box", () => {
    // The e2e fixture's shape: orders_silver is in column 2; the archive table feeds only it.
    const flow = flowOf({
      "bronze.sql": "CREATE STREAMING TABLE orders_bronze AS SELECT * FROM STREAM read_files('/Volumes/in')",
      "silver.sql": "CREATE STREAMING TABLE orders_silver AS SELECT * FROM STREAM(orders_bronze)",
      "backfill.sql": "CREATE FLOW f AS INSERT ONCE INTO orders_silver BY NAME SELECT * FROM main.archive.orders_2024; CREATE MATERIALIZED VIEW orders_audit AS SELECT * FROM ${x}.y",
    });
    const columns = dataFlowColumns(flow).map((column) => column.map((node) => node.name));
    const at = (name: string) => columns.findIndex((column) => column.includes(name));
    expect(at("main.archive.orders_2024")).toBe(at("orders_silver") - 1);
    expect(at("/Volumes/in")).toBe(at("orders_bronze") - 1);
    // A box linked to nothing goes last in its column, out of the way of the lines.
    const column1 = columns[at("orders_bronze")]!;
    expect(column1[column1.length - 1]).toBe("orders_audit");
  });

  test("what could not be read keeps its file, and skipped Python files are listed", () => {
    const flow = flowOf({ "a.sql": "CREATE MATERIALIZED VIEW m AS SELECT * FROM ${source}.orders" }, {}, [{ file: "b.py", reason: "Python" }]);
    expect(flow.unread).toEqual([{ file: "a.sql", line: 1, reason: "a read named by a setting: ${source}.orders", target: "dataset:m" }]);
    expect(flow.notRead).toEqual([{ file: "b.py", reason: "Python" }]);
  });

  test("the same read twice is one line", () => {
    const flow = flowOf({ "a.sql": "CREATE MATERIALIZED VIEW m AS SELECT * FROM x JOIN x y ON x.id = y.id" });
    expect(edgeNames(flow)).toEqual(["x -> m"]);
  });
});
