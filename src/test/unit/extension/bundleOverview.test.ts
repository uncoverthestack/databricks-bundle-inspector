import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  extractBundleGraph,
  MODELLED_RESOURCE_GROUPS,
  type ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { resolveExpressionForTarget } from "../../../bundle/targetResolution.js";
import {
  buildBundleOverview,
  CHECKED_RESOURCE_GROUPS,
  OTHER_GROUP,
  OVERVIEW_GROUPS,
  overviewGroupOf,
  type BundleOverview,
  type OverviewItem,
} from "../../../webview/lib/bundleOverview.js";
import { typeWords } from "../../../webview/lib/overviewView.js";

const BUNDLE_YAML = `bundle:
  name: overview
variables:
  reporting_wh:
    default: abc123def4567890
resources:
  sql_warehouses:
    analytics:
      name: analytics
    spare:
      name: spare
  clusters:
    shared_etl:
      cluster_name: shared-etl
      spark_version: 15.4.x-scala2.12
      spark_env_vars:
        TOKEN: "{{secrets/app-secrets/token}}"
  secret_scopes:
    app_secrets:
      name: app-secrets
  schemas:
    sales:
      catalog_name: main
      name: sales
  dashboards:
    sales_overview:
      display_name: Sales overview
  some_future_type:
    thing:
      name: thing
  pipelines:
    orders:
      name: orders
    events:
      name: events
  jobs:
    daily:
      name: daily
      job_clusters:
        - job_cluster_key: main
          new_cluster:
            spark_version: 15.4.x-scala2.12
      tasks:
        - task_key: summary
          sql_task:
            warehouse_id: \${resources.sql_warehouses.analytics.id}
            query:
              query_id: q
        - task_key: refresh
          depends_on:
            - task_key: summary
          dashboard_task:
            dashboard_id: d
            warehouse_id: \${var.reporting_wh}
        - task_key: ingest
          job_cluster_key: main
          notebook_task:
            notebook_path: ./reader.py
        - task_key: etl
          existing_cluster_id: \${resources.clusters.shared_etl.id}
          notebook_task:
            notebook_path: ./reader.py
        - task_key: run_orders
          pipeline_task:
            pipeline_id: \${resources.pipelines.orders.id}
        - task_key: broken
          sql_task:
            warehouse_id: \${resources.sql_warehouses.analytic.id}
            query:
              query_id: q
    weekly:
      name: weekly
      job_clusters:
        - job_cluster_key: main
          new_cluster:
            spark_version: 15.4.x-scala2.12
      tasks:
        - task_key: kpis
          sql_task:
            warehouse_id: \${resources.sql_warehouses.analytics.id}
            query:
              query_id: q
        - task_key: load
          job_cluster_key: main
          notebook_task:
            notebook_path: ./plain.py
        - task_key: again
          run_job_task:
            job_id: \${resources.jobs.daily.id}
`;

let root: string;
let overview: BundleOverview;

function item(id: string): OverviewItem | undefined {
  return overview.groups.flatMap((group) => group.items).find((entry) => entry.id === id);
}

/** from, to, kind and task names: what a line and its side panel show. */
function shownLinks(from: string) {
  return overview.links.filter((link) => link.from === from).map((link) => [link.to, link.kind, link.taskNames]);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "dbi-overview-"));
  writeFileSync(path.join(root, "databricks.yml"), BUNDLE_YAML);
  writeFileSync(
    path.join(root, "reader.py"),
    '# Databricks notebook source\ntoken = dbutils.secrets.get(scope="team-secrets", key="token")\n',
  );
  writeFileSync(path.join(root, "plain.py"), "# Databricks notebook source\nprint(1)\n");
  const config = parse(BUNDLE_YAML) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
  overview = buildBundleOverview(
    graph,
    [
      { severity: "error", taskId: "resources.jobs.daily.tasks.broken" },
      { severity: "warning", taskId: "resources.jobs.daily.tasks.ingest" },
      { severity: "warning", resourceId: "resources.pipelines.events" },
      { severity: "info", resourceId: "resources.pipelines.events" },
      { severity: "error" },
      { severity: "warning", resourceId: "resources.pipelines.gone" },
    ],
    (value) => (value === "${var.reporting_wh}" ? "abc123def4567890" : value),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildBundleOverview", () => {
  test("shows only the groups the bundle has, workloads first", () => {
    expect(overview.groups.map((group) => [group.column, group.name, group.items.map((entry) => entry.label)])).toEqual([
      ["workloads", "Workflows", ["daily", "weekly", "events", "orders"]],
      ["workloads", "Dashboards and alerts", ["sales_overview"]],
      ["uses", "Compute", ["analytics", "spare", "shared_etl", "abc123def4567890", "analytic", "main", "main"]],
      ["uses", "Secrets", ["app_secrets", "team-secrets"]],
      ["uses", "Unity Catalog data", ["sales"]],
      ["uses", "Other resources", ["thing"]],
    ]);
  });

  test("a job's links are its Uses row, plus what its tasks run", () => {
    expect(shownLinks("resources.jobs.daily")).toEqual([
      ["resources.clusters.shared_etl", "uses", ["etl"]],
      ["resources.jobs.daily.job_clusters.main", "uses", ["ingest"]],
      ["resources.pipelines.orders", "runs", ["run_orders"]],
      ["resources.secret_scopes.app_secrets", "uses", ["etl"]],
      ["resources.sql_warehouses.analytic", "uses", ["broken"]],
      ["resources.sql_warehouses.analytics", "uses", ["summary"]],
      ["secret:team-secrets", "uses", ["ingest", "etl"]],
      ["warehouse:reporting_wh", "uses", ["refresh"]],
    ]);
  });

  test("a job that runs another job points at it", () => {
    expect(shownLinks("resources.jobs.weekly")).toContainEqual(["resources.jobs.daily", "runs", ["again"]]);
  });

  test("a warehouse two jobs use is one box with a link from each", () => {
    const users = overview.links.filter((link) => link.to === "resources.sql_warehouses.analytics");
    expect(users.map((link) => [link.from, link.taskNames])).toEqual([
      ["resources.jobs.daily", ["summary"]],
      ["resources.jobs.weekly", ["kpis"]],
    ]);
  });

  test("job clusters with the same key in two jobs stay two boxes", () => {
    const daily = item("resources.jobs.daily.job_clusters.main");
    const weekly = item("resources.jobs.weekly.job_clusters.main");
    expect([daily?.source, daily?.definedIn]).toEqual(["job_cluster", "resources.jobs.daily"]);
    expect([weekly?.source, weekly?.definedIn]).toEqual(["job_cluster", "resources.jobs.weekly"]);
    expect(shownLinks("resources.jobs.weekly")).toContainEqual(["resources.jobs.weekly.job_clusters.main", "uses", ["load"]]);
  });

  test("a resource nothing uses still has a box, with no link", () => {
    expect(item("resources.sql_warehouses.spare")?.source).toBe("bundle");
    expect(overview.links.filter((link) => link.to === "resources.sql_warehouses.spare")).toEqual([]);
    expect(overview.links.filter((link) => link.from === "resources.pipelines.events")).toEqual([]);
  });

  test("a reference to a resource the bundle does not have is marked missing", () => {
    expect(item("resources.sql_warehouses.analytic")).toMatchObject({
      source: "missing",
      kind: "warehouse",
      label: "analytic",
      groupId: "compute",
    });
  });

  test("says where a name comes from when it is not a bundle resource", () => {
    const sources = overview.groups
      .flatMap((group) => group.items)
      .filter((entry) => entry.source !== "bundle")
      .map((entry) => [entry.label, entry.source]);
    expect(sources).toEqual([
      ["abc123def4567890", "variable"],
      ["analytic", "missing"],
      ["main", "job_cluster"],
      ["main", "job_cluster"],
      ["team-secrets", "workspace"],
    ]);
  });

  test("a resource group the inspector does not know yet still gets a box", () => {
    expect(item("resources.some_future_type.thing")).toMatchObject({ groupId: OTHER_GROUP.id, hasChecks: false });
  });

  test("marks which boxes the inspector has checks for", () => {
    const checked = overview.groups
      .flatMap((group) => group.items)
      .filter((entry) => entry.hasChecks)
      .map((entry) => entry.id);
    expect(checked.sort()).toEqual([
      "resources.clusters.shared_etl",
      "resources.jobs.daily",
      "resources.jobs.weekly",
      "resources.pipelines.events",
      "resources.pipelines.orders",
      "resources.secret_scopes.app_secrets",
    ]);
  });

  test("every bundle resource opens its YAML line", () => {
    const lineOf = (text: string) => BUNDLE_YAML.split("\n").findIndex((line) => line === text) + 1;
    const file = path.join(root, "databricks.yml");
    expect([item("resources.jobs.daily")?.file, item("resources.jobs.daily")?.line]).toEqual([file, lineOf("    daily:")]);
    expect(item("resources.sql_warehouses.analytics")?.line).toBe(lineOf("    analytics:"));
    expect(item("resources.schemas.sales")?.line).toBe(lineOf("    sales:"));
    expect(item("resources.pipelines.orders")?.line).toBe(lineOf("    orders:"));
    expect(item("resources.some_future_type.thing")?.line).toBe(lineOf("    thing:"));
    expect(item("resources.sql_warehouses.analytic")?.file).toBeUndefined();
  });

  test("counts a task's problems on its job, and leaves the rest bundle-wide", () => {
    expect(item("resources.jobs.daily")?.problems).toEqual({ errors: 1, warnings: 1 });
    expect(item("resources.jobs.weekly")?.problems).toEqual({ errors: 0, warnings: 0 });
    expect(item("resources.pipelines.events")?.problems).toEqual({ errors: 0, warnings: 1 });
    // One with no owner, one on a resource the graph does not have.
    expect(overview.bundleWide).toEqual({ errors: 1, warnings: 1 });
  });

  test("the boxes and bundle-wide count add up to every error and warning", () => {
    const onBoxes = overview.groups
      .flatMap((group) => group.items)
      .reduce((sum, entry) => sum + entry.problems.errors + entry.problems.warnings, 0);
    expect(onBoxes + overview.bundleWide.errors + overview.bundleWide.warnings).toBe(5);
  });

  test("jobs carry their task count", () => {
    expect([item("resources.jobs.daily")?.taskCount, item("resources.jobs.weekly")?.taskCount]).toEqual([6, 3]);
  });

  test("is empty for a bundle with no resources", async () => {
    const graph = await extractBundleGraph({ bundle: { name: "empty" } } as ParsedBundleConfig);
    expect(buildBundleOverview(graph)).toEqual({ groups: [], links: [], bundleWide: { errors: 0, warnings: 0 } });
  });

  test("a pipeline that reads a secret scope links to it", () => {
    const graph = {
      nodes: [
        { id: "resources.pipelines.p", nodeType: "resource", displayName: "p", resourceGroup: "pipelines", resourceKey: "p" },
        { id: "secret-scope:team", nodeType: "secret_scope", displayName: "team" },
      ],
      edges: [{ source: "resources.pipelines.p", target: "secret-scope:team", kind: "references" }],
    };
    const result = buildBundleOverview(graph);
    expect(result.links).toEqual([
      { from: "resources.pipelines.p", to: "secret-scope:team", kind: "uses", taskIds: [], taskNames: [] },
    ]);
    expect(result.groups.map((group) => [group.name, group.items.map((entry) => [entry.label, entry.source])])).toEqual([
      ["Workflows", [["p", "bundle"]]],
      ["Secrets", [["team", "workspace"]]],
    ]);
  });
});

describe("pipeline references (#403)", () => {
  const YAML = `bundle:
  name: pipeline-refs
resources:
  schemas:
    sales:
      name: sales
      catalog_name: main
  pipelines:
    orders:
      name: orders
      catalog: \${resources.schemas.sales.catalog_name}
      schema: \${resources.schemas.sales.name}
      configuration:
        landing: /Volumes/\${resources.schemas.sales.catalog_name}/raw/\${resources.volumes.landing.name}
        self: \${resources.pipelines.orders.id}
    plain:
      name: plain
      catalog: main
      schema: sales
  jobs:
    runner:
      name: runner
      tasks:
        - task_key: refresh
          pipeline_task:
            pipeline_id: \${resources.pipelines.orders.id}
        - task_key: load
          notebook_task:
            notebook_path: ./load.py
            base_parameters:
              schema: \${resources.schemas.sales.name}
`;
  let result: BundleOverview;
  let edges: Awaited<ReturnType<typeof extractBundleGraph>>["edges"];

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dbi-overview-403-"));
    writeFileSync(path.join(dir, "databricks.yml"), YAML);
    writeFileSync(path.join(dir, "load.py"), "# Databricks notebook source\nprint(1)\n");
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(parse(YAML) as ParsedBundleConfig, dir));
    edges = graph.edges;
    result = buildBundleOverview(graph);
    rmSync(dir, { recursive: true, force: true });
  });

  const linksFrom = (from: string) => result.links.filter((link) => link.from === from).map((link) => [link.to, link.kind]);
  const itemById = (id: string) => result.groups.flatMap((group) => group.items).find((entry) => entry.id === id);

  test("a pipeline links to the schema in its catalog and schema fields, once", () => {
    expect(linksFrom("resources.pipelines.orders")).toEqual([
      ["resources.schemas.sales", "uses"],
      ["resources.volumes.landing", "uses"],
    ]);
  });

  test("the edge points at the first field that names the schema", () => {
    const edge = edges.find((e) => e.id === "resources.pipelines.orders->references->resources.schemas.sales");
    expect(edge?.data).toMatchObject({
      expression: "${resources.schemas.sales.catalog_name}",
      yamlPath: "resources.pipelines.orders.catalog",
      line: 11,
    });
  });

  test("a resource the bundle does not have shows as a missing box", () => {
    expect(itemById("resources.volumes.landing")).toMatchObject({
      label: "landing",
      kind: "volumes",
      source: "missing",
      expression: "${resources.volumes.landing.name}",
    });
  });

  test("a pipeline does not link to itself", () => {
    expect(edges.some((e) => e.source === "resources.pipelines.orders" && e.target === "resources.pipelines.orders")).toBe(false);
  });

  test("plain names are not linked", () => {
    expect(linksFrom("resources.pipelines.plain")).toEqual([]);
  });

  test("job links are unchanged", () => {
    expect(linksFrom("resources.jobs.runner")).toEqual([
      ["cluster:Serverless / inherited compute", "uses"],
      ["resources.pipelines.orders", "runs"],
      ["resources.schemas.sales", "uses"],
    ]);
  });
});

describe("resource references beyond pipelines (#423)", () => {
  const YAML = `bundle:
  name: resource-refs
resources:
  sql_warehouses:
    wh:
      name: wh
      cluster_size: 2X-Small
  schemas:
    sales:
      name: sales
      catalog_name: main
  dashboards:
    revenue:
      display_name: Revenue
      file_path: ./revenue.lvdash.json
      warehouse_id: \${resources.sql_warehouses.wh.id}
    by_id:
      display_name: By ID $\${resources.sql_warehouses.wh.id}
      file_path: ./revenue.lvdash.json
      warehouse_id: 1234567890abcdef
  alerts:
    late:
      display_name: Late orders
      warehouse_id: \${resources.sql_warehouses.wh.id}
  genie_spaces:
    ask:
      title: Ask sales
      warehouse_id: \${resources.sql_warehouses.gone.id}
  volumes:
    landing:
      name: landing
      catalog_name: \${resources.schemas.sales.catalog_name}
      schema_name: \${resources.schemas.sales.name}
  registered_models:
    churn:
      name: churn
      catalog_name: main
      schema_name: \${resources.schemas.sales.name}
  apps:
    portal:
      name: portal
      source_code_path: ./app
      description: \${resources.apps.portal.name}
      resources:
        - name: warehouse
          sql_warehouse:
            id: \${resources.sql_warehouses.wh.id}
            permission: CAN_USE
        - name: nightly
          job:
            id: \${resources.jobs.nightly.id}
            permission: CAN_MANAGE_RUN
  jobs:
    nightly:
      name: nightly
      description: \${resources.schemas.sales.name}
      tasks:
        - task_key: refresh
          sql_task:
            warehouse_id: \${resources.sql_warehouses.wh.id}
            file:
              path: ./refresh.sql
`;
  let result: BundleOverview;
  let edges: Awaited<ReturnType<typeof extractBundleGraph>>["edges"];

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dbi-overview-423-"));
    writeFileSync(path.join(dir, "databricks.yml"), YAML);
    writeFileSync(path.join(dir, "refresh.sql"), "SELECT 1\n");
    writeFileSync(path.join(dir, "revenue.lvdash.json"), "{}\n");
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(parse(YAML) as ParsedBundleConfig, dir));
    edges = graph.edges;
    result = buildBundleOverview(graph);
    rmSync(dir, { recursive: true, force: true });
  });

  const linksFrom = (from: string) => result.links.filter((link) => link.from === from).map((link) => [link.to, link.kind]);
  const itemById = (id: string) => result.groups.flatMap((group) => group.items).find((entry) => entry.id === id);

  test("a dashboard and an alert link to the SQL warehouse they name", () => {
    expect(linksFrom("resources.dashboards.revenue")).toEqual([["resources.sql_warehouses.wh", "uses"]]);
    expect(linksFrom("resources.alerts.late")).toEqual([["resources.sql_warehouses.wh", "uses"]]);
  });

  test("a warehouse given as a plain ID links to a dashed box; an escaped $${...} elsewhere draws no line", () => {
    expect(linksFrom("resources.dashboards.by_id")).toEqual([["warehouse:1234567890abcdef", "uses"]]);
  });

  test("a Genie space naming a warehouse the bundle does not have links to a missing box", () => {
    expect(linksFrom("resources.genie_spaces.ask")).toEqual([["resources.sql_warehouses.gone", "uses"]]);
    expect(itemById("resources.sql_warehouses.gone")).toMatchObject({ label: "gone", source: "missing", expression: "${resources.sql_warehouses.gone.id}" });
  });

  test("a volume and a registered model link to their schema, once each", () => {
    expect(linksFrom("resources.volumes.landing")).toEqual([["resources.schemas.sales", "uses"]]);
    expect(linksFrom("resources.registered_models.churn")).toEqual([["resources.schemas.sales", "uses"]]);
  });

  test("the edge points at the first field that names the resource", () => {
    const edge = edges.find((e) => e.id === "resources.volumes.landing->references->resources.schemas.sales");
    expect(edge?.data).toMatchObject({ yamlPath: "resources.volumes.landing.catalog_name", line: 32 });
  });

  test("an app links to the resources it lists, but not to itself", () => {
    expect(linksFrom("resources.apps.portal").sort()).toEqual([
      ["resources.jobs.nightly", "uses"],
      ["resources.sql_warehouses.wh", "uses"],
    ]);
  });

  test("job links still come only from their tasks", () => {
    expect(linksFrom("resources.jobs.nightly")).toEqual([["resources.sql_warehouses.wh", "uses"]]);
    expect(edges.some((e) => e.source === "resources.jobs.nightly" && e.kind === "references")).toBe(false);
  });
});

describe("warehouses and schemas named outside the bundle (#423 follow-up)", () => {
  const YAML = `bundle:
  name: named-outside
variables:
  wh:
    default: 0f0f0f0f0f0f0f0f
  team_schema:
    default: analytics
resources:
  dashboards:
    sales:
      display_name: Sales
      file_path: ./sales.lvdash.json
      warehouse_id: 4f2a9c1e8b7d6a05
  alerts:
    late:
      display_name: Late orders
      warehouse_id: \${var.wh}
  quality_monitors:
    orders_monitor:
      table_name: main.sales.orders
      assets_dir: /Workspace/monitors
      output_schema_name: main.sales
      warehouse_id: 4f2a9c1e8b7d6a05
  volumes:
    raw:
      name: raw
      catalog_name: main
      schema_name: sales
    team:
      name: team
      catalog_name: main
      schema_name: \${var.team_schema}
    gold_files:
      name: gold_files
      catalog_name: main
      schema_name: gold
  registered_models:
    churn:
      name: churn
      catalog_name: main
      schema_name: sales
  schemas:
    gold:
      name: gold
      catalog_name: main
  secrets:
    token:
      catalog_name: main
      schema_name: \${resources.schemas.gold.name}
  jobs:
    refresh:
      name: refresh
      tasks:
        - task_key: run_sql
          sql_task:
            warehouse_id: 4f2a9c1e8b7d6a05
            file:
              path: ./refresh.sql
`;
  let result: BundleOverview;
  let edges: Awaited<ReturnType<typeof extractBundleGraph>>["edges"];

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dbi-overview-outside-"));
    writeFileSync(path.join(dir, "databricks.yml"), YAML);
    writeFileSync(path.join(dir, "refresh.sql"), "SELECT 1\n");
    writeFileSync(path.join(dir, "sales.lvdash.json"), "{}\n");
    const config = parse(YAML) as ParsedBundleConfig;
    const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, dir));
    edges = graph.edges;
    result = buildBundleOverview(graph, [], (value) => resolveExpressionForTarget(value, config).value);
    rmSync(dir, { recursive: true, force: true });
  });

  const linksTo = (to: string) => result.links.filter((link) => link.to === to).map((link) => link.from).sort();
  const itemById = (id: string) => result.groups.flatMap((group) => group.items).find((entry) => entry.id === id);

  test("a dashboard, a quality monitor and a job naming one warehouse ID share one dashed box", () => {
    expect(linksTo("warehouse:4f2a9c1e8b7d6a05")).toEqual([
      "resources.dashboards.sales",
      "resources.jobs.refresh",
      "resources.quality_monitors.orders_monitor",
    ]);
    expect(itemById("warehouse:4f2a9c1e8b7d6a05")).toMatchObject({ label: "4f2a9c1e8b7d6a05", source: "fixed", kind: "warehouse", groupId: "compute" });
  });

  test("a warehouse from a variable shows the variable's value", () => {
    expect(linksTo("warehouse:wh")).toEqual(["resources.alerts.late"]);
    expect(itemById("warehouse:wh")).toMatchObject({ label: "0f0f0f0f0f0f0f0f", source: "variable", expression: "${var.wh}" });
  });

  test("a volume and a registered model in one schema share a dashed schema box", () => {
    expect(linksTo("schema:main.sales")).toEqual(["resources.registered_models.churn", "resources.volumes.raw"]);
    expect(itemById("schema:main.sales")).toMatchObject({ label: "main.sales", source: "fixed", kind: "schemas", groupId: "unity_catalog" });
  });

  test("a schema name with a variable shows its value", () => {
    expect(itemById("schema:main.${var.team_schema}")).toMatchObject({ label: "main.analytics", source: "variable" });
  });

  test("a plain catalog and schema the bundle defines is a line to its own schema box", () => {
    expect(result.links.filter((link) => link.from === "resources.volumes.gold_files").map((link) => link.to)).toEqual(["resources.schemas.gold"]);
    expect(itemById("schema:main.gold")).toBeUndefined();
  });

  test("a ${resources...} schema stays a line to the bundle's own box, with no dashed box", () => {
    expect(result.links.filter((link) => link.from === "resources.secrets.token").map((link) => link.to)).toEqual(["resources.schemas.gold"]);
  });

  test("the edge points at the field that names it", () => {
    const edge = edges.find((e) => e.id === "resources.dashboards.sales->uses->warehouse:4f2a9c1e8b7d6a05");
    expect(edge?.data).toMatchObject({ yamlPath: "resources.dashboards.sales.warehouse_id", line: 13 });
  });
});

describe("overview groups", () => {
  test("no resource group is listed twice", () => {
    const all = OVERVIEW_GROUPS.flatMap((group) => group.resourceGroups);
    expect(new Set(all).size).toBe(all.length);
  });

  test("every resource group the inspector models has a named group", () => {
    const unnamed = MODELLED_RESOURCE_GROUPS.filter((group) => overviewGroupOf(group) === OTHER_GROUP);
    expect(unnamed).toEqual([]);
  });

  test("the checked groups are the supported table of docs/supported-resources.md", () => {
    const doc = readFileSync(path.resolve(__dirname, "../../../../docs/supported-resources.md"), "utf8");
    const supported = doc
      .slice(0, doc.indexOf("## Not supported yet"))
      .split("\n")
      .map((line) => /^\| \[?`([a-z_]+)`/.exec(line)?.[1])
      .filter((group): group is string => group !== undefined);
    expect([...CHECKED_RESOURCE_GROUPS].sort()).toEqual(supported.sort());
  });
});

describe("compute settings in the details (#417)", () => {
  const rows = (entry: OverviewItem | undefined) =>
    Object.fromEntries((entry?.settings?.sections ?? []).map((section) => [section.title, section.rows.map((row) => `${row.label}: ${row.value}`)]));

  test("a cluster resource shows its settings, and the other fields it sets with the line each is on", () => {
    const cluster = item("resources.clusters.shared_etl");
    expect(rows(cluster)).toEqual({ Settings: ["Name: shared-etl", "Runtime: 15.4.x-scala2.12"] });
    expect(cluster?.settings?.alsoSet).toEqual([{ field: "spark_env_vars", count: 1, line: 16 }]);
    expect(cluster?.settings?.file).toBe(path.join(root, "databricks.yml"));
  });

  test("a job cluster shows its new_cluster settings, each job's own", () => {
    expect(rows(item("resources.jobs.daily.job_clusters.main"))).toEqual({ Settings: ["Runtime: 15.4.x-scala2.12"] });
    expect(rows(item("resources.jobs.weekly.job_clusters.main"))).toEqual({ Settings: ["Runtime: 15.4.x-scala2.12"] });
  });

  test("a warehouse shows what it sets; one named by an ID has no settings to show", () => {
    expect(rows(item("resources.sql_warehouses.analytics"))).toEqual({ Settings: ["Name: analytics"] });
    const byId = overview.groups.flatMap((group) => group.items).find((entry) => entry.source === "variable");
    expect(byId?.settings).toBeUndefined();
  });

  test("boxes that are not compute have no settings", () => {
    for (const id of ["resources.jobs.daily", "resources.pipelines.orders", "resources.secret_scopes.app_secrets", "resources.schemas.sales"]) {
      expect(item(id)?.settings).toBeUndefined();
    }
  });
});

describe("compute named by a variable, per target (#417)", () => {
  const yaml = `bundle:
  name: per-target
variables:
  wh:
    default: dev0000000000000
targets:
  dev:
    default: true
  prod:
    variables:
      wh: prod000000000000
resources:
  jobs:
    report:
      tasks:
        - task_key: q
          sql_task:
            warehouse_id: \${var.wh}
            query:
              query_id: q
        - task_key: nb
          notebook_task:
            notebook_path: ./nb.py
        - task_key: script
          environment_key: default
          spark_python_task:
            python_file: ./job.py
      environments:
        - environment_key: default
          spec:
            environment_version: "5"
`;
  let dir: string;
  let graph: Awaited<ReturnType<typeof extractBundleGraph>>;
  const config = parse(yaml) as ParsedBundleConfig;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dbi-overview-targets-"));
    writeFileSync(path.join(dir, "databricks.yml"), yaml);
    writeFileSync(path.join(dir, "nb.py"), "# Databricks notebook source\nprint(1)\n");
    writeFileSync(path.join(dir, "job.py"), "print(1)\n");
    graph = await enrichGraphWithFileContent(await extractBundleGraph(config, dir));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** The overview as the app builds it for a picked target. */
  const forTarget = (target: string) =>
    buildBundleOverview(graph, [], (value) => resolveExpressionForTarget(value, config, target).value)
      .groups.flatMap((group) => group.items);

  test("switching targets changes the box's name to that target's value", () => {
    const named = (target: string) => forTarget(target).find((entry) => entry.source === "variable");
    expect(named("dev")).toMatchObject({ label: "dev0000000000000", expression: "${var.wh}" });
    expect(named("prod")).toMatchObject({ label: "prod000000000000", expression: "${var.wh}" });
  });

  test("serverless compute lists the job's environment and its notebook task", () => {
    const serverless = forTarget("dev").find((entry) => entry.source === "default");
    expect(Object.fromEntries((serverless?.settings?.sections ?? []).map((section) => [section.title, section.rows.map((row) => `${row.label}: ${row.value}`)]))).toEqual({
      "Environment default": ["Version: 5", "Tasks: script"],
      "Notebook tasks": ["Environment: Not set in the job. Databricks chooses the version.", "Tasks: nb"],
    });
  });
});

describe("what an app's resources name by plain name (#446)", () => {
  const YAML = `bundle:
  name: app-resources
variables:
  endpoint:
    default: chat-prod
resources:
  secret_scopes:
    app_scope:
      name: app-secrets
  model_serving_endpoints:
    chat:
      name: chat-endpoint
  database_instances:
    db:
      name: orders-db
  volumes:
    landing:
      name: landing
      catalog_name: main
      schema_name: raw
  model_services:
    svc:
      parent: schemas/main.ml
      model_service_id: ranker
  postgres_branches:
    dev:
      parent: projects/shop
      branch_id: dev
  dashboards:
    sales:
      display_name: Sales
      file_path: ./sales.lvdash.json
      warehouse_id: 4f2a9c1e8b7d6a05
  apps:
    other:
      name: other-app
      source_code_path: ./other
    portal:
      name: portal
      source_code_path: ./app
      resources:
        - name: wh
          sql_warehouse: { id: 4f2a9c1e8b7d6a05, permission: CAN_USE }
        - name: own_secret
          secret: { scope: app-secrets, key: token, permission: READ }
        - name: key_not_name
          secret: { scope: app_scope, key: token, permission: READ }
        - name: workspace_secret
          secret: { scope: shared-secrets, key: token, permission: READ }
        - name: chat
          serving_endpoint: { name: chat-endpoint, permission: CAN_QUERY }
        - name: chat_by_var
          serving_endpoint: { name: "\${var.endpoint}", permission: CAN_QUERY }
        - name: other_app
          app: { name: other-app, permission: CAN_USE }
        - name: self
          app: { name: portal, permission: CAN_USE }
        - name: db
          database: { instance_name: orders-db, database_name: shop, permission: CAN_CONNECT_AND_CREATE }
        - name: landing
          uc_securable: { securable_type: VOLUME, securable_full_name: main.raw.landing, permission: READ_VOLUME }
        - name: orders
          uc_securable: { securable_type: TABLE, securable_full_name: main.sales.orders, permission: SELECT }
        - name: fn
          uc_securable: { securable_type: FUNCTION, securable_full_name: main.sales.score, permission: EXECUTE }
        - name: conn
          uc_securable: { securable_type: CONNECTION, securable_full_name: pg_conn, permission: USE_CONNECTION }
        - name: ranker
          uc_securable: { securable_type: MODEL_SERVICE, securable_full_name: main.ml.ranker, permission: EXECUTE }
        - name: branch
          postgres: { branch: projects/shop/branches/dev, permission: CAN_CONNECT_AND_CREATE }
        - name: pg_db
          postgres: { branch: projects/shop/branches/dev, database: projects/shop/branches/dev/databases/orders, permission: CAN_CONNECT_AND_CREATE }
        - name: job
          job: { id: "123", permission: CAN_MANAGE_RUN }
        - name: experiment
          experiment: { experiment_id: "456", permission: CAN_READ }
        - name: genie
          genie_space: { name: ask, space_id: "789", permission: CAN_RUN }
    linked:
      name: linked
      source_code_path: ./linked
      resources:
        - name: chat
          serving_endpoint: { name: "\${resources.model_serving_endpoints.chat.name}", permission: CAN_QUERY }
        - name: other_chat
          serving_endpoint: { name: chat-prod, permission: CAN_QUERY }
`;
  let result: BundleOverview;
  let resolved: BundleOverview;
  let graph: Awaited<ReturnType<typeof extractBundleGraph>>;
  let issues: ReturnType<typeof buildInspectorIssues>;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dbi-overview-446-"));
    writeFileSync(path.join(dir, "databricks.yml"), YAML);
    writeFileSync(path.join(dir, "sales.lvdash.json"), "{}\n");
    const parsed = parse(YAML) as ParsedBundleConfig;
    graph = await enrichGraphWithFileContent(await extractBundleGraph(parsed, dir));
    result = buildBundleOverview(graph);
    resolved = buildBundleOverview(graph, [], (value) => value.replace("${var.endpoint}", "chat-prod"));
    issues = buildInspectorIssues(graph, parsed, [], dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const linksFrom = (overview: BundleOverview, from: string) =>
    overview.links.filter((link) => link.from === from).map((link) => link.to).sort();
  const itemById = (overview: BundleOverview, id: string) => overview.groups.flatMap((group) => group.items).find((entry) => entry.id === id);
  const groupOf = (overview: BundleOverview, id: string) => overview.groups.find((group) => group.items.some((entry) => entry.id === id))?.id;

  test("each name the bundle defines links to its own box; the rest to dashed boxes; plain job, experiment and Genie IDs draw nothing", () => {
    expect(linksFrom(result, "resources.apps.portal")).toEqual([
      "named:connections:pg_conn",
      "named:functions:main.sales.score",
      "named:model_serving_endpoints:${var.endpoint}",
      "named:postgres_databases:projects/shop/branches/dev/databases/orders",
      "named:tables:main.sales.orders",
      "resources.apps.other",
      "resources.database_instances.db",
      "resources.model_services.svc",
      "resources.model_serving_endpoints.chat",
      "resources.postgres_branches.dev",
      "resources.secret_scopes.app_scope",
      "resources.volumes.landing",
      "secret:app_scope",
      "secret:shared-secrets",
      "warehouse:4f2a9c1e8b7d6a05",
    ]);
  });

  test("a warehouse ID shares the dashed box a dashboard naming it gets", () => {
    expect(linksFrom(result, "resources.dashboards.sales")).toEqual(["warehouse:4f2a9c1e8b7d6a05"]);
    expect(result.groups.flatMap((group) => group.items).filter((entry) => entry.id === "warehouse:4f2a9c1e8b7d6a05")).toHaveLength(1);
  });

  test("tables, functions and connections are dashed boxes in Unity Catalog data", () => {
    for (const id of ["named:tables:main.sales.orders", "named:functions:main.sales.score", "named:connections:pg_conn"]) {
      expect(groupOf(result, id)).toBe("unity_catalog");
      expect(itemById(result, id)).toMatchObject({ source: "fixed", hasChecks: false });
    }
    expect(itemById(result, "named:tables:main.sales.orders")).toMatchObject({ kind: "tables", label: "main.sales.orders" });
  });

  test("a dashed box sits in its resource's group", () => {
    expect(groupOf(result, "named:postgres_databases:projects/shop/branches/dev/databases/orders")).toBe("lakebase");
    expect(groupOf(result, "named:model_serving_endpoints:${var.endpoint}")).toBe("serving_search");
    expect(groupOf(result, "secret:shared-secrets")).toBe("secrets");
  });

  test("a name from a variable shows the variable, or its value for a picked target", () => {
    expect(itemById(result, "named:model_serving_endpoints:${var.endpoint}")).toMatchObject({ label: "${var.endpoint}", source: "variable" });
    expect(itemById(resolved, "named:model_serving_endpoints:${var.endpoint}")).toMatchObject({ label: "chat-prod", source: "variable" });
  });

  test("two apps naming the same thing share one dashed box, and ${resources...} stays a line to the bundle's box", () => {
    expect(linksFrom(result, "resources.apps.linked")).toEqual(["named:model_serving_endpoints:chat-prod", "resources.model_serving_endpoints.chat"]);
  });

  test("an app naming itself draws no line", () => {
    expect(linksFrom(result, "resources.apps.portal")).not.toContain("resources.apps.portal");
  });

  test("the edge points at the field that names it", () => {
    const edge = graph.edges.find((e) => e.id === "resources.apps.portal->uses->named:tables:main.sales.orders");
    expect(edge?.data).toMatchObject({ yamlPath: "resources.apps.portal.resources[10].uc_securable.securable_full_name", line: 63 });
  });

  test("a dashed box's type reads in words", () => {
    const words = (id: string) => typeWords(itemById(result, id)!);
    expect(words("named:tables:main.sales.orders")).toBe("table");
    expect(words("named:functions:main.sales.score")).toBe("function");
    expect(words("named:connections:pg_conn")).toBe("connection");
    expect(words("named:model_serving_endpoints:${var.endpoint}")).toBe("model serving endpoint");
    expect(words("named:postgres_databases:projects/shop/branches/dev/databases/orders")).toBe("Postgres database");
  });

  test("an app secret naming a scope by its resource key adds no warning yet", () => {
    expect(issues.filter((issue) => issue.kind === "secret_scope_name_mismatch")).toEqual([]);
  });
});
