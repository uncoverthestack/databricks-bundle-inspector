import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildBundleOverview, OTHER_GROUP } from "../../../bundle/bundleOverview.js";
import { buildLakebaseProjects } from "../../../bundle/lakebaseBranches.js";

// One of every resource type CLI v1.28.0 accepts (issue 567). The fixture passed `bundle validate -t dev`, and
// the structural preview keeps every `${resources...}` reference as written, so the merged YAML
// stands in for the CLI output (see the fixture's README).
const bundleRoot = path.resolve(__dirname, "../../fixtures/all-resources");

/** The `resources:` keys in bundle/config/resources.go at CLI v1.28.0, without internal ones. */
const CLI_RESOURCE_TYPES = [
  "alerts", "apps", "catalogs", "cluster_policies", "clusters", "dashboards", "data_quality_monitors",
  "database_catalogs", "database_instances", "experiments", "external_locations", "feature_specs", "features",
  "genie_spaces", "instance_pools", "job_runs", "jobs", "materialization_sets", "mcp_services",
  "model_provider_services", "model_serving_endpoints", "model_services", "models", "pipelines",
  "postgres_branches", "postgres_catalogs", "postgres_data_apis", "postgres_databases", "postgres_endpoints",
  "postgres_projects", "postgres_roles", "postgres_snapshot_schedules", "postgres_synced_tables",
  "quality_monitors", "registered_models", "schemas", "secret_scopes", "secrets", "sql_warehouses",
  "synced_database_tables", "vector_search_endpoints", "vector_search_indexes", "volumes",
];

function fixtureConfig(): ParsedBundleConfig {
  const resources: Record<string, Record<string, unknown>> = {};
  for (const file of readdirSync(path.join(bundleRoot, "resources")).sort()) {
    const yaml = readFileSync(path.join(bundleRoot, "resources", file), "utf8").replace(/\r\n/g, "\n");
    for (const [group, items] of Object.entries((parse(yaml) as { resources: Record<string, Record<string, unknown>> }).resources)) {
      resources[group] = { ...resources[group], ...items };
    }
  }
  return { bundle: { name: "all_resources" }, resources } as ParsedBundleConfig;
}

describe("a bundle with every resource type", () => {
  test("the fixture has each type the CLI accepts, once", () => {
    expect(Object.keys(fixtureConfig().resources ?? {}).sort()).toEqual([...CLI_RESOURCE_TYPES].sort());
  });

  test("every resource is on the overview: its own box, or folded into its Lakebase project's", async () => {
    const config = fixtureConfig();
    const graph = await extractBundleGraph(config, bundleRoot);
    const overview = buildBundleOverview(graph);
    const boxes = new Set(overview.groups.flatMap((group) => group.items).map((item) => `resources.${item.resourceGroup}.${item.resourceKey}`));
    const folded = new Set(buildLakebaseProjects(graph.nodes, graph.edges).flatMap((project) => project.memberIds));
    const written = Object.entries(config.resources ?? {}).flatMap(([group, items]) => Object.keys(items as object).map((key) => `resources.${group}.${key}`));
    expect(written.filter((id) => !boxes.has(id) && !folded.has(id))).toEqual([]);
    expect(written.filter((id) => boxes.has(id) && folded.has(id))).toEqual([]);
  });

  test("no type falls into Other resources", async () => {
    const overview = buildBundleOverview(await extractBundleGraph(fixtureConfig(), bundleRoot));
    expect(overview.groups.find((group) => group.id === OTHER_GROUP.id)?.items ?? []).toEqual([]);
  });
});
