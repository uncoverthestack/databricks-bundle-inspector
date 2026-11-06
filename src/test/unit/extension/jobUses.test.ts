import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildJobUses, type UsesItem } from "../../../webview/lib/jobUses.js";

let root: string;
let uses: UsesItem[];

/** label, kind, source and task names, the parts the row shows. */
function shown(items: UsesItem[]) {
  return items.map((item) => [item.kind, item.label, item.source, item.taskNames]);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "dbi-job-uses-"));
  writeFileSync(
    path.join(root, "reader.py"),
    '# Databricks notebook source\ntoken = dbutils.secrets.get(scope="team-secrets", key="token")\n',
  );
  const config = {
    bundle: { name: "uses" },
    variables: { reporting_wh: { default: "abc123def4567890" } },
    resources: {
      sql_warehouses: { analytics: { name: "analytics" } },
      secret_scopes: { app_secrets: { name: "app-secrets" } },
      jobs: {
        daily: {
          name: "daily",
          job_clusters: [
            {
              job_cluster_key: "main",
              new_cluster: { spark_version: "15.4.x-scala2.12", spark_env_vars: { TOKEN: "{{secrets/app-secrets/token}}" } },
            },
          ],
          tasks: [
            { task_key: "summary", sql_task: { warehouse_id: "${resources.sql_warehouses.analytics.id}", query: { query_id: "q" } } },
            { task_key: "models", depends_on: [{ task_key: "summary" }], dbt_task: { commands: ["dbt build"], warehouse_id: "${resources.sql_warehouses.analytics.id}" } },
            { task_key: "refresh", dashboard_task: { dashboard_id: "d", warehouse_id: "${var.reporting_wh}" } },
            { task_key: "ingest", job_cluster_key: "main", notebook_task: { notebook_path: "./reader.py" } },
            { task_key: "legacy", existing_cluster_id: "0123-456789-abcdefgh", spark_python_task: { python_file: "./reader.py" } },
            { task_key: "adhoc", notebook_task: { notebook_path: "./reader.py" } },
          ],
        },
        other: { name: "other", tasks: [{ task_key: "elsewhere", sql_task: { warehouse_id: "${resources.sql_warehouses.analytics.id}", query: { query_id: "q" } } }] },
      },
    },
  } as unknown as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
  const job = graph.nodes.find((node) => node.nodeType === "job" && node.resourceKey === "daily")!;
  uses = buildJobUses(graph, job.id, (value) => (value === "${var.reporting_wh}" ? "abc123def4567890" : value));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildJobUses", () => {
  test("lists each warehouse, cluster and secret scope once, with the tasks that use it", () => {
    expect(shown(uses)).toEqual([
      ["warehouse", "abc123def4567890", "variable", ["refresh"]],
      ["warehouse", "analytics", "bundle", ["summary", "models"]],
      ["cluster", "0123-456789-abcdefgh", "fixed", ["legacy"]],
      ["cluster", "main", "bundle", ["ingest"]],
      ["cluster", "Serverless or inherited", "default", ["adhoc"]],
      ["secret_scope", "app-secrets", "bundle", ["ingest"]],
      ["secret_scope", "team-secrets", "workspace", ["ingest", "legacy", "adhoc"]],
    ]);
  });

  test("only counts the shown job's tasks", () => {
    const analytics = uses.find((item) => item.label === "analytics");
    expect(analytics?.taskNames).not.toContain("elsewhere");
  });

  test("keeps the written value for the tooltip", () => {
    expect(uses.find((item) => item.label === "analytics")?.expression).toBe("${resources.sql_warehouses.analytics.id}");
    expect(uses.find((item) => item.source === "variable")?.expression).toBe("${var.reporting_wh}");
  });

  test("shows a variable by name when its value isn't known", () => {
    const graph = {
      nodes: [
        { id: "job", nodeType: "job", displayName: "j" },
        { id: "t", nodeType: "task", displayName: "t", parentId: "job" },
        { id: "warehouse:wh", nodeType: "warehouse", displayName: "wh", data: { expression: "${var.wh}" } },
      ],
      edges: [{ source: "t", target: "warehouse:wh", kind: "uses" }],
    };
    expect(shown(buildJobUses(graph, "job"))).toEqual([["warehouse", "${var.wh}", "variable", ["t"]]]);
  });

  test("is empty for a job with no tasks", () => {
    expect(buildJobUses({ nodes: [{ id: "job", nodeType: "job", displayName: "j" }], edges: [] }, "job")).toEqual([]);
  });
});
