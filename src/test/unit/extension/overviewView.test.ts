import { describe, expect, test } from "@jest/globals";
import { buildBundleOverview, type BundleOverview, type OverviewGraph, type OverviewItem } from "../../../webview/lib/bundleOverview.js";
import {
  foldedGroupIds,
  isUnchecked,
  itemNote,
  linkedIds,
  namedOutside,
  resourceGroupWords,
  showsAllLines,
  SMALL_BUNDLE_MAX_ITEMS,
  sourceSentence,
  typeWords,
  usedByWords,
} from "../../../webview/lib/overviewView.js";

const resource = (group: string, key: string, extra: Record<string, unknown> = {}) => ({
  id: `resources.${group}.${key}`,
  nodeType: group === "jobs" ? "job" : "resource",
  displayName: key,
  resourceGroup: group,
  resourceKey: key,
  ...extra,
});
const task = (job: string, key: string) => ({
  id: `resources.jobs.${job}.tasks.${key}`,
  nodeType: "task",
  displayName: key,
  parentId: `resources.jobs.${job}`,
});
const uses = (source: string, target: string, kind = "uses") => ({ source, target, kind });

/** Two jobs sharing a warehouse, one running a pipeline, plus data nothing links to. */
const GRAPH: OverviewGraph = {
  nodes: [
    resource("jobs", "daily", { taskCount: 3 }),
    resource("jobs", "weekly", { taskCount: 1 }),
    task("daily", "summary"),
    task("daily", "models"),
    task("daily", "run_orders"),
    task("weekly", "kpis"),
    resource("pipelines", "orders"),
    resource("sql_warehouses", "analytics"),
    resource("schemas", "sales"),
    resource("postgres_branches", "main"),
    { id: "warehouse:analytics", nodeType: "warehouse", displayName: "analytics", data: { expression: "${resources.sql_warehouses.analytics.id}" } },
    { id: "warehouse:wh", nodeType: "warehouse", displayName: "wh", data: { expression: "${var.wh}" } },
    { id: "cluster:0123", nodeType: "cluster", displayName: "0123", data: { expression: "0123" } },
    { id: "cluster:main", nodeType: "cluster", displayName: "main", data: { jobCluster: true } },
    { id: "secret:team", nodeType: "secret_scope", displayName: "team" },
    { id: "warehouse:gone", nodeType: "warehouse", displayName: "gone", data: { expression: "${resources.sql_warehouses.gone.id}" } },
  ],
  edges: [
    uses("resources.jobs.daily.tasks.summary", "warehouse:analytics"),
    uses("resources.jobs.daily.tasks.models", "warehouse:analytics"),
    uses("resources.jobs.weekly.tasks.kpis", "warehouse:analytics"),
    uses("resources.jobs.daily.tasks.models", "warehouse:wh"),
    uses("resources.jobs.daily.tasks.models", "cluster:0123"),
    uses("resources.jobs.daily.tasks.summary", "cluster:main"),
    uses("resources.jobs.daily.tasks.summary", "secret:team", "references"),
    uses("resources.jobs.weekly.tasks.kpis", "warehouse:gone"),
    uses("resources.jobs.daily.tasks.run_orders", "resources.pipelines.orders", "references"),
  ],
};
const overview = buildBundleOverview(GRAPH);
const item = (label: string, source?: string): OverviewItem =>
  overview.groups.flatMap((group) => group.items).find((entry) => entry.label === label && (!source || entry.source === source))!;
const note = (label: string, source?: string) => itemNote(overview, item(label, source));

/** A bundle of `count` schemas and one job, to cross the small-bundle limit. */
function withSchemas(count: number, issues: { severity: string; resourceId: string }[] = []): BundleOverview {
  return buildBundleOverview(
    { nodes: [resource("jobs", "daily"), ...Array.from({ length: count }, (_, index) => resource("schemas", `s${index}`))], edges: [] },
    issues,
  );
}

describe("overview wording", () => {
  test("turns a resource group into its type in words", () => {
    expect(["registered_models", "postgres_branches", "sql_warehouses", "quality_monitors", "mcp_services", "genie_spaces", "vector_search_indexes"].map(resourceGroupWords)).toEqual([
      "registered model",
      "Postgres branch",
      "SQL warehouse",
      "quality monitor",
      "MCP service",
      "Genie space",
      "vector search index",
    ]);
    expect(typeWords(item("analytics"))).toBe("SQL warehouse");
    expect(typeWords(item("main", "bundle"))).toBe("Postgres branch");
  });

  test("a job says how many tasks it has", () => {
    expect(note("daily")).toBe("3 tasks");
    expect(note("weekly")).toBe("1 task");
  });

  test("a number always has its word, and says how many jobs when more than one", () => {
    expect(usedByWords(overview, item("analytics").id)).toBe("3 tasks in 2 jobs");
    expect(note("analytics")).toBe("3 tasks in 2 jobs");
    expect(usedByWords(overview, item("sales").id)).toBe("");
  });

  test("says where a name from outside the bundle comes from", () => {
    expect(note("${var.wh}")).toBe("from a variable · 1 task");
    expect(note("0123")).toBe("written in · 1 task");
    expect(note("team")).toBe("not in this bundle · 1 task");
    expect(note("gone")).toBe("may not exist · 1 task");
    expect(note("main", "job_cluster")).toBe("job cluster of daily · 1 task");
  });

  test("a type with no tag says what it is", () => {
    expect(note("sales")).toBe("schema");
    expect(note("main", "bundle")).toBe("Postgres branch");
  });

  test("a pipeline says which job runs it", () => {
    expect(note("orders")).toBe("run by daily");
  });

  test("only names from outside the bundle are dashed", () => {
    const dashed = overview.groups.flatMap((group) => group.items).filter(namedOutside).map((entry) => entry.label);
    expect(dashed.sort()).toEqual(["${var.wh}", "0123", "gone", "team"]);
  });

  test("every source has a sentence for the details", () => {
    for (const entry of overview.groups.flatMap((group) => group.items)) {
      expect(sourceSentence(entry)).not.toBe("");
    }
    expect(sourceSentence(item("gone"))).toContain("${resources.sql_warehouses.gone.id}");
  });
});

describe("overview lighting and folding", () => {
  test("a box lights what it is linked to, in both directions", () => {
    expect([...linkedIds(overview, item("analytics").id)].sort()).toEqual(["resources.jobs.daily", "resources.jobs.weekly"]);
    expect(linkedIds(overview, item("daily").id).has("resources.pipelines.orders")).toBe(true);
    expect(linkedIds(overview, item("sales").id).size).toBe(0);
  });

  test("a group with no checks and no lines is unchecked", () => {
    const unchecked = overview.groups.filter((group) => isUnchecked(overview, group)).map((group) => group.name);
    expect(unchecked).toEqual(["Unity Catalog data", "Lakebase (Postgres)"]);
  });

  test("a small bundle shows every line and folds nothing", () => {
    const small = withSchemas(SMALL_BUNDLE_MAX_ITEMS - 1);
    expect(showsAllLines(small)).toBe(true);
    expect(foldedGroupIds(small).size).toBe(0);
  });

  test("a larger bundle shows lines on demand and folds unchecked groups", () => {
    const large = withSchemas(SMALL_BUNDLE_MAX_ITEMS);
    expect(showsAllLines(large)).toBe(false);
    expect([...foldedGroupIds(large)]).toEqual(["unity_catalog"]);
  });

  test("a group with a problem on one of its boxes stays open", () => {
    const large = withSchemas(SMALL_BUNDLE_MAX_ITEMS, [{ severity: "warning", resourceId: "resources.schemas.s3" }]);
    expect(foldedGroupIds(large).size).toBe(0);
  });
});
