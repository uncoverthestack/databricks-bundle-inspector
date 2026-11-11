import { describe, expect, test } from "@jest/globals";
import { readPipelineSql } from "../../../bundle/pipelineSql.js";

const edges = (sql: string, config?: Record<string, string>) =>
  readPipelineSql(sql, config).reads.map((read) => `${read.source} -> ${read.target}`);
const names = (sql: string) => readPipelineSql(sql).datasets.map((d) => `${d.kind} ${d.name}`);

describe("pipeline SQL: what each statement creates (Databricks pipeline SQL reference)", () => {
  test("streaming tables, materialized views, views, tables", () => {
    expect(names(`
      CREATE OR REFRESH STREAMING TABLE raw AS SELECT * FROM STREAM read_files('/Volumes/x');
      CREATE OR REFRESH MATERIALIZED VIEW mv AS SELECT * FROM raw;
      CREATE TEMPORARY VIEW tv AS SELECT 1;
      CREATE VIEW v AS SELECT * FROM mv;
      CREATE TABLE output FLOW INSERT BY NAME SELECT * FROM STREAM(samples.tpch.orders);
      CREATE OR REFRESH PRIVATE MATERIALIZED VIEW priv AS SELECT * FROM mv;
    `)).toEqual([
      "streaming_table raw", "materialized_view mv", "view tv", "view v", "table output", "materialized_view priv",
    ]);
  });

  test("a streaming table with no query, filled by a flow", () => {
    const result = readPipelineSql(`
      CREATE OR REFRESH STREAMING TABLE orders;
      CREATE FLOW users_flow AS INSERT INTO orders BY NAME SELECT * FROM stream(raw_data.users);
    `);
    expect(result.datasets.map((d) => d.name)).toEqual(["orders"]);
    expect(result.reads).toEqual([expect.objectContaining({ source: "raw_data.users", target: "orders", streaming: true, flow: "users_flow" })]);
  });

  test("AUTO CDC and its older name APPLY CHANGES write into their target", () => {
    expect(edges(`
      CREATE OR REFRESH STREAMING TABLE target;
      CREATE FLOW flow AS AUTO CDC INTO target FROM stream(cdc_data.users) KEYS (userId) APPLY AS DELETE WHEN operation = "DELETE" SEQUENCE BY sequenceNum;
      APPLY CHANGES INTO LIVE.legacy_target FROM STREAM(LIVE.cdc_raw) KEYS (id) SEQUENCE BY ts;
    `)).toEqual(["cdc_data.users -> target", "cdc_raw -> legacy_target"]);
  });

  test("one-time flows: INSERT ONCE", () => {
    expect(edges(`CREATE FLOW backfill_users AS INSERT ONCE INTO users BY NAME SELECT * FROM user_backfill_table;`)).toEqual(["user_backfill_table -> users"]);
  });

  test("the legacy LIVE keyword and LIVE. prefix", () => {
    expect(names(`CREATE OR REFRESH LIVE TABLE old_mv AS SELECT * FROM LIVE.raw; CREATE STREAMING LIVE TABLE old_st AS SELECT * FROM STREAM(LIVE.raw);`))
      .toEqual(["materialized_view old_mv", "streaming_table old_st"]);
    expect(edges(`CREATE LIVE TABLE a AS SELECT * FROM LIVE.raw`)).toEqual(["raw -> a"]);
  });
});

describe("pipeline SQL: what each query reads", () => {
  test("joins, commas, aliases and three-part names", () => {
    expect(edges(`
      CREATE MATERIALIZED VIEW m AS
      SELECT * FROM main.sales.orders o
      JOIN customers AS c ON o.id = c.id
      LEFT JOIN \`weird name\`.x w USING (id), extra e;
    `).sort()).toEqual(["customers -> m", "extra -> m", "main.sales.orders -> m", "weird name.x -> m"]);
  });

  test("a FROM inside a function is not a table", () => {
    expect(edges(`
      CREATE MATERIALIZED VIEW m AS
      SELECT EXTRACT(YEAR FROM order_date) y, TRIM(BOTH ' ' FROM name) n, SUBSTRING(code FROM 2) s, a IS DISTINCT FROM b
      FROM orders;
    `)).toEqual(["orders -> m"]);
  });

  test("a subquery's own FROM is read; a WITH name is not a table", () => {
    expect(edges(`
      CREATE MATERIALIZED VIEW m AS
      WITH recent AS (SELECT * FROM orders WHERE d > '2026-01-01')
      SELECT * FROM recent WHERE id IN (SELECT id FROM vip);
    `)).toEqual(["orders -> m", "vip -> m"]);
  });

  test("read_files is a file source; other table functions are reported, not guessed", () => {
    const result = readPipelineSql(`CREATE STREAMING TABLE a AS SELECT * FROM STREAM read_files('/Volumes/main/raw/in', format => 'json');
      CREATE MATERIALIZED VIEW b AS SELECT * FROM my_table_function(1)`);
    expect(result.reads.map((r) => r.source)).toEqual(["files:/Volumes/main/raw/in"]);
    expect(result.unread.map((u) => u.reason)).toEqual(["reads from the function my_table_function(…)"]);
  });

  test("Spark's direct file reads, FROM format.`path`, are file sources", () => {
    expect(edges("CREATE MATERIALIZED VIEW a AS SELECT * FROM parquet.`/databricks-datasets/x/`; CREATE MATERIALIZED VIEW b AS SELECT * FROM json.`dbfs:/data/y.json` j JOIN delta.`s3://bucket/z` d ON j.k = d.k"))
      .toEqual(["files:/databricks-datasets/x/ -> a", "files:dbfs:/data/y.json -> b", "files:s3://bucket/z -> b"]);
    // A real table in a schema called json stays a table.
    expect(edges("CREATE MATERIALIZED VIEW c AS SELECT * FROM json.events")).toEqual(["json.events -> c"]);
  });

  test("words inside strings and comments are not read", () => {
    expect(edges(`
      -- CREATE MATERIALIZED VIEW ghost AS SELECT * FROM nowhere;
      /* FROM also_nowhere */
      CREATE MATERIALIZED VIEW m COMMENT 'built FROM the orders table' AS SELECT 'x FROM y' AS t FROM orders;
    `)).toEqual(["orders -> m"]);
  });

  test("statements without semicolons, as in Databricks' own examples", () => {
    expect(edges(`-- first\nCREATE MATERIALIZED VIEW a AS SELECT * FROM src\n\n-- second\nCREATE MATERIALIZED VIEW b AS SELECT * FROM a\nAPPLY CHANGES INTO c FROM STREAM(b) KEYS (id) SEQUENCE BY ts`))
      .toEqual(["src -> a", "a -> b", "b -> c"]);
  });

  test("AUTO CDC FROM SNAPSHOT reads the snapshot query; the version helpers read no table", () => {
    const result = readPipelineSql(`CREATE FLOW f AS AUTO CDC INTO orders
      FROM SNAPSHOT (SELECT * FROM read_files('/Volumes/c/s/in/') WHERE p = (SELECT version.path FROM current_snapshot_version()))
      WITH VERSION (SELECT struct(t, path) AS version FROM list_files('/Volumes/c/s/in/') WHERE NOT EXISTS (SELECT 1 FROM last_snapshot_version()))
      KEYS (id) STORED AS SCD TYPE 2`);
    expect(result.reads.map((r) => `${r.source} -> ${r.target}`)).toEqual(["files:/Volumes/c/s/in/ -> orders"]);
    expect(result.unread).toEqual([]);
  });

  test("the Databricks notebook source format", () => {
    expect(edges(`-- Databricks notebook source\nCREATE MATERIALIZED VIEW a AS SELECT * FROM b\n\n-- COMMAND ----------\n\nCREATE MATERIALIZED VIEW c AS SELECT * FROM a`))
      .toEqual(["b -> a", "a -> c"]);
  });

  test("lines point at the name", () => {
    const result = readPipelineSql(`\n\nCREATE MATERIALIZED VIEW\n  a AS\nSELECT *\nFROM b`);
    expect(result.datasets[0]!.line).toBe(4);
    expect(result.reads[0]!.line).toBe(6);
  });
});

describe("pipeline SQL: settings in names", () => {
  test("a ${key} the pipeline's configuration gives is filled in", () => {
    expect(edges(`CREATE MATERIALIZED VIEW \${env}_m AS SELECT * FROM \${source_schema}.orders`, { env: "dev", source_schema: "raw" }))
      .toEqual(["raw.orders -> dev_m"]);
  });

  test("a ${key} the configuration does not give makes the name unreadable, not guessed", () => {
    const result = readPipelineSql(`CREATE MATERIALIZED VIEW m AS SELECT * FROM \${source}.orders; CREATE MATERIALIZED VIEW \${name} AS SELECT 1`);
    expect(result.reads).toEqual([]);
    expect(result.datasets.map((d) => d.name)).toEqual(["m"]);
    expect(result.unread.map((u) => u.reason)).toEqual(["a read named by a setting: ${source}.orders", "a table named by a setting: ${name}"]);
  });
});

describe("pipeline SQL: what is not a dataset", () => {
  test("SET, USE and other statements are counted, not drawn", () => {
    const result = readPipelineSql(`SET spark.x = 1; USE CATALOG main; CREATE FUNCTION f() RETURNS INT RETURN 1;`);
    expect(result.datasets).toEqual([]);
    expect(result.ignored).toBe(2);
    expect(result.unread.map((u) => u.reason)).toEqual(["a CREATE FUNCTION statement the view does not draw"]);
  });
});
