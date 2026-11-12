import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import { readPipelineSql } from "../../../bundle/pipelineSql.js";

/**
 * The inspector reads pipeline SQL with its own parser (src/bundle/pipelineSql.ts), so it
 * follows the Databricks pipeline SQL reference. The pages are saved in a snapshot that
 * `npm run check:pipeline-sql-reference` compares with the live docs every week; this test
 * reads every one of Databricks' own examples from it, without the network (issue 398).
 */
const snapshot = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../fixtures/pipeline-sql-reference.json"), "utf8"),
) as { checkedOn: string; pages: Record<string, { title?: string; blocks?: { heading: string; code: string }[]; outsidePipelines?: boolean }> };

/** Each statement page reviewed against the parser. A new page fails until it is added here. */
const REVIEWED_PIPELINE_PAGES = [
  "ldp-sql-ref-apply-changes-into",
  "ldp-sql-ref-create-flow",
  "ldp-sql-ref-create-materialized-view",
  "ldp-sql-ref-create-streaming-table",
  "ldp-sql-ref-create-table-flow",
  "ldp-sql-ref-create-temporary-view",
  "ldp-sql-ref-create-view",
];
/** Statements that run outside a pipeline (Databricks SQL), so never in a pipeline's sources. */
const OUTSIDE_PIPELINES = [
  "sql-ref-syntax-ddl-alter-materialized-view",
  "sql-ref-syntax-ddl-alter-streaming-table",
  "sql-ref-syntax-qry-explain-materialized-view",
];

const slug = (key: string) => key.split("/").pop()!;
const examples = Object.entries(snapshot.pages).flatMap(([key, page]) =>
  (page.blocks ?? [])
    .filter((block) => block.heading !== "Syntax" && !block.heading.startsWith("Parameters"))
    .map((block, index) => ({ page: slug(key), index, code: block.code })),
);

describe(`Databricks pipeline SQL reference (snapshot of ${snapshot.checkedOn})`, () => {
  test("every statement page has been reviewed against the parser", () => {
    const pipelinePages = Object.entries(snapshot.pages).filter(([, page]) => !page.outsidePipelines).map(([key]) => slug(key)).sort();
    const outsidePages = Object.entries(snapshot.pages).filter(([, page]) => page.outsidePipelines).map(([key]) => slug(key)).sort();
    expect(pipelinePages).toEqual([...REVIEWED_PIPELINE_PAGES].sort());
    expect(outsidePages).toEqual([...OUTSIDE_PIPELINES].sort());
  });

  test("the snapshot holds Databricks' examples to read", () => {
    expect(examples.length).toBeGreaterThanOrEqual(REVIEWED_PIPELINE_PAGES.length);
  });

  test.each(examples)("$page example $index: every statement is read, nothing is left unread", ({ code }) => {
    const result = readPipelineSql(code);
    expect(result.unread).toEqual([]);
    const statements = code.replace(/--[^\n]*/g, "");
    const creates = (statements.match(/(^|;|\n)\s*CREATE\b/gi) ?? []).length;
    const flows = (statements.match(/\bCREATE\s+FLOW\b/gi) ?? []).length;
    expect(result.datasets.length + flows).toBe(creates);
    expect(result.reads.filter((read) => read.source === read.target)).toEqual([]);
  });

  test("the flow examples give the reads reviewed by hand on 2026-11-11", () => {
    const flow = examples.filter((example) => example.page === "ldp-sql-ref-create-flow");
    const reads = flow.flatMap(({ code }) => readPipelineSql(code).reads.map((read) => `${read.source} -> ${read.target} (${read.flow})`));
    expect(reads).toEqual([
      "raw_data.users -> users (users_flow)",
      "user_backfill_table -> users (backfill_users)",
      "cdc_data.admins -> admins_cdc_target_table (admin_cdc_flow)",
      "samples.wanderbricks.payments -> payments_latest (payments_replace_flow)",
      "catalog.schema.users_snapshot -> users (users_snapshot_flow)",
      "files:/Volumes/catalog/schema/landing/orders/ -> orders (orders_cdc)",
      "catalog.schema.customers_snapshot -> customers (customers_snapshot_backfill)",
      "customers_cdc_events -> customers (customers_cdc)",
      "samples.wanderbricks.payments -> payments_latest (payments_latest)",
    ]);
  });
});
