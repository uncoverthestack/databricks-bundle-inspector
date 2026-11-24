/**
 * The icon drawn in place of a type's dot (issue 546), by the item's kind: `job`, `pipeline`,
 * `warehouse`, `cluster`, `secret_scope`, else the bundle resource group's name. Names are
 * lucide icons, drawn by TypeDot in the type's family colour. A kind with no icon keeps its dot.
 *
 * No icon may look like a problem or status mark (TriangleAlert, CircleX, Info, Check): those
 * mean an error, a warning, a note or ok across the panel. An alert is a bell for this reason.
 */
const LAKEBASE_GROUPS = [
  "database_instances",
  "database_catalogs",
  "synced_database_tables",
  "postgres_projects",
  "postgres_branches",
  "postgres_endpoints",
  "postgres_databases",
  "postgres_roles",
  "postgres_catalogs",
  "postgres_synced_tables",
  "postgres_snapshot_schedules",
  "postgres_data_apis",
] as const;

export const ICON_OF_KIND: Readonly<Record<string, string>> = {
  // Workflows
  job: "workflow",
  pipeline: "waypoints",
  // A run that happened, never a play shape: the inspector runs nothing, and play reads as Run.
  job_runs: "rotate-ccw-clock",
  // Dashboards and alerts
  dashboards: "layout-dashboard",
  alerts: "bell",
  genie_spaces: "sparkles",
  // Apps
  apps: "app-window",
  // Serving and search
  model_serving_endpoints: "plug",
  vector_search_endpoints: "search",
  vector_search_indexes: "text-search",
  // Unity Gateway
  model_services: "router",
  model_provider_services: "router",
  mcp_services: "router",
  // Compute
  warehouse: "warehouse",
  cluster: "server",
  instance_pools: "layers",
  cluster_policies: "scroll-text",
  // Secrets: the scope's key is drawn by TypeDot itself (issue 535).
  secret_scope: "key",
  secrets: "lock-keyhole",
  // Unity Catalog data, including what an app can name outside the bundle (issue 446)
  catalogs: "library",
  schemas: "folder-tree",
  volumes: "hard-drive",
  external_locations: "cloud",
  tables: "table",
  functions: "square-function",
  connections: "cable",
  // Data quality
  quality_monitors: "activity",
  data_quality_monitors: "gauge",
  // Machine learning
  experiments: "flask-conical",
  models: "brain-circuit",
  registered_models: "brain-circuit",
  features: "columns-3",
  feature_specs: "list-tree",
  materialization_sets: "layers",
  // Lakebase: one icon for all twelve; the type in words tells them apart.
  ...Object.fromEntries(LAKEBASE_GROUPS.map((group) => [group, "database"])),
};

/** Shapes that mean a problem or a status in the panel, never a type. */
export const RESERVED_ICONS: readonly string[] = ["triangle-alert", "circle-alert", "circle-x", "x", "info", "check", "circle-check"];

export function iconOfKind(kind: string | undefined): string | undefined {
  return kind ? ICON_OF_KIND[kind] : undefined;
}
