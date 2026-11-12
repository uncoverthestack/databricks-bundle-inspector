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
