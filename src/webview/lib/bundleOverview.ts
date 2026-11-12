/**
 * The bundle overview: every resource in the bundle as a box, in two columns, with the
 * links between them. Built from the graph the extension sends, so it shows only what the
 * bundle says. Left column: what runs or shows something. Right column: what those use.
 */
import { buildJobUses, type UsesSource } from "./jobUses.js";

export type OverviewColumn = "workloads" | "uses";

export interface OverviewGroupDefinition {
  id: string;
  name: string;
  column: OverviewColumn;
  /** The bundle resource groups shown in this group, in the order their boxes are listed. */
  resourceGroups: readonly string[];
}

/**
 * Every resource group of the bundle schema, in the group and column it is shown in.
 * The schema coverage test fails when the CLI adds a resource group that is not listed here.
 */
export const OVERVIEW_GROUPS: readonly OverviewGroupDefinition[] = [
  { id: "workflows", name: "Workflows", column: "workloads", resourceGroups: ["jobs", "pipelines", "job_runs"] },
  {
    id: "dashboards_alerts",
    name: "Dashboards and alerts",
    column: "workloads",
    resourceGroups: ["dashboards", "alerts", "genie_spaces"],
  },
  { id: "apps", name: "Apps", column: "workloads", resourceGroups: ["apps"] },
  {
    id: "serving_search",
    name: "Serving and search",
    column: "workloads",
    resourceGroups: ["model_serving_endpoints", "vector_search_endpoints", "vector_search_indexes"],
  },
  {
    id: "ai_gateway",
    name: "AI gateway services",
    column: "workloads",
    resourceGroups: ["model_services", "model_provider_services", "mcp_services"],
  },
  {
    id: "compute",
    name: "Compute",
    column: "uses",
    resourceGroups: ["sql_warehouses", "clusters", "instance_pools", "cluster_policies"],
  },
  { id: "secrets", name: "Secrets", column: "uses", resourceGroups: ["secret_scopes", "secrets"] },
  {
    id: "unity_catalog",
    name: "Unity Catalog data",
    column: "uses",
    resourceGroups: ["catalogs", "schemas", "volumes", "external_locations"],
  },
  {
    id: "data_quality",
    name: "Data quality",
    column: "uses",
    resourceGroups: ["quality_monitors", "data_quality_monitors"],
  },
  {
    id: "machine_learning",
    name: "Machine learning",
    column: "uses",
    resourceGroups: ["experiments", "models", "registered_models", "features", "feature_specs", "materialization_sets"],
  },
  {
    id: "lakebase",
    name: "Lakebase (Postgres)",
    column: "uses",
    resourceGroups: [
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
    ],
  },
];

/** Where a resource group the inspector does not know yet is shown, so it never goes missing. */
export const OTHER_GROUP: OverviewGroupDefinition = {
  id: "other",
  name: "Other resources",
  column: "uses",
  resourceGroups: [],
};

/**
 * Resource groups the inspector has checks for: the first table of docs/supported-resources.md.
 * A unit test keeps the two the same.
 */
export const CHECKED_RESOURCE_GROUPS: readonly string[] = ["jobs", "pipelines", "secret_scopes", "clusters"];

const GROUP_OF = new Map<string, OverviewGroupDefinition>(
  OVERVIEW_GROUPS.flatMap((group) => group.resourceGroups.map((name) => [name, group] as const)),
);

/** The overview group a bundle resource group is shown in. */
export function overviewGroupOf(resourceGroup: string): OverviewGroupDefinition {
  return GROUP_OF.get(resourceGroup) ?? OTHER_GROUP;
}

/**
 * Where a box's name comes from:
 * - `bundle`: a resource in this bundle.
 * - `job_cluster`: a cluster defined inside one job (`job_clusters`).
 * - `variable`, `fixed`, `default`, `workspace`: as in the Uses row, something named outside the bundle.
 * - `missing`: a `${resources.*}` reference to a resource the bundle does not have.
 */
export type OverviewSource = UsesSource | "job_cluster" | "missing";

export interface ProblemCounts {
  errors: number;
  warnings: number;
}

export interface OverviewItem {
  id: string;
  groupId: string;
  column: OverviewColumn;
  /** `job`, `pipeline`, `warehouse`, `cluster`, `secret_scope`, else the resource group's name. */
  kind: string;
  label: string;
  source: OverviewSource;
  /** The bundle resource group and key, for a resource in this bundle. */
  resourceGroup?: string;
  resourceKey?: string;
  /** The value as written, when it differs from the label. */
  expression?: string;
  /** Its id in the job's Uses row, when that differs from `id` (a job cluster). */
  usesId?: string;
  /** The job a job cluster belongs to. */
  definedIn?: string;
  /** True when the inspector has checks for this resource group. */
  hasChecks: boolean;
  /** Jobs only. */
  taskCount?: number;
  file?: string;
  line?: number;
  problems: ProblemCounts;
}

export interface OverviewLink {
  from: string;
  to: string;
  /** `runs`: a job task that runs a pipeline or another job. `uses`: everything else, such as a pipeline's schema. */
  kind: "uses" | "runs";
  /** The tasks of `from` that make the link, in graph order, when `from` is a job. */
  taskIds: string[];
  taskNames: string[];
}

export interface OverviewGroup {
  id: string;
  name: string;
  column: OverviewColumn;
  items: OverviewItem[];
}

export interface BundleOverview {
  /** Only the groups this bundle has, workloads first, each column in the order of OVERVIEW_GROUPS. */
  groups: OverviewGroup[];
  links: OverviewLink[];
  /** Problems that belong to no box: bundle-wide ones, and any on a resource the graph does not have. */
  bundleWide: ProblemCounts;
}

interface GraphNode {
  id: string;
  nodeType: string;
  displayName: string;
  parentId?: string;
  resourceGroup?: string;
  resourceKey?: string;
  taskCount?: number;
  sourceFile?: string;
  sourceLine?: number;
  data?: Record<string, unknown>;
}

interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  data?: Record<string, unknown>;
}

export interface OverviewGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface OverviewIssue {
  severity: string;
  taskId?: string;
  resourceId?: string;
}

const RESOURCE_REFERENCE = /^\$\{resources\.([^.}]+)\.([^.}]+)\.[^}]+\}$/;
const KIND_OF_RESOURCE_GROUP: Record<string, string> = {
  jobs: "job",
  pipelines: "pipeline",
  sql_warehouses: "warehouse",
  clusters: "cluster",
  secret_scopes: "secret_scope",
};
const RESOURCE_GROUP_OF_USES_KIND: Record<string, string> = {
  warehouse: "sql_warehouses",
  cluster: "clusters",
  secret_scope: "secret_scopes",
};

function problemTotal(problems: ProblemCounts): number {
  return problems.errors + problems.warnings;
}

/**
 * The overview for a bundle.
 *
 * @param resolve Turns an expression into its value for the shown target (identity if unknown).
 */
export function buildBundleOverview(
  graph: OverviewGraph,
  issues: readonly OverviewIssue[] = [],
  resolve: (value: string) => string = (value) => value,
): BundleOverview {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const items = new Map<string, OverviewItem>();
  const links = new Map<string, OverviewLink>();

  function addItem(item: Omit<OverviewItem, "problems" | "column" | "groupId">, group: OverviewGroupDefinition): void {
    if (items.has(item.id)) return;
    items.set(item.id, { ...item, groupId: group.id, column: group.column, problems: { errors: 0, warnings: 0 } });
  }

  function addLink(from: string, to: string, kind: OverviewLink["kind"], taskIds: string[], taskNames: string[]): void {
    if (from === to || !items.has(from) || !items.has(to)) return;
    const key = `${from}\u0000${to}`;
    const link = links.get(key);
    if (!link) {
      links.set(key, { from, to, kind, taskIds: [...taskIds], taskNames: [...taskNames] });
      return;
    }
    taskIds.forEach((taskId, index) => {
      if (link.taskIds.includes(taskId)) return;
      link.taskIds.push(taskId);
      link.taskNames.push(taskNames[index] ?? taskId);
    });
  }

  // 1. A box for every resource the bundle defines.
  for (const node of graph.nodes) {
    if (!node.resourceGroup || !node.resourceKey) continue;
    if (node.id !== `resources.${node.resourceGroup}.${node.resourceKey}`) continue;
    addItem(
      {
        id: node.id,
        kind: KIND_OF_RESOURCE_GROUP[node.resourceGroup] ?? node.resourceGroup,
        label: node.resourceKey,
        source: "bundle",
        resourceGroup: node.resourceGroup,
        resourceKey: node.resourceKey,
        hasChecks: CHECKED_RESOURCE_GROUPS.includes(node.resourceGroup),
        ...(node.nodeType === "job" && typeof node.taskCount === "number" ? { taskCount: node.taskCount } : {}),
        ...(node.sourceFile ? { file: node.sourceFile } : {}),
        ...(node.sourceLine ? { line: node.sourceLine } : {}),
      },
      overviewGroupOf(node.resourceGroup),
    );
  }
  const bundleItemIds = new Set(items.keys());

  /** The box for a secret scope node that is not a bundle resource: a scope the workspace has. */
  function workspaceScope(node: GraphNode): string {
    addItem(
      { id: node.id, kind: "secret_scope", label: node.displayName, source: "workspace", hasChecks: false },
      overviewGroupOf("secret_scopes"),
    );
    return node.id;
  }

  // 2. What each job's tasks use: the same items as the job's Uses row.
  const jobs = graph.nodes.filter((node) => node.nodeType === "job" && bundleItemIds.has(node.id));
  const taskNodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node.nodeType === "task" && node.parentId && bundleItemIds.has(node.parentId)) taskNodes.set(node.id, node);
  }
  for (const job of jobs) {
    for (const use of buildJobUses(graph, job.id, resolve)) {
      const group = overviewGroupOf(RESOURCE_GROUP_OF_USES_KIND[use.kind]!);
      const reference = use.expression ? RESOURCE_REFERENCE.exec(use.expression) : null;
      let to: string;
      if (reference) {
        // A `${resources.<group>.<key>.*}` reference: the bundle's own box, or one for a resource it lacks.
        to = `resources.${reference[1]}.${reference[2]}`;
        addItem(
          { id: to, kind: use.kind, label: reference[2]!, source: "missing", expression: use.expression!, hasChecks: false },
          overviewGroupOf(reference[1]!),
        );
      } else if (use.jobCluster) {
        // Two jobs can each have a job cluster with the same key. They are different clusters.
        to = `${job.id}.job_clusters.${use.label}`;
        addItem(
          { id: to, kind: "cluster", label: use.label, source: "job_cluster", definedIn: job.id, usesId: use.id, hasChecks: false },
          group,
        );
      } else if (bundleItemIds.has(use.id)) {
        to = use.id;
      } else {
        to = use.id;
        addItem(
          {
            id: to,
            kind: use.kind,
            label: use.label,
            source: use.source,
            ...(use.expression ? { expression: use.expression } : {}),
            hasChecks: false,
          },
          group,
        );
      }
      addLink(job.id, to, "uses", use.taskIds, use.taskNames);
    }
  }

  // 3. Other links the graph already has between two boxes.
  for (const edge of graph.edges) {
    if (edge.kind !== "references" && edge.kind !== "uses") continue;
    const target = nodeById.get(edge.target);
    const task = taskNodes.get(edge.source);
    if (task) {
      // A task that points at another resource of the bundle, such as the pipeline or job it runs.
      if (!bundleItemIds.has(edge.target)) continue;
      const kind = items.get(edge.target)!.column === "workloads" ? "runs" : "uses";
      addLink(task.parentId!, edge.target, kind, [task.id], [task.displayName]);
      continue;
    }
    // A pipeline naming another resource with `${resources.*}`, such as the schema it writes to.
    // Secret scope links are left to the step below.
    const reference =
      edge.kind === "references" &&
      target?.nodeType !== "secret_scope" &&
      bundleItemIds.has(edge.source) &&
      edge.source.startsWith("resources.pipelines.")
        ? /^resources\.([^.]+)\.([^.]+)$/.exec(edge.target)
        : null;
    if (reference) {
      if (!items.has(edge.target)) {
        const expression = typeof edge.data?.expression === "string" ? edge.data.expression : undefined;
        addItem(
          {
            id: edge.target,
            kind: KIND_OF_RESOURCE_GROUP[reference[1]!] ?? reference[1]!,
            label: reference[2]!,
            source: "missing",
            ...(expression ? { expression } : {}),
            hasChecks: false,
          },
          overviewGroupOf(reference[1]!),
        );
      }
      addLink(edge.source, edge.target, "uses", [], []);
      continue;
    }
    // A resource that is not a job, such as a pipeline or a cluster, reading a secret scope.
    if (!bundleItemIds.has(edge.source) || target?.nodeType !== "secret_scope") continue;
    addLink(edge.source, bundleItemIds.has(target.id) ? target.id : workspaceScope(target), "uses", [], []);
  }

  // 4. Problems, counted on the box they belong to. A task's problem counts on its job.
  const bundleWide: ProblemCounts = { errors: 0, warnings: 0 };
  for (const issue of issues) {
    if (issue.severity !== "error" && issue.severity !== "warning") continue;
    const ownerId = issue.taskId ? nodeById.get(issue.taskId)?.parentId : issue.resourceId;
    const counts = (ownerId ? items.get(ownerId)?.problems : undefined) ?? bundleWide;
    if (issue.severity === "error") counts.errors += 1;
    else counts.warnings += 1;
  }

  // Task order inside a link follows the job's graph order.
  const taskOrder = new Map([...taskNodes.keys()].map((id, index) => [id, index]));
  for (const link of links.values()) {
    const pairs = link.taskIds
      .map((id, index) => ({ id, name: link.taskNames[index]! }))
      .sort((a, b) => (taskOrder.get(a.id) ?? 0) - (taskOrder.get(b.id) ?? 0));
    link.taskIds = pairs.map((pair) => pair.id);
    link.taskNames = pairs.map((pair) => pair.name);
  }

  const groups: OverviewGroup[] = [];
  for (const column of ["workloads", "uses"] as const) {
    for (const definition of [...OVERVIEW_GROUPS, OTHER_GROUP]) {
      if (definition.column !== column) continue;
      const order = (item: OverviewItem) => {
        // Job clusters and things named outside the bundle come after the bundle's own resources.
        if (item.source !== "bundle") return definition.resourceGroups.length + (item.source === "job_cluster" ? 1 : 0);
        const at = definition.resourceGroups.indexOf(item.resourceGroup ?? "");
        return at < 0 ? definition.resourceGroups.length : at;
      };
      const groupItems = [...items.values()]
        .filter((item) => item.groupId === definition.id)
        .sort(
          (a, b) =>
            order(a) - order(b) ||
            Number(problemTotal(b.problems) > 0) - Number(problemTotal(a.problems) > 0) ||
            a.label.localeCompare(b.label) ||
            a.id.localeCompare(b.id),
        );
      if (groupItems.length > 0) {
        groups.push({ id: definition.id, name: definition.name, column, items: groupItems });
      }
    }
  }

  return {
    groups,
    links: [...links.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    bundleWide,
  };
}
