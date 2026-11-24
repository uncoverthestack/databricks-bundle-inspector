import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildBundleOverview } from "../../../bundle/bundleOverview.js";
import { itemNote } from "../../../webview/lib/overviewView.js";
import {
  branchById,
  branchCountWords,
  branchStates,
  buildLakebaseProjects,
  cadenceWords,
  durationWords,
  holdsWords,
  parseLakebasePath,
  sourceWords,
  type LakebaseProject,
} from "../../../bundle/lakebaseBranches.js";

// The fixture passed `bundle validate` on CLI v1.28.0 (structural preview and target dev, see its
// README), and the validate output keeps every `${resources...}` reference as written, so the
// YAML stands in for the CLI output.
const bundleRoot = path.resolve(__dirname, "../../fixtures/lakebase-branches");

async function projectsFrom(yaml: string, resolve?: (value: string) => string): Promise<LakebaseProject[]> {
  const config = { bundle: { name: "lakebase_branches" }, resources: (parse(yaml) as { resources: ParsedBundleConfig["resources"] }).resources } as ParsedBundleConfig;
  const graph = await extractBundleGraph(config, bundleRoot);
  return buildLakebaseProjects(graph.nodes, graph.edges, resolve);
}

const fixtureYaml = () => readFileSync(path.join(bundleRoot, "resources/lakebase.yml"), "utf8").replace(/\r\n/g, "\n");

/** The tree as `depth label (source) [states]`, one line per branch. */
function treeLines(project: LakebaseProject): string[] {
  return project.tree.map(({ id, depth }) => {
    const branch = branchById(project, id)!;
    const tags = [branch.isDefault ? "default" : "", branch.isProtected ? "protected" : ""].filter(Boolean);
    const states = branchStates(branch);
    return `${"  ".repeat(depth)}${branch.label}${tags.length ? ` <${tags.join(", ")}>` : ""} | ${sourceWords(branch)} | ${holdsWords(branch)}${states.length ? ` | ${states.join("; ")}` : ""}`;
  });
}

describe("Lakebase branches (issue 543)", () => {
  test("the fixture's project: each branch under the one it was made from, the snapshot branch apart", async () => {
    const [project, ...others] = await projectsFrom(fixtureYaml());
    expect(others).toEqual([]);
    expect(project!.key).toBe("orders_db");
    expect(project!.pgVersion).toBe("17");
    expect(project!.history).toBe("7 days");
    expect(treeLines(project!)).toEqual([
      "production <default> | Made with the project | app_db · orders · used by orders_app",
      "  dev | From production |  | Expires 7 days after it's created",
      "    feature_x | From dev at LSN 0/1A2B3C |  | No read-write endpoint in this bundle",
    ]);
    expect(project!.fromSnapshot.map((id) => branchById(project!, id)!.label)).toEqual(["restore"]);
    expect(sourceWords(branchById(project!, "resources.postgres_branches.restore")!)).toBe("From snapshot daily-20261123");
    expect(branchCountWords(project!)).toBe("3 branches · 1 from a snapshot");
  });

  test("dev's state says when it expires; its endpoint is read-write with its size and suspend time", async () => {
    const [project] = await projectsFrom(fixtureYaml());
    const dev = branchById(project!, "resources.postgres_branches.dev")!;
    expect(branchStates(dev)).toEqual(["Expires 7 days after it's created"]);
    expect(dev.endpoints).toEqual([
      expect.objectContaining({ label: "dev_rw", readWrite: true, typeWords: "read-write", capacity: "0.5 to 2 CU", suspend: "suspends after 5 min" }),
    ]);
    expect(dev.source).toEqual({ kind: "branch", branchId: `${project!.id}#branch:production`, label: "production", implicit: false });
  });

  test("the first branch holds what names it by path, and the app uses it through app_db", async () => {
    const [project] = await projectsFrom(fixtureYaml());
    const production = branchById(project!, `${project!.id}#branch:production`)!;
    expect(production.origin).toBe("project");
    expect(production.endpoints.map((endpoint) => endpoint.label)).toEqual(["prod_rw"]);
    expect(production.held.map((held) => `${held.group}:${held.label}:${held.detail ?? ""}`)).toEqual([
      "postgres_databases:app_db:database app_db",
      "postgres_roles:app_owner:role app_owner",
      "postgres_synced_tables:orders:synced from main.sales.orders",
    ]);
    expect(production.schedules).toEqual([expect.objectContaining({ label: "daily", cadences: ["Daily at 03:00 UTC, kept 7 days"] })]);
    expect(production.usedBy).toEqual([{ id: "resources.apps.orders_app", label: "orders_app", through: "app_db" }]);
  });

  test("a branch in a project the bundle doesn't define stays out, so it keeps its own box", async () => {
    const [project] = await projectsFrom(fixtureYaml());
    expect(project!.memberIds).not.toContain("resources.postgres_branches.reports");
    expect(project!.memberIds.sort()).toEqual(
      [
        "resources.postgres_branches.dev",
        "resources.postgres_branches.feature_x",
        "resources.postgres_branches.restore",
        "resources.postgres_databases.app_db",
        "resources.postgres_endpoints.dev_rw",
        "resources.postgres_endpoints.prod_rw",
        "resources.postgres_roles.app_owner",
        "resources.postgres_snapshot_schedules.daily",
        "resources.postgres_synced_tables.orders",
      ].sort(),
    );
  });

  test("plain paths work like references, and a branch ID with a variable matches once resolved", async () => {
    const yaml = `resources:
  postgres_projects:
    p:
      project_id: shop-\${var.env}
      default_branch: projects/shop-\${var.env}/branches/main
  postgres_branches:
    main:
      parent: projects/shop-\${var.env}
      branch_id: main
      is_protected: true
    dev:
      parent: projects/shop-dev
      branch_id: dev-\${workspace.current_user.short_name}
      expire_time: "2026-12-31T00:00:00Z"
    hotfix:
      parent: projects/shop-dev
      branch_id: hotfix
      source_branch: projects/shop-dev/branches/staging
      source_branch_time: "2026-11-20T08:00:00Z"
  postgres_endpoints:
    rw:
      parent: projects/shop-dev/branches/dev-alice
      endpoint_id: rw
      endpoint_type: ENDPOINT_TYPE_READ_WRITE
      no_suspension: true
`;
    const resolve = (value: string) => value.replace("${var.env}", "dev").replace("${workspace.current_user.short_name}", "alice");
    const [project] = await projectsFrom(yaml, resolve);
    expect(treeLines(project!)).toEqual([
      "main <default, protected> | The project's default branch | ",
      "  dev | From main |  | Expires 2026-12-31T00:00:00Z",
      "staging | Not in this bundle | ",
      "  hotfix | From staging at 2026-11-20T08:00:00Z |  | No read-write endpoint in this bundle",
    ]);
    const dev = branchById(project!, "resources.postgres_branches.dev")!;
    expect(dev.endpoints).toEqual([expect.objectContaining({ label: "rw", suspend: "never suspends" })]);
    expect(branchStates(dev)).toEqual(["Expires 2026-12-31T00:00:00Z"]);
    expect(dev.source).toEqual(expect.objectContaining({ kind: "branch", label: "main", implicit: true }));
  });

  test("without a resolver, a project ID with a variable still matches the same text", async () => {
    const yaml = `resources:
  postgres_projects:
    p:
      project_id: shop-\${var.env}
  postgres_branches:
    b:
      parent: projects/shop-\${var.env}
      branch_id: b
`;
    const [project] = await projectsFrom(yaml);
    expect(project!.memberIds).toEqual(["resources.postgres_branches.b"]);
  });

  test("branches made from each other in a loop are all still listed", async () => {
    const yaml = `resources:
  postgres_projects:
    p:
      project_id: p
  postgres_branches:
    a:
      parent: \${resources.postgres_projects.p.id}
      branch_id: a
      source_branch: \${resources.postgres_branches.b.id}
    b:
      parent: \${resources.postgres_projects.p.id}
      branch_id: b
      source_branch: \${resources.postgres_branches.a.id}
`;
    const [project] = await projectsFrom(yaml);
    expect(project!.tree.map(({ id }) => branchById(project!, id)!.label).sort()).toEqual(["a", "b", "production"]);
  });

  test("a catalog on a branch and a Data API on a database fold in too", async () => {
    const yaml = `resources:
  postgres_projects:
    p:
      project_id: p
  postgres_databases:
    db:
      parent: projects/p/branches/production
      database_id: db
  postgres_catalogs:
    cat:
      catalog_id: shop
      branch: projects/p/branches/production
      postgres_database: db
  postgres_data_apis:
    api:
      parent: projects/p/branches/production/databases/db
    api_by_reference:
      parent: \${resources.postgres_databases.db.id}
`;
    const [project] = await projectsFrom(yaml);
    expect(project!.memberIds.sort()).toEqual([
      "resources.postgres_catalogs.cat",
      "resources.postgres_data_apis.api",
      "resources.postgres_data_apis.api_by_reference",
      "resources.postgres_databases.db",
    ]);
    expect(branchById(project!, `${project!.id}#branch:production`)!.held.map((held) => held.label)).toEqual(["db", "cat", "api", "api_by_reference"]);
  });

  test("no projects, no model", async () => {
    expect(await projectsFrom("resources:\n  postgres_branches:\n    b:\n      parent: projects/x\n")).toEqual([]);
  });
});

describe("Lakebase on the overview (issue 543)", () => {
  test("one box per project, which takes the lines and problems of what folds into it", async () => {
    const config = { bundle: { name: "lakebase_branches" }, resources: (parse(fixtureYaml()) as { resources: ParsedBundleConfig["resources"] }).resources } as ParsedBundleConfig;
    const graph = await extractBundleGraph(config, bundleRoot);
    const overview = buildBundleOverview(graph, [
      { severity: "warning", resourceId: "resources.postgres_endpoints.dev_rw" },
      { severity: "error", resourceId: "resources.postgres_branches.reports" },
    ]);
    const lakebase = overview.groups.find((group) => group.id === "lakebase")!;
    expect(lakebase.items.map((item) => item.label)).toEqual(["orders_db", "reports"]);
    const project = lakebase.items[0]!;
    expect(itemNote(overview, project)).toBe("Postgres project · 4 branches");
    expect(project.problems).toEqual({ errors: 0, warnings: 1 });
    expect(lakebase.items[1]!.problems).toEqual({ errors: 1, warnings: 0 });
    expect(overview.links.map((link) => `${link.from} -> ${link.to}`)).toEqual(["resources.apps.orders_app -> resources.postgres_projects.orders_db"]);
  });
});

describe("Lakebase words", () => {
  test("paths", () => {
    expect(parseLakebasePath("${resources.postgres_projects.p.id}/branches/production")).toEqual({ projectKey: "p", branchText: "production" });
    expect(parseLakebasePath("${resources.postgres_branches.dev.name}")).toEqual({ branchKey: "dev" });
    expect(parseLakebasePath("projects/a/branches/b/databases/c")).toEqual({ projectText: "a", branchText: "b", databaseText: "c" });
    expect(parseLakebasePath("projects/a/snapshots/s1")).toEqual({ projectText: "a", snapshotText: "s1" });
    expect(parseLakebasePath("${resources.jobs.j.id}")).toBeUndefined();
    expect(parseLakebasePath("main")).toBeUndefined();
    expect(parseLakebasePath(3)).toBeUndefined();
  });

  test("durations", () => {
    expect(durationWords("604800s")).toBe("7 days");
    expect(durationWords("86400s")).toBe("1 day");
    expect(durationWords("7200s")).toBe("2 hours");
    expect(durationWords("300s")).toBe("5 min");
    expect(durationWords("45s")).toBe("45 seconds");
    expect(durationWords("${var.ttl}")).toBe("${var.ttl}");
    expect(durationWords(undefined)).toBeUndefined();
  });

  test("snapshot cadences", () => {
    expect(cadenceWords({ daily_schedule: { hour: 3 }, retention: "604800s" })).toBe("Daily at 03:00 UTC, kept 7 days");
    expect(cadenceWords({ weekly_schedule: { day_of_week: "SUNDAY", hour: 22 } })).toBe("Weekly on Sunday at 22:00 UTC");
    expect(cadenceWords({ monthly_schedule: { day: 1 } })).toBe("Monthly on day 1");
    expect(cadenceWords({ retention: "60s" })).toBeUndefined();
  });
});
