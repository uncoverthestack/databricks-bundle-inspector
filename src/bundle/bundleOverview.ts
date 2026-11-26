/**
 * The bundle overview: every resource in the bundle as a box, in two columns, with the
 * links between them. Built from the graph the extension sends, so it shows only what the
 * bundle says. Left column: what runs or shows something. Right column: what those use.
 */
import { featureScheduleWords, scheduleWords, syncModeWords, type JobTriggerWords } from "./jobTrigger.js";
import { buildJobUses, computeName, type UsesSource } from "./jobUses.js";
import { clusterSettings, jobOwnSettings, serverlessSettings, warehouseSettings, type ComputeSettings } from "./computeSettings.js";
import { buildLakebaseProjects } from "./lakebaseBranches.js";

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
    // Databricks' own name for model, model provider and MCP services (docs.databricks.com/unity-gateway, issue 425).
    id: "ai_gateway",
    name: "Unity Gateway",
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
  /** A job's schedule or trigger (issue 733), or an alert's or a monitor's schedule (issue 541), in words. */
  trigger?: JobTriggerWords;
  file?: string;
  line?: number;
  problems: ProblemCounts;
  /** A compute box's settings for its details (issue 417), when the bundle sets any. */
  settings?: ComputeSettings;
  /**
   * Secrets its code reads with a scope set at run time (issue 535). Listed in its details, never a
   * box: one box would join every job that has one, and nobody knows if the scopes are the same.
   */
  runtimeSecrets?: Array<{ label: string; taskNames: string[] }>;
  /** A Lakebase project's branches in words (issue 543): `4 branches`. The page splits the count. */
  branchWords?: string;
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
  triggerWords?: JobTriggerWords;
  sourceFile?: string;
  sourceLine?: number;
  fieldLines?: Record<string, number>;
  data?: Record<string, unknown>;
  pipelineRuntimeSecrets?: Array<{ file: string; line: number }>;
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
/** The kind of a box from a bundle resource group; any group not listed keeps its own name. */
export const KIND_OF_RESOURCE_GROUP: Record<string, string> = {
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

/**
 * Groups an app can name that are not bundle resource groups (#446): Unity Catalog tables,
 * functions and connections. Their dashed boxes go with the bundle's Unity Catalog data.
 */
const OUTSIDE_ONLY_GROUPS: Record<string, string> = { tables: "unity_catalog", functions: "unity_catalog", connections: "unity_catalog" };

/** The overview group of a box named outside the bundle. */
function outsideGroupOf(node: GraphNode): OverviewGroupDefinition {
  if (node.nodeType === "warehouse") return overviewGroupOf("sql_warehouses");
  if (node.nodeType === "schema") return overviewGroupOf("schemas");
  const group = String(node.data?.group ?? "");
  const groupId = OUTSIDE_ONLY_GROUPS[group];
  return groupId ? OVERVIEW_GROUPS.find((definition) => definition.id === groupId)! : overviewGroupOf(group);
}

/** The box for a warehouse, schema or other resource named outside the bundle, as a job's Uses row names it. */
function outsideItem(node: GraphNode, resolve: (value: string) => string): Omit<OverviewItem, "problems" | "column" | "groupId"> {
  if (node.nodeType === "warehouse") {
    const name = computeName(node, resolve);
    return { id: node.id, kind: "warehouse", label: name.label, source: name.source, ...(name.expression ? { expression: name.expression } : {}), hasChecks: false };
  }
  const expression = typeof node.data?.expression === "string" ? node.data.expression : undefined;
  const label = expression ? resolve(expression) : node.displayName;
  return {
    id: node.id,
    kind: node.nodeType === "named" ? String(node.data?.group) : "schemas",
    label,
    source: expression && /\$\{var\./.test(expression) ? "variable" : "fixed",
    ...(expression ? { expression } : {}),
    hasChecks: false,
  };
}

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
        ...(node.nodeType === "job" && node.triggerWords ? { trigger: node.triggerWords } : {}),
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
      if (use.source === "runtime") {
        const item = items.get(job.id)!;
        (item.runtimeSecrets ??= []).push({ label: use.label, taskNames: use.taskNames });
        continue;
      }
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
    // A warehouse, schema or other resource a resource names by a plain name, ID or variable:
    // a dashed box, shared with anything else naming the same one (#423 follow-up, #446).
    if (
      edge.kind === "uses" &&
      target &&
      (target.nodeType === "warehouse" || target.nodeType === "schema" || target.nodeType === "named") &&
      bundleItemIds.has(edge.source) &&
      !edge.source.startsWith("resources.jobs.")
    ) {
      if (!items.has(target.id)) addItem(outsideItem(target, resolve), outsideGroupOf(target));
      addLink(edge.source, target.id, "uses", [], []);
      continue;
    }
    // A resource naming another with `${resources.*}`, such as a pipeline's schema or a
    // dashboard's warehouse (#403, #423). Jobs link through their tasks, above; secret scope
    // links are left to the step below.
    const reference =
      edge.kind === "references" &&
      target?.nodeType !== "secret_scope" &&
      bundleItemIds.has(edge.source) &&
      /^resources\.[^.]+\.[^.]+$/.test(edge.source) &&
      !edge.source.startsWith("resources.jobs.")
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

  // A pipeline's code has no parameters to name a scope, so one it doesn't name is set at run time.
  for (const node of graph.nodes) {
    const item = items.get(node.id);
    if (node.resourceGroup === "pipelines" && item && node.pipelineRuntimeSecrets?.length) {
      item.runtimeSecrets = [{ label: "Set at run time", taskNames: [] }];
    }
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

  // A Lakebase project's branches, and what they hold, are shown on its own page (issue 543):
  // their boxes fold into the project's, which takes their lines and problem counts.
  for (const project of buildLakebaseProjects(graph.nodes, graph.edges, resolve)) {
    const projectItem = items.get(project.id);
    if (!projectItem) continue;
    const count = project.tree.length + project.fromSnapshot.length;
    projectItem.branchWords = `${count} branch${count === 1 ? "" : "es"}`;
    const folded = new Set(project.memberIds.filter((id) => items.has(id)));
    if (folded.size === 0) continue;
    for (const id of folded) {
      const item = items.get(id)!;
      projectItem.problems.errors += item.problems.errors;
      projectItem.problems.warnings += item.problems.warnings;
      items.delete(id);
    }
    for (const [key, link] of [...links]) {
      if (!folded.has(link.from) && !folded.has(link.to)) continue;
      links.delete(key);
      const from = folded.has(link.from) ? project.id : link.from;
      const to = folded.has(link.to) ? project.id : link.to;
      addLink(from, to, link.kind, link.taskIds, link.taskNames);
    }
  }

  // An alert's or a monitor's schedule in words (issue 541), as a job's (issue 733).
  for (const item of items.values()) {
    if (item.source !== "bundle" || !item.resourceGroup) continue;
    const words = resourceScheduleWords(item.resourceGroup, nodeById.get(item.id)?.data ?? {});
    if (words) item.trigger = words;
  }

  // 5. A compute box's settings, from the resolved config, with the lines they are written on.
  for (const item of items.values()) {
    const settings = settingsOf(item);
    if (settings && (settings.sections.length > 0 || settings.alsoSet.length > 0)) item.settings = settings;
  }
  function settingsOf(item: OverviewItem): ComputeSettings | undefined {
    if (item.source === "bundle") {
      const node = nodeById.get(item.id);
      const config = node?.data ?? {};
      if (item.resourceGroup === "sql_warehouses") return warehouseSettings(config, resolve, node?.fieldLines, node?.sourceFile);
      if (item.resourceGroup === "clusters") return clusterSettings(config, resolve, node?.fieldLines, node?.sourceFile);
      if (item.resourceGroup === "jobs") return jobOwnSettings(config, resolve, node?.fieldLines);
      return undefined;
    }
    if (item.source === "job_cluster" && item.definedIn) {
      const job = nodeById.get(item.definedIn);
      const jobClusters = Array.isArray(job?.data?.job_clusters) ? (job!.data!.job_clusters as unknown[]) : [];
      const jobCluster = jobClusters.find((entry) => (entry as Record<string, unknown>)?.job_cluster_key === item.label) as
        | Record<string, unknown>
        | undefined;
      const newCluster = jobCluster?.new_cluster;
      if (!newCluster || typeof newCluster !== "object") return undefined;
      return clusterSettings(newCluster as Record<string, unknown>, resolve, job?.fieldLines, job?.sourceFile, `job_clusters.${item.label}.`);
    }
    if (item.source === "default") {
      const jobsUsing = [...links.values()]
        .filter((link) => link.to === item.id)
        .flatMap((link) => {
          const job = nodeById.get(link.from);
          if (!job?.resourceKey || !job.data) return [];
          const prefix = `${job.id}.tasks.`;
          const taskKeys = link.taskIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
          return [{ jobKey: job.resourceKey, job: job.data, taskKeys }];
        });
      return serverlessSettings(jobsUsing, resolve);
    }
    return undefined;
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

/**
 * The schedule of an alert, a quality monitor or a data quality monitor (issue 541). A data
 * quality monitor's pause status is read-only, so it is never said.
 */
export function resourceScheduleWords(resourceGroup: string, data: Record<string, unknown>): JobTriggerWords | undefined {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const paused = (value: unknown) => typeof value === "string" && value.toUpperCase() === "PAUSED";
  const schedule =
    resourceGroup === "alerts" || resourceGroup === "quality_monitors"
      ? record(data.schedule)
      : resourceGroup === "data_quality_monitors"
        ? record(record(data.data_profiling_config).schedule)
        : undefined;
  if (resourceGroup === "postgres_synced_tables") return syncModeWords(data.scheduling_policy);
  if (resourceGroup === "synced_database_tables") return syncModeWords(record(data.spec).scheduling_policy);
  if (resourceGroup === "materialization_sets") return featureScheduleWords(data.materialized_features);
  if (!schedule) return undefined;
  // Alerts call it quartz_cron_schedule; monitors quartz_cron_expression.
  const cron = text(resourceGroup === "alerts" ? schedule.quartz_cron_schedule : schedule.quartz_cron_expression);
  if (!cron) return undefined;
  return scheduleWords(cron, text(schedule.timezone_id), resourceGroup !== "data_quality_monitors" && paused(schedule.pause_status));
}
