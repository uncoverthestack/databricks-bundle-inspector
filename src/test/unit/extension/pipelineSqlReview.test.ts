import { describe, expect, test } from "@jest/globals";
import { buildPipelineDataFlow, dataFlowColumns } from "../../../bundle/pipelineDataFlow.js";
import { readPipelineSql } from "../../../bundle/pipelineSql.js";

/**
 * Cases from a review of the pipeline data flow at 2b64bd7 (issue 398), each with what the
 * Databricks SQL reference says it means. They must keep passing.
 */
const sources = (sql: string) => readPipelineSql(sql).reads.map((read) => read.source);

describe("pipeline SQL review: the reader always finishes", () => {
  test.each([
    "CREATE MATERIALIZED VIEW m AS SELECT * FROM ${unfinished",
    "CREATE MATERIALIZED VIEW m AS SELECT $",
    "CREATE MATERIALIZED VIEW m AS SELECT * FROM orders WHERE price > $amount",
    "CREATE MATERIALIZED VIEW m AS SELECT * FROM ${complete}",
    "$", "${", "`", "'", "/*", "CREATE", "CREATE FLOW", "r'", "-- only a comment",
  ])("%j", (sql) => {
    const started = Date.now();
    readPipelineSql(sql);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("an unfinished ${ makes the name unreadable instead of guessing it", () => {
    const result = readPipelineSql("CREATE MATERIALIZED VIEW m AS SELECT * FROM ${unfinished");
    expect(result.reads).toEqual([]);
    expect(result.unread.map((item) => item.reason)).toEqual(["a read named by a setting: ${unfinished"]);
  });

  test("a $ in a query that is not a name changes nothing", () => {
    expect(sources("CREATE MATERIALIZED VIEW m AS SELECT * FROM orders WHERE price > $amount")).toEqual(["orders"]);
  });
});

describe("pipeline SQL review: valid SQL keeps every dependency and invents none", () => {
  test.each([
    ["a 'CREATE' string does not start a statement", "CREATE MATERIALIZED VIEW m AS SELECT 'CREATE' AS action FROM orders", ["orders"]],
    ["a table named like a keyword, in backticks", "CREATE MATERIALIZED VIEW m AS SELECT * FROM `SELECT`", ["SELECT"]],
    ["a table named STREAM, in backticks", "CREATE MATERIALIZED VIEW m AS SELECT * FROM `STREAM`", ["STREAM"]],
    ["CTE column aliases", "CREATE MATERIALIZED VIEW m AS WITH recent(id) AS (SELECT id FROM orders) SELECT * FROM recent", ["orders"]],
    ["a CTE hides a table only after it is defined, in its own query", "CREATE MATERIALIZED VIEW m AS SELECT * FROM orders WHERE id IN (WITH orders AS (SELECT id FROM archive_orders) SELECT id FROM orders)", ["orders", "archive_orders"]],
    ["nested block comments", "CREATE MATERIALIZED VIEW m AS SELECT 1 /* outer /* inner */ FROM ghost */ FROM orders", ["orders"]],
    ["read_files with concat of strings", "CREATE MATERIALIZED VIEW m AS SELECT * FROM read_files(concat('/Volumes/c/s/', 'in'))", ["files:/Volumes/c/s/in"]],
    ["read_files with a raw string", "CREATE MATERIALIZED VIEW m AS SELECT * FROM read_files(r'C:\\input\\orders')", ["files:C:\\input\\orders"]],
    ["a subquery in double brackets", "CREATE MATERIALIZED VIEW m AS SELECT * FROM ((SELECT * FROM orders))", ["orders"]],
  ])("%s", (_name, sql, expected) => {
    expect(sources(sql)).toEqual(expected);
  });

  test("read_files with a path built from a column is reported, not guessed", () => {
    const result = readPipelineSql("CREATE MATERIALIZED VIEW m AS SELECT * FROM read_files(concat(base_path, '/in'))");
    expect(result.reads).toEqual([]);
    expect(result.unread.map((item) => item.reason)).toEqual(["reads files from a path built in code"]);
  });

  test("`a.b` (one name with a dot) and a.b (schema a, table b) stay different", () => {
    const result = readPipelineSql("CREATE MATERIALIZED VIEW `a.b` AS SELECT 1; CREATE MATERIALIZED VIEW a.b AS SELECT 2");
    expect(result.datasets.map((dataset) => dataset.name)).toEqual(["`a.b`", "a.b"]);
    const flow = buildPipelineDataFlow([{ file: "x.sql", result }], []);
    expect(flow.nodes).toHaveLength(2);
    expect(flow.nodes.every((node) => !node.definedAgain)).toBe(true);
  });
});

describe("pipeline SQL review: reads connect to the right table", () => {
  const flow = (sql: string, defaults: { catalog?: string; schema?: string } = {}) =>
    buildPipelineDataFlow([{ file: "x.sql", result: readPipelineSql(sql) }], [], defaults);
  const edgeNames = (built: ReturnType<typeof flow>) => {
    const name = new Map(built.nodes.map((node) => [node.id, node.name]));
    return built.edges.map((edge) => `${name.get(edge.from)} -> ${name.get(edge.to)}`);
  };

  test("two datasets sharing a last name: the read goes to the one it names", () => {
    const built = flow(
      "CREATE MATERIALIZED VIEW main.sales.orders AS SELECT 1; CREATE MATERIALIZED VIEW archive.orders AS SELECT 2; CREATE MATERIALIZED VIEW report AS SELECT * FROM main.sales.orders",
      { catalog: "main", schema: "sales" },
    );
    expect(edgeNames(built)).toEqual(["main.sales.orders -> report"]);
  });

  test("a fully named dataset is read by its full name", () => {
    expect(edgeNames(flow("CREATE MATERIALIZED VIEW main.other.orders AS SELECT 1; CREATE MATERIALIZED VIEW report AS SELECT * FROM main.other.orders", { catalog: "main", schema: "sales" })))
      .toEqual(["main.other.orders -> report"]);
  });

  test("after USE SCHEMA, a plain name is in that schema: not the pipeline's own table, only maybe", () => {
    const built = flow("CREATE MATERIALIZED VIEW orders AS SELECT 1; USE SCHEMA archive; CREATE MATERIALIZED VIEW report AS SELECT * FROM orders", { catalog: "main", schema: "sales" });
    const source = built.nodes.find((node) => node.kind === "outside");
    expect(source).toEqual(expect.objectContaining({ name: "orders", maybeSameAs: "orders" }));
    expect(edgeNames(built)).toEqual(["orders -> report"]);
    expect(built.edges[0]!.from).toBe(source!.id);
  });

  test("with no USE and no defaults, the same plain name written alike connects", () => {
    expect(edgeNames(flow("CREATE MATERIALIZED VIEW orders AS SELECT 1; CREATE MATERIALIZED VIEW report AS SELECT * FROM orders"))).toEqual(["orders -> report"]);
  });
});

describe("pipeline SQL review: long chains lay out without running out of stack", () => {
  test.each([5000, 10000])("a reversed chain of %i datasets", (n) => {
    // Defined last-first, so every dataset reads one defined after it.
    const sql = Array.from({ length: n }, (_, i) => {
      const at = n - i;
      return `CREATE MATERIALIZED VIEW t${at} AS SELECT * FROM ${at === 1 ? "source" : `t${at - 1}`};`;
    }).join("\n");
    const built = buildPipelineDataFlow([{ file: "x.sql", result: readPipelineSql(sql) }], []);
    const columns = dataFlowColumns(built);
    expect(columns).toHaveLength(n + 1);
  });
});
