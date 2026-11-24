/**
 * The "Uses" row above a job's graph: each SQL warehouse, cluster and secret scope the
 * job's tasks use, with the tasks that use it. Built from the graph the extension sends,
 * so it shows only what the bundle says.
 */

import { runtimeSecretGroup, runtimeSecretLabel, taskRuntimeSecrets } from "./runtimeSecrets.js";

export type UsesKind = "warehouse" | "cluster" | "secret_scope";

/**
 * Where the name comes from:
 * - `bundle`: a resource in this bundle, or a cluster defined in the job itself.
 * - `variable`: a `${var.*}` value.
 * - `fixed`: an ID or name written in, which the inspector can't look up.
 * - `default`: no compute set, so the task gets serverless or inherited compute.
 * - `workspace`: a secret scope the bundle doesn't define.
 * - `runtime`: a secret scope the code reads without naming it, so it is set at run time (issue 535).
 */
export type UsesSource = "bundle" | "variable" | "fixed" | "default" | "workspace" | "runtime";

export interface UsesItem {
  id: string;
  kind: UsesKind;
  /** What the chip shows, such as `analytics`. */
  label: string;
  /** The value as written, when it differs from the label, for the tooltip. */
  expression?: string;
  source: UsesSource;
  /** Tasks in this job that use it, in graph order. */
  taskIds: string[];
  taskNames: string[];
  /** A cluster defined in the job itself (`job_clusters`), so it belongs to that job only. */
  jobCluster?: true;
  /** Secret scopes only: tasks whose code reads it by a parameter's default value (issue 535). */
  byDefault?: Array<{ taskId: string; parameter: string }>;
  /** Run-time scopes only: the reads it stands for. */
  reads?: Array<{ taskId: string; file?: string; line: number }>;
}

interface GraphNode {
  id: string;
  nodeType: string;
  displayName: string;
  parentId?: string;
  resourceGroup?: string;
  data?: Record<string, unknown>;
  taskData?: {
    taskParameterReferences?: Array<{ name: string; value?: string | undefined }> | undefined;
    jobParameterReferences?: Array<{ name: string; default?: string | undefined }> | undefined;
  };
}

interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface JobUsesGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const RESOURCE_REFERENCE = /^\$\{resources\.([^.}]+)\.([^.}]+)\.[^}]+\}$/;
const VARIABLE_REFERENCE = /^\$\{var\.[^}]+\}$/;
const KIND_ORDER: Record<UsesKind, number> = { warehouse: 0, cluster: 1, secret_scope: 2 };

/**
 * The chip's label and source for a cluster or warehouse node.
 *
 * @param resolve Turns a `${var.*}` expression into the value for the shown target, when known.
 */
export function computeName(
  node: GraphNode,
  resolve: (value: string) => string,
): { label: string; source: UsesSource; expression?: string; jobCluster?: true } {
  const expression = typeof node.data?.expression === "string" ? node.data.expression : undefined;
  if (node.data?.serverless === true) return { label: "Serverless or inherited", source: "default" };
  if (expression) {
    const resource = RESOURCE_REFERENCE.exec(expression);
    if (resource) return { label: resource[2]!, source: "bundle", expression };
    if (VARIABLE_REFERENCE.test(expression)) {
      const value = resolve(expression);
      return { label: value && value !== expression ? value : expression, source: "variable", expression };
    }
    return { label: resolve(expression), source: "fixed", expression };
  }
  // A job cluster, named by `job_cluster_key`, is defined in the job itself.
  if (node.data?.jobCluster === true) return { label: node.displayName, source: "bundle", jobCluster: true };
  return { label: node.displayName, source: "fixed" };
}

/**
 * The row's items for one job, warehouses first, then clusters, then secret scopes,
 * each sorted by label.
 *
 * @param resolve Turns an expression into its value for the shown target (identity if unknown).
 */
export function buildJobUses(
  graph: JobUsesGraph,
  jobId: string,
  resolve: (value: string) => string = (value) => value,
): UsesItem[] {
  const tasks = graph.nodes.filter((node) => node.nodeType === "task" && node.parentId === jobId);
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const items = new Map<string, UsesItem>();

  function add(node: GraphNode, kind: UsesKind, taskId: string): void {
    let item = items.get(node.id);
    if (!item) {
      const name =
        kind === "secret_scope"
          ? {
              label: node.displayName,
              source: (node.resourceGroup === "secret_scopes" || node.id.startsWith("resources.secret_scopes.")
                ? "bundle"
                : "workspace") as UsesSource,
            }
          : computeName(node, resolve);
      item = { id: node.id, kind, ...name, taskIds: [], taskNames: [] };
      items.set(node.id, item);
    }
    if (!item.taskIds.includes(taskId)) item.taskIds.push(taskId);
  }

  for (const edge of graph.edges) {
    if (!taskOrder.has(edge.source)) continue;
    const target = nodeById.get(edge.target);
    if (!target) continue;
    if (edge.kind === "uses" && target.nodeType === "warehouse") add(target, "warehouse", edge.source);
    else if (edge.kind === "uses" && target.nodeType === "cluster") add(target, "cluster", edge.source);
    else if (target.nodeType === "secret_scope") add(target, "secret_scope", edge.source);
    else if (target.nodeType === "file") {
      // A secret read in the task's code: task -> file -> scope.
      for (const fileEdge of graph.edges) {
        if (fileEdge.source !== target.id) continue;
        const scope = nodeById.get(fileEdge.target);
        if (scope?.nodeType === "secret_scope") add(scope, "secret_scope", edge.source);
      }
    }
  }

  // Secrets the code reads without naming the scope (issue 535): a scope a parameter gives by
  // default joins that scope's chip; one still unknown gets its own, shared only through a
  // job parameter, as no one knows whether two unknown scopes are the same.
  for (const task of tasks) {
    for (const read of taskRuntimeSecrets(graph, task.id, resolve, nodeById)) {
      if (read.scope) {
        // The bundle's own scope with that name, matched as the code's scope names are.
        const own = graph.nodes.find((node) => {
          if (node.resourceGroup !== "secret_scopes" || !node.id.startsWith("resources.secret_scopes.")) return false;
          const name = typeof node.data?.name === "string" ? node.data.name : node.id.slice("resources.secret_scopes.".length);
          return name === read.scope;
        });
        const id = own?.id ?? `secret:${read.scope}`;
        let item = items.get(id);
        if (!item) {
          item = { id, kind: "secret_scope", label: read.scope, source: own ? "bundle" : "workspace", taskIds: [], taskNames: [] };
          items.set(id, item);
        }
        if (!item.taskIds.includes(task.id)) item.taskIds.push(task.id);
        const byDefault = (item.byDefault ??= []);
        if (!byDefault.some((entry) => entry.taskId === task.id)) byDefault.push({ taskId: task.id, parameter: read.parameter! });
        continue;
      }
      const id = `runtime-secret:${runtimeSecretGroup(read)}`;
      let item = items.get(id);
      if (!item) {
        item = { id, kind: "secret_scope", label: runtimeSecretLabel(read), source: "runtime", taskIds: [], taskNames: [], reads: [] };
        items.set(id, item);
      }
      if (!item.taskIds.includes(task.id)) item.taskIds.push(task.id);
      item.reads!.push({ taskId: task.id, ...(read.file ? { file: read.file } : {}), line: read.line });
    }
  }

  const taskName = new Map(tasks.map((task) => [task.id, task.displayName]));
  return [...items.values()]
    .map((item) => {
      const taskIds = [...item.taskIds].sort((a, b) => taskOrder.get(a)! - taskOrder.get(b)!);
      return { ...item, taskIds, taskNames: taskIds.map((id) => taskName.get(id) ?? id) };
    })
    // Scopes set at run time come after the named ones.
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        Number(a.source === "runtime") - Number(b.source === "runtime") ||
        a.label.localeCompare(b.label),
    );
}
