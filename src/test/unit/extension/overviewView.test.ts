import { describe, expect, test } from "@jest/globals";
import { buildBundleOverview, type BundleOverview, type OverviewGraph, type OverviewItem, type OverviewLink } from "../../../webview/lib/bundleOverview.js";
import {
  findMatches,
  foldedGroupIds,
  groupOfSelected,
  isUnchecked,
  litByFind,
  itemNote,
  linkedIds,
  namedOutside,
  noBoxProblemsWords,
  problemContext,
  problemsFirst,
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
    expect(note("daily")).toBe("job · 3 tasks");
    expect(note("weekly")).toBe("job · 1 task");
  });

  test("a number always has its word, and says how many jobs when more than one", () => {
    expect(usedByWords(overview, item("analytics").id)).toBe("3 tasks in 2 jobs");
    expect(note("analytics")).toBe("SQL warehouse · 3 tasks in 2 jobs");
    expect(usedByWords(overview, item("sales").id)).toBe("");
  });

  test("says where a name from outside the bundle comes from", () => {
    expect(note("${var.wh}")).toBe("SQL warehouse · from a variable · 1 task");
    expect(note("0123")).toBe("cluster · written in · 1 task");
    expect(note("team")).toBe("secret scope · not in this bundle · 1 task");
    expect(note("gone")).toBe("SQL warehouse · may not exist · 1 task");
    expect(note("main", "job_cluster")).toBe("cluster · defined in daily · 1 task");
    // Serverless or inherited compute is not called a cluster.
    const serverless = { ...item("main", "job_cluster"), id: "cluster:serverless", label: "Serverless or inherited", source: "default" } as OverviewItem;
    expect(itemNote(overview, serverless)).toBe("compute");
  });

  test("a type with no tag says what it is", () => {
    expect(note("sales")).toBe("schema");
    expect(note("main", "bundle")).toBe("Postgres branch");
  });

  test("a pipeline says which job runs it", () => {
    expect(note("orders")).toBe("pipeline · run by daily");
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

describe("large bundles: find, problems only, problems first", () => {
  const item = (id: string, label: string, errors = 0, warnings = 0, extra: Partial<OverviewItem> = {}): OverviewItem =>
    ({ id, groupId: "g", column: "workloads", kind: "job", label, source: "bundle", problems: { errors, warnings }, hasChecks: true, ...extra }) as OverviewItem;
  const overview = (items: OverviewItem[], links: OverviewLink[] = []): BundleOverview =>
    ({ groups: [{ id: "g", name: "Workflows", column: "workloads", items }], links, bundleWide: { errors: 0, warnings: 0 } }) as unknown as BundleOverview;
  const link = (from: string, to: string): OverviewLink => ({ from, to, kind: "uses", taskIds: [], taskNames: [] }) as OverviewLink;

  test("problems first: errors, then warnings, then the rest, keeping their order", () => {
    const items = [item("a", "a"), item("b", "b", 0, 1), item("c", "c", 2), item("d", "d"), item("e", "e", 0, 3), item("f", "f", 1, 1)];
    expect(problemsFirst(items).map((entry) => entry.id)).toEqual(["c", "f", "b", "e", "a", "d"]);
  });

  test("problems first leaves a group with no problems as it was", () => {
    const items = [item("z", "z"), item("a", "a")];
    expect(problemsFirst(items).map((entry) => entry.id)).toEqual(["z", "a"]);
  });

  test("find matches the name or the bundle key, ignoring case and spaces around it", () => {
    const shown = overview([
      item("1", "Orders Daily"),
      item("2", "nightly", 0, 0, { resourceKey: "orders_backfill" }),
      item("3", "customers"),
    ]);
    expect([...findMatches(shown, "  ORDERS ")!].sort()).toEqual(["1", "2"]);
    expect(findMatches(shown, "nothing")).toEqual(new Set());
  });

  test("an empty search finds nothing to filter by", () => {
    expect(findMatches(overview([item("1", "a")]), "   ")).toBeNull();
  });

  test("a match keeps what it links to lit", () => {
    const shown = overview([item("job", "orders"), item("wh", "warehouse"), item("other", "other")], [link("job", "wh")]);
    expect([...litByFind(shown, findMatches(shown, "orders")!)].sort()).toEqual(["job", "wh"]);
  });

  test("problems only keeps boxes with a problem and what they link to", () => {
    const shown = overview(
      [item("bad", "bad", 1), item("warn", "warn", 0, 1), item("wh", "wh"), item("fine", "fine"), item("scope", "scope")],
      [link("bad", "wh"), link("fine", "scope")],
    );
    expect([...problemContext(shown)].sort()).toEqual(["bad", "warn", "wh"]);
  });

  test("problems only is empty for a bundle with no problems", () => {
    expect(problemContext(overview([item("a", "a"), item("b", "b")]))).toEqual(new Set());
  });
});

describe("overview edge cases from review", () => {
  const box = (id: string, errors = 0): OverviewItem =>
    ({ id, groupId: "g", column: "workloads", kind: "job", label: id, source: "bundle", problems: { errors, warnings: 0 }, hasChecks: true }) as OverviewItem;
  const shown = (bundleWide: { errors: number; warnings: number }, items = [box("a")]): BundleOverview =>
    ({ groups: [{ id: "g", name: "Workflows", column: "workloads", items }, { id: "h", name: "Apps", column: "workloads", items: [box("app")] }], links: [], bundleWide }) as unknown as BundleOverview;

  test("Issues does not say 'no problems' when the bundle itself has one", () => {
    expect(noBoxProblemsWords(shown({ errors: 1, warnings: 0 }))).toBe("No resource has a problem. The bundle's own problems are in the Issues list.");
    expect(noBoxProblemsWords(shown({ errors: 0, warnings: 2 }))).toMatch(/^No resource has a problem/);
  });

  test("Issues says 'no problems' only when nothing has one", () => {
    expect(noBoxProblemsWords(shown({ errors: 0, warnings: 0 }))).toBe("No problems found in this bundle.");
  });

  test("the selected box's group is found, so a folded group can open for it", () => {
    expect(groupOfSelected(shown({ errors: 0, warnings: 0 }), "app")).toBe("h");
    expect(groupOfSelected(shown({ errors: 0, warnings: 0 }), null)).toBeUndefined();
    expect(groupOfSelected(shown({ errors: 0, warnings: 0 }), "gone")).toBeUndefined();
  });
});

describe("search matches type words (issue 395)", () => {
  const box = (id: string, label: string, kind: string, resourceGroup?: string): OverviewItem =>
    ({ id, groupId: "g", column: "uses", kind, label, source: "bundle", resourceGroup, problems: { errors: 0, warnings: 0 }, hasChecks: true }) as OverviewItem;
  const shown = {
    groups: [{ id: "g", name: "Compute", column: "uses", items: [
      box("c", "shared_etl", "cluster", "clusters"),
      box("w", "analytics", "warehouse", "sql_warehouses"),
      box("s", "sales", "schemas", "schemas"),
    ] }],
    links: [],
    bundleWide: { errors: 0, warnings: 0 },
  } as unknown as BundleOverview;

  test("a type finds its boxes, as the search list does", () => {
    expect([...findMatches(shown, "cluster")!]).toEqual(["c"]);
    expect([...findMatches(shown, "SQL warehouse")!]).toEqual(["w"]);
    expect([...findMatches(shown, "schema")!]).toEqual(["s"]);
  });

  test("names still match", () => {
    expect([...findMatches(shown, "etl")!]).toEqual(["c"]);
  });
});
