import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildTaskNodeData,
  getTaskPayloadKey,
  getUnrecognisedTaskKey,
  type TaskNodeData,
  type TaskPayloadKey,
} from "../resources/task.js";
import {
  parseYamlLocations,
  type YamlLocationMap,
} from "../sourceLocations.js";
import type { BundleEdge, EdgeKind } from "./edges.js";
import { describeCronExpression } from "./cronDescription.js";

export type { BundleEdge, EdgeKind };

export type VariableValue = unknown;

export interface Variable {
  type?: "complex";
  default?: VariableValue;
  description?: string;
  value?: VariableValue;
  lookup?: Record<string, unknown>;
}

export type Variables = Record<string, Variable>;

export interface TargetConfig {
  variables?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface JobPermission {
  [key: string]: unknown;
}

export interface JobTaskDependency {
  task_key?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface JobTask {
  task_key?: string;
  depends_on?: JobTaskDependency[];
  clean_rooms_notebook_task?: {
    clean_room_name?: string;
    notebook_name?: string;
  };
  condition_task?: {
    op?: string;
    left?: string;
    right?: string;
  };
  dashboard_task?: {
    dashboard_id?: string;
    warehouse_id?: string;
  };
  alert_task?: {
    alert_id?: string;
    workspace_path?: string;
    warehouse_id?: string;
  };
  dbt_task?: {
    commands?: string[];
    warehouse_id?: string;
  };
  dbt_platform_task?: {
    connection_resource_name?: string;
    dbt_platform_job_id?: string;
  };
  for_each_task?: {
    inputs?: string;
  };
  spark_jar_task?: {
    main_class_name?: string;
  };
  notebook_task?: {
    notebook_path?: string;
  };
  pipeline_task?: {
    pipeline_id?: string;
  };
  power_bi_task?: {
    connection_resource_name?: string;
    warehouse_id?: string;
  };
  dbt_cloud_task?: {
    connection_resource_name?: string;
    dbt_cloud_job_id?: number | string;
  };
  ai_runtime_task?: {
    code_source_path?: string;
  };
  gen_ai_compute_task?: {
    training_script_path?: string;
    command?: string;
  };
  python_operator_task?: {
    main?: string;
  };
  sql_task?: {
    file?: {
      path?: string;
    };
    warehouse_id?: string;
  };
  spark_python_task?: {
    python_file?: string;
  };
  python_wheel_task?: {
    package_name?: string;
    entry_point?: string;
  };
  run_job_task?: {
    job_id?: string;
  };
  spark_submit_task?: {
    parameters?: string[];
  };
  job_cluster_key?: string;
  existing_cluster_id?: string;
  [key: string]: unknown;
}

export interface Job {
  name?: string;
  id?: string;
  url?: string;
  tasks?: JobTask[];
  job_clusters?: Array<{
    job_cluster_key?: string;
    new_cluster?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  permissions?: JobPermission[];
  parameters?: Array<{ name?: string; default?: string }>;
  schedule?: {
    quartz_cron_expression?: string;
    timezone_id?: string;
    pause_status?: string;
  };
  trigger?: {
    file_arrival?: {
      url?: string;
      min_time_between_triggers_seconds?: number;
      wait_after_last_change_seconds?: number;
    };
    table?: {
      table_names?: string[];
      condition?: string;
    };
    table_update?: {
      table_names?: string[];
      condition?: string;
      wait_after_last_change_seconds?: number;
    };
    periodic?: {
      interval?: number;
      unit?: string;
    };
    pause_status?: string;
    [key: string]: unknown;
  };
  run_as?: {
    service_principal_name?: string;
    user_name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Bundle {
  name: string;
  environment?: string;
  uuid?: string;
  mode?: string;
  target?: string;
}

export interface Sync {
  paths?: string[];
  include?: string[];
  exclude?: string[];
}

export interface Resources {
  jobs?: Record<string, Job>;
  pipelines?: Record<string, unknown>;
  models?: Record<string, unknown>;
  experiments?: Record<string, unknown>;
  model_serving_endpoints?: Record<string, unknown>;
  registered_models?: Record<string, unknown>;
  quality_monitors?: Record<string, unknown>;
  catalogs?: Record<string, unknown>;
  schemas?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  external_locations?: Record<string, unknown>;
  clusters?: Record<string, unknown>;
  dashboards?: Record<string, unknown>;
  apps?: Record<string, unknown>;
  secret_scopes?: Record<string, unknown>;
  alerts?: Record<string, unknown>;
  sql_warehouses?: Record<string, unknown>;
  database_instances?: Record<string, unknown>;
  database_catalogs?: Record<string, unknown>;
  synced_database_tables?: Record<string, unknown>;
  postgres_projects?: Record<string, unknown>;
  postgres_branches?: Record<string, unknown>;
  postgres_endpoints?: Record<string, unknown>;
}

/** Resource groups the inspector models. Checked against the CLI schema by the schema coverage test. */
export const MODELLED_RESOURCE_GROUPS = [
  "jobs",
  "pipelines",
  "models",
  "experiments",
  "model_serving_endpoints",
  "registered_models",
  "quality_monitors",
  "catalogs",
  "schemas",
  "volumes",
  "external_locations",
  "clusters",
  "dashboards",
  "apps",
  "secret_scopes",
  "alerts",
  "sql_warehouses",
  "database_instances",
  "database_catalogs",
  "synced_database_tables",
  "postgres_projects",
  "postgres_branches",
  "postgres_endpoints",
] as const satisfies ReadonlyArray<keyof Resources>;

export interface ParsedBundleConfig {
  bundle: Bundle;
  sync?: Sync;
  variables?: Variables;
  targets?: Record<string, TargetConfig>;
  resources?: Resources;
  artifacts?: Record<string, unknown>;
  include?: string[];
  workspace?: Record<string, unknown>;
}

export interface ResourceNode {
  id: string;
  resourceGroup: string;
  resourceKey: string;
  displayName: string;
  data: Record<string, unknown>;
}

export interface GraphParameter {
  name: string;
  value: string;
  expression?: string;
}

export interface GraphCompute {
  kind: string;
  label: string;
  expression?: string;
  variableName?: string;
  details?: GraphComputeDetail[];
}

export interface GraphComputeDetail {
  label: string;
  value: string;
  expression?: string;
}

export type BundleNodeType =
  | "job"
  | "task"
  | "resource"
  | "variable"
  | "file"
  | "library"
  | "cluster"
  | "warehouse"
  | "secret_scope"
  | "widget";

export interface BundleGraphNode {
  id: string;
  kind: string;
  nodeType: BundleNodeType;
  displayName: string;
  location?: "local" | "workspace" | "dbfs";
  taskTypeLabel?: string;
  subtitle?: string;
  status?: string;
  trigger?: string;
  triggerTooltip?: string;
  runAs?: string;
  taskCount?: number;
  parameters?: GraphParameter[];
  compute?: GraphCompute[];
  resourceGroup?: string;
  resourceKey?: string;
  taskKey?: string;
  parentId?: string;
  hasMissingFile?: boolean;
  data: Record<string, unknown>;
  taskData?: TaskNodeData;
}

/** @deprecated use BundleEdge from edges.ts — kept for callers that destructure relationship */
export interface BundleGraphEdge extends BundleEdge {}

export interface BundleGraph {
  nodes: BundleGraphNode[];
  edges: BundleEdge[];
}

// --- helpers ---

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function getResourceDisplayName(
  resourceGroup: string,
  resourceKey: string,
  resourceData: Record<string, unknown>,
): string {
  if (resourceGroup === "secret_scopes") return resourceKey;
  return typeof resourceData.name === "string" ? resourceData.name : resourceKey;
}

function resourceKind(resourceGroup: string): string {
  if (resourceGroup === "secret_scopes") return "secret_scope";
  return resourceGroup.replace(/s$/, "");
}

function resourceNodeType(resourceGroup: string): BundleNodeType {
  if (resourceGroup === "secret_scopes") return "secret_scope";
  return "resource";
}

function normalizeReference(value: string): string {
  const variableReference = value.match(/^\$\{var\.([^}]+)\}$/);
  if (variableReference?.[1]) {
    return variableReference[1];
  }
  return value;
}

function computeReference(value: string): Partial<GraphCompute> {
  const variableReference = value.match(/^\$\{var\.([^}]+)\}$/);
  if (variableReference?.[1]) {
    return { expression: value, variableName: variableReference[1] };
  }
  return value.includes("${") ? { expression: value } : {};
}

function resourceReference(value: string): {
  resourceType: string;
  resourceKey: string;
  field: string;
} | undefined {
  const match = value.match(/^\$\{resources\.([^.}]+)\.([^.}]+)\.([^}]+)\}$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    resourceType: match[1],
    resourceKey: match[2],
    field: match[3],
  };
}

function normalizeDependencyOutcome(outcome: unknown): string | undefined {
  if (typeof outcome !== "string") return undefined;
  const normalized = outcome.trim();
  return normalized.length > 0 ? normalized : undefined;
}

const CONDITION_OPERATOR_LABELS: Record<
  string,
  { symbol: string; label: string }
> = {
  EQUAL_TO: { symbol: "==", label: "Equal to" },
  NOT_EQUAL: { symbol: "!=", label: "Not equal" },
  GREATER_THAN: { symbol: ">", label: "Greater than" },
  GREATER_THAN_OR_EQUAL: {
    symbol: ">=",
    label: "Greater than or equal",
  },
  LESS_THAN: { symbol: "<", label: "Less than" },
  LESS_THAN_OR_EQUAL: { symbol: "<=", label: "Less than or equal" },
};

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function conditionExpression(
  condition: JobTask["condition_task"],
): string | undefined {
  const left = typeof condition?.left === "string" ? condition.left : undefined;
  const op = normalizedString(condition?.op);
  const right = typeof condition?.right === "string" ? condition.right : undefined;
  const operator = op ? CONDITION_OPERATOR_LABELS[op] : undefined;
  const symbol = operator?.symbol ?? op;
  const label = operator?.label;
  const operatorText = [symbol, label].filter(Boolean).join(" ");

  if (left !== undefined && symbol && right !== undefined) {
    const leftDisplay = left || '""';
    const rightDisplay = right || '""';
    return label
      ? `${leftDisplay} ${symbol} ${rightDisplay} - ${label}`
      : `${leftDisplay} ${symbol} ${rightDisplay}`;
  }
  return operatorText || undefined;
}

function withOptionalSubtitle(
  kind: string,
  label: string,
  subtitle?: string,
): { kind: string; label: string; subtitle?: string } {
  return { kind, label, ...(subtitle ? { subtitle } : {}) };
}

type TaskPresentation = { kind: string; label: string; subtitle?: string };

// Keyed by every recognised payload key, so adding a task type in task.ts fails
// to compile until it has a label here.
const TASK_PRESENTATION: Record<TaskPayloadKey, (task: JobTask) => TaskPresentation> = {
  clean_rooms_notebook_task: (task) =>
    withOptionalSubtitle("notebook", "Clean room", task.clean_rooms_notebook_task?.notebook_name),
  condition_task: (task) =>
    withOptionalSubtitle("job", "If/else", task.condition_task ? conditionExpression(task.condition_task) : undefined),
  dashboard_task: (task) => withOptionalSubtitle("dashboard", "Dashboards", task.dashboard_task?.dashboard_id),
  alert_task: (task) =>
    withOptionalSubtitle("alert", "Alert", task.alert_task?.workspace_path ?? task.alert_task?.alert_id),
  dbt_task: (task) => withOptionalSubtitle("script", "dbt", task.dbt_task?.commands?.join(" ")),
  dbt_platform_task: (task) =>
    withOptionalSubtitle("script", "dbt platform (Beta)", task.dbt_platform_task?.dbt_platform_job_id),
  dbt_cloud_task: (task) =>
    withOptionalSubtitle(
      "script",
      "dbt Cloud",
      task.dbt_cloud_task?.dbt_cloud_job_id !== undefined ? String(task.dbt_cloud_task.dbt_cloud_job_id) : undefined,
    ),
  for_each_task: (task) => withOptionalSubtitle("job", "For each", task.for_each_task?.inputs),
  spark_jar_task: (task) => withOptionalSubtitle("script", "JAR", task.spark_jar_task?.main_class_name),
  notebook_task: (task) => withOptionalSubtitle("notebook", "Notebook", task.notebook_task?.notebook_path),
  pipeline_task: (task) =>
    withOptionalSubtitle(
      "pipeline",
      "Pipeline",
      task.pipeline_task?.pipeline_id ? normalizeReference(task.pipeline_task.pipeline_id) : undefined,
    ),
  power_bi_task: (task) =>
    withOptionalSubtitle("dashboard", "Power BI", task.power_bi_task?.connection_resource_name),
  spark_python_task: (task) =>
    withOptionalSubtitle("script", "Python script", task.spark_python_task?.python_file),
  python_wheel_task: (task) =>
    withOptionalSubtitle("script", "Python wheel", task.python_wheel_task?.package_name),
  run_job_task: (task) => withOptionalSubtitle("job", "Run Job", task.run_job_task?.job_id),
  sql_task: (task) => withOptionalSubtitle("sql", "SQL", task.sql_task?.file?.path),
  spark_submit_task: (task) =>
    withOptionalSubtitle("script", "Spark Submit", task.spark_submit_task?.parameters?.join(" ")),
  ai_runtime_task: (task) =>
    withOptionalSubtitle("script", "AI Runtime", task.ai_runtime_task?.code_source_path),
  gen_ai_compute_task: (task) =>
    withOptionalSubtitle(
      "script",
      "Gen AI compute",
      task.gen_ai_compute_task?.training_script_path ?? task.gen_ai_compute_task?.command,
    ),
  python_operator_task: (task) =>
    withOptionalSubtitle("script", "Python operator", task.python_operator_task?.main),
};

function detectTaskType(task: JobTask): TaskPresentation {
  const payloadKey = getTaskPayloadKey(task);
  if (payloadKey) return TASK_PRESENTATION[payloadKey](task);
  // Show an unrecognised task type by its key rather than as an anonymous task.
  return { kind: "job", label: "Task", subtitle: getUnrecognisedTaskKey(task) ?? "Other task settings" };
}

function formatTrigger(job: Job): string {
  if (job.schedule?.quartz_cron_expression) {
    const tz = job.schedule.timezone_id ? ` (${job.schedule.timezone_id})` : "";
    const pauseStatus = job.schedule.pause_status
      ? ` - ${job.schedule.pause_status}`
      : "";
    return `Schedule: ${job.schedule.quartz_cron_expression}${tz}${pauseStatus}`;
  }
  const trigger = job.trigger;
  if (!trigger) return "Not specified";
  if (trigger.file_arrival?.url) {
    return `File arrival: ${trigger.file_arrival.url}`;
  }
  if (trigger.table_update?.table_names?.length) {
    return `Table update: ${trigger.table_update.table_names.join(", ")}`;
  }
  if (trigger.table?.table_names?.length) {
    return `Table: ${trigger.table.table_names.join(", ")}`;
  }
  if (trigger.periodic?.interval && trigger.periodic.unit) {
    const { interval, unit } = trigger.periodic;
    const unitLabel = interval === 1 ? unit.slice(0, -1) : unit;
    return `Every ${interval} ${unitLabel.toLowerCase()}`;
  }
  return "Not specified";
}

function formatRunAs(job: Job): string {
  if (job.run_as?.service_principal_name) {
    return `Service Principal / ${job.run_as.service_principal_name}`;
  }
  if (job.run_as?.user_name) {
    return `User / ${job.run_as.user_name}`;
  }
  return "Not specified";
}

function getParameterSummary(job: Job): GraphParameter[] {
  return (job.parameters ?? [])
    .filter((parameter) => typeof parameter.name === "string")
    .slice(0, 3)
    .map((parameter) => ({
      name: parameter.name ?? "parameter",
      value: typeof parameter.default === "string" ? normalizeReference(parameter.default) : "set",
      ...(typeof parameter.default === "string" &&
      parameter.default.includes("${")
        ? { expression: parameter.default }
        : {}),
    }));
}

function stringifyParameterValue(value: unknown): Omit<GraphParameter, "name"> {
  if (typeof value === "string") {
    return {
      value: normalizeReference(value),
      ...(value.includes("${") ? { expression: value } : {}),
    };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value: String(value) };
  }
  if (Array.isArray(value)) {
    return { value: value.map((item) => stringifyParameterValue(item).value).join(", ") };
  }
  if (typeof value === "object" && value !== null) return { value: JSON.stringify(value) };
  return { value: "set" };
}

function computeDetail(
  label: string,
  value: unknown,
): GraphComputeDetail | undefined {
  if (value === undefined) return undefined;
  const data = stringifyParameterValue(value);
  return { label, ...data };
}

function clusterDetails(
  cluster: Record<string, unknown> | undefined,
): GraphComputeDetail[] | undefined {
  if (!cluster) return undefined;

  const autoscale =
    typeof cluster.autoscale === "object" &&
    cluster.autoscale !== null &&
    !Array.isArray(cluster.autoscale)
      ? (cluster.autoscale as Record<string, unknown>)
      : undefined;
  const autoscaleValue = autoscale
    ? `${String(autoscale.min_workers ?? "?")} - ${String(
        autoscale.max_workers ?? "?",
      )} workers`
    : undefined;

  return [
    computeDetail("Spark", cluster.spark_version),
    computeDetail("Node type", cluster.node_type_id),
    computeDetail("Workers", cluster.num_workers),
    computeDetail("Autoscale", autoscaleValue),
    computeDetail("Security", cluster.data_security_mode),
    computeDetail("Runtime", cluster.runtime_engine),
    computeDetail("Policy", cluster.policy_id),
  ].filter((item): item is GraphComputeDetail => Boolean(item));
}

function getJobClusterDetails(
  job: Job | undefined,
  jobClusterKey: string,
): GraphComputeDetail[] | undefined {
  const jobCluster = (job?.job_clusters ?? []).find(
    (cluster) => cluster.job_cluster_key === jobClusterKey,
  );
  return clusterDetails(jobCluster?.new_cluster);
}

function pipelineDetails(
  pipeline: Record<string, unknown> | undefined,
): GraphComputeDetail[] | undefined {
  if (!pipeline) return undefined;
  const clusters = Array.isArray(pipeline.clusters)
    ? (pipeline.clusters as Array<Record<string, unknown>>)
    : [];
  const defaultCluster = clusters[0];
  const defaultClusterDetails = clusterDetails(defaultCluster) ?? [];

  return [
    computeDetail("Name", pipeline.name),
    computeDetail("Catalog", pipeline.catalog),
    computeDetail("Schema", pipeline.schema ?? pipeline.target),
    computeDetail("Channel", pipeline.channel),
    computeDetail("Edition", pipeline.edition),
    computeDetail("Photon", pipeline.photon),
    computeDetail("Serverless", pipeline.serverless),
    computeDetail("Development", pipeline.development),
    computeDetail("Cluster", defaultCluster?.label),
    ...defaultClusterDetails,
  ].filter((item): item is GraphComputeDetail => Boolean(item));
}

function getTaskPayload(task: JobTask): Record<string, unknown> | null {
  const payloadKey = getTaskPayloadKey(task);
  return payloadKey ? (task[payloadKey] as Record<string, unknown>) : null;
}

function getEffectiveTaskParameters(job: Job, task: JobTask): GraphParameter[] | undefined {
  const mergedParameters = new Map<string, Omit<GraphParameter, "name">>();

  // Task base_parameters are set first so that job parameters can override them.
  // Job parameters take precedence over task parameters (Databricks runtime behaviour).
  const taskPayload = getTaskPayload(task);
  const taskBaseParameters =
    taskPayload && typeof taskPayload.base_parameters === "object" && taskPayload.base_parameters !== null
      ? (taskPayload.base_parameters as Record<string, unknown>)
      : null;

  if (taskBaseParameters) {
    for (const [parameterName, parameterValue] of Object.entries(taskBaseParameters)) {
      mergedParameters.set(parameterName, stringifyParameterValue(parameterValue));
    }
  }

  for (const parameter of job.parameters ?? []) {
    if (typeof parameter.name !== "string") continue;
    mergedParameters.set(parameter.name, stringifyParameterValue(parameter.default));
  }

  if (mergedParameters.size === 0) return undefined;

  return [...mergedParameters.entries()].map(([name, data]) => ({ name, ...data }));
}

const DEFAULT_CLUSTER_COMPUTE_LABEL = "Serverless / inherited compute";
const DEFAULT_SQL_WAREHOUSE_LABEL = "Serverless / inherited SQL warehouse";

/** Returns true for task types that run on cluster/serverless compute when none is specified. */
function requiresClusterCompute(task: JobTask): boolean {
  return !!(
    task.notebook_task ||
    task.spark_python_task ||
    task.spark_jar_task ||
    task.spark_submit_task ||
    task.python_wheel_task ||
    task.pipeline_task ||
    task.clean_rooms_notebook_task
  );
}

/** Returns true for task types that run on SQL warehouse compute when none is specified. */
function requiresSqlWarehouseCompute(task: JobTask): boolean {
  return !!(
    task.sql_task ||
    task.dbt_task ||
    task.dashboard_task
  );
}

function getTaskCompute(
  task: JobTask,
  job?: Job,
  resources?: Resources,
): GraphCompute[] {
  const compute: GraphCompute[] = [];

  if (task.sql_task?.warehouse_id) {
    compute.push({
      kind: "sqlWarehouse",
      label: normalizeReference(task.sql_task.warehouse_id),
      ...computeReference(task.sql_task.warehouse_id),
    });
  }
  if (task.dbt_task?.warehouse_id) {
    compute.push({
      kind: "sqlWarehouse",
      label: normalizeReference(task.dbt_task.warehouse_id),
      ...computeReference(task.dbt_task.warehouse_id),
    });
  }
  if (task.dashboard_task?.warehouse_id) {
    compute.push({
      kind: "sqlWarehouse",
      label: normalizeReference(task.dashboard_task.warehouse_id),
      ...computeReference(task.dashboard_task.warehouse_id),
    });
  }
  if (task.job_cluster_key) {
    const details = getJobClusterDetails(job, task.job_cluster_key);
    compute.push({
      kind: "cluster",
      label: task.job_cluster_key,
      ...(details ? { details } : {}),
    });
  }
  if (task.existing_cluster_id) {
    const ref = resourceReference(task.existing_cluster_id);
    const cluster =
      ref?.resourceType === "clusters"
        ? toRecord(resources?.clusters?.[ref.resourceKey])
        : undefined;
    const details = clusterDetails(cluster);
    compute.push({
      kind: "cluster",
      label:
        ref?.resourceType === "clusters"
          ? ref.resourceKey
          : normalizeReference(task.existing_cluster_id),
      ...computeReference(task.existing_cluster_id),
      ...(details ? { details } : {}),
    });
  }
  if (task.pipeline_task?.pipeline_id) {
    const ref = resourceReference(task.pipeline_task.pipeline_id);
    const pipeline =
      ref?.resourceType === "pipelines"
        ? toRecord(resources?.pipelines?.[ref.resourceKey])
        : undefined;
    const details = pipelineDetails(pipeline);
    if (details) {
      compute.push({
        kind: "pipeline",
        label: ref?.resourceKey ?? normalizeReference(task.pipeline_task.pipeline_id),
        ...computeReference(task.pipeline_task.pipeline_id),
        details,
      });
    }
  }

  if (compute.length === 0 && requiresSqlWarehouseCompute(task)) {
    compute.push({ kind: "sqlWarehouse", label: DEFAULT_SQL_WAREHOUSE_LABEL });
  }
  if (compute.length === 0 && requiresClusterCompute(task)) {
    compute.push({ kind: "cluster", label: DEFAULT_CLUSTER_COMPUTE_LABEL });
  }

  return compute;
}

function getJobComputeSummary(
  job: Job,
  tasks: JobTask[],
  resources?: Resources,
): GraphCompute[] {
  const computeMap = new Map<string, GraphCompute>();
  tasks.forEach((task) => {
    getTaskCompute(task, job, resources).forEach((item) => {
      computeMap.set(`${item.kind}:${item.label}`, item);
    });
  });

  return [...computeMap.values()];
}

function fileLocation(rawPath: string, resolvedPath: string | undefined): "local" | "workspace" | "dbfs" {
  if (resolvedPath) return "local";
  if (rawPath.startsWith("/Workspace/")) return "workspace";
  return "dbfs";
}

function fileDisplayName(rawPath: string): string {
  return rawPath.split("/").pop() ?? rawPath;
}

/** Adds reference, uses, and compute nodes+edges for a single task. */
function addTaskReferenceGraph(
  taskId: string,
  taskData: TaskNodeData,
  task: JobTask,
  job: Job,
  resources: Resources | undefined,
  addNode: (node: BundleGraphNode) => void,
  addEdge: (edge: BundleEdge) => void,
): void {
  for (const ref of taskData.fileReferences) {
    const nodeId = `file:${ref.resolvedPath ?? ref.path}`;
    addNode({
      id: nodeId,
      kind: "file",
      nodeType: "file",
      displayName: fileDisplayName(ref.path),
      location: fileLocation(ref.path, ref.resolvedPath),
      data: { path: ref.path, resolvedPath: ref.resolvedPath, exists: ref.exists, referenceType: ref.referenceType },
    });
    addEdge({ id: `${taskId}->references->${nodeId}`, source: taskId, target: nodeId, kind: "references" });
  }

  for (const ref of taskData.variableReferences) {
    const nodeId = `var:${ref.variableName}`;
    addNode({ id: nodeId, kind: "variable", nodeType: "variable", displayName: ref.variableName, data: {} });
    addEdge({ id: `${taskId}->uses->${nodeId}`, source: taskId, target: nodeId, kind: "uses" });
  }

  for (const ref of taskData.libraryReferences) {
    const nodeId = `lib:${ref.libraryType}:${ref.resolvedPath ?? ref.identifier}`;
    addNode({
      id: nodeId,
      kind: "library",
      nodeType: "library",
      displayName: ref.identifier,
      ...(ref.isLocal ? { location: "local" as const } : {}),
      data: { libraryType: ref.libraryType, identifier: ref.identifier, isLocal: ref.isLocal, exists: ref.exists },
    });
    addEdge({ id: `${taskId}->uses->${nodeId}`, source: taskId, target: nodeId, kind: "uses" });
  }

  for (const ref of taskData.resourceReferences) {
    const targetId = `resources.${ref.resourceType}.${ref.resourceName}`;
    addEdge({ id: `${taskId}->references->${targetId}`, source: taskId, target: targetId, kind: "references" });
  }

  const computeItems = getTaskCompute(task, job, resources);
  for (const item of computeItems) {
    if (item.kind === "cluster") {
      const nodeId = `cluster:${item.label}`;
      addNode({
        id: nodeId,
        kind: "cluster",
        nodeType: "cluster",
        displayName: item.label,
        data: {
          ...(item.label === DEFAULT_CLUSTER_COMPUTE_LABEL ? { serverless: true } : {}),
          ...(item.expression ? { expression: item.expression } : {}),
          ...(item.variableName ? { variableName: item.variableName } : {}),
          ...(item.details ? { details: item.details } : {}),
        },
      });
      addEdge({ id: `${taskId}->uses->${nodeId}`, source: taskId, target: nodeId, kind: "uses" });
    } else if (item.kind === "sqlWarehouse") {
      const nodeId = `warehouse:${item.label}`;
      addNode({
        id: nodeId,
        kind: "warehouse",
        nodeType: "warehouse",
        displayName: item.label,
        data: {
          ...(item.label === DEFAULT_SQL_WAREHOUSE_LABEL ? { serverless: true } : {}),
          ...(item.expression ? { expression: item.expression } : {}),
          ...(item.variableName ? { variableName: item.variableName } : {}),
          ...(item.details ? { details: item.details } : {}),
        },
      });
      addEdge({ id: `${taskId}->uses->${nodeId}`, source: taskId, target: nodeId, kind: "uses" });
    }
  }

  if (task.run_job_task?.job_id) {
    const jobIdRef = task.run_job_task.job_id;
    const resourceMatch = jobIdRef.match(/^\$\{resources\.jobs\.([^.}]+)\.id\}$/);
    const targetId = resourceMatch ? `resources.jobs.${resourceMatch[1]}` : `external-job:${jobIdRef}`;
    addEdge({ id: `${taskId}->references->${targetId}`, source: taskId, target: targetId, kind: "references" });
  }
}

/**
 * Parses each resource YAML file matched by the bundle's include patterns and
 * returns a map from "resourceGroup.resourceKey" to the absolute path of the
 * file that defines it.  This lets callers resolve file references relative to
 * the correct source file rather than the bundle root.
 */
interface SourceIndex {
  resourceSourceMap: Map<string, string>;
  yamlLocationMaps: Map<string, YamlLocationMap>;
}

async function buildSourceIndex(
  bundleRoot: string,
  includePatterns: string[],
): Promise<SourceIndex> {
  const resourceSourceMap = new Map<string, string>();
  const yamlLocationMaps = new Map<string, YamlLocationMap>();

  async function parseResourceFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, "utf-8");
      yamlLocationMaps.set(filePath, parseYamlLocations(filePath, content));
      const yaml = parseYaml(content) as Record<string, unknown> | null;
      const resources = (yaml?.resources ?? {}) as Record<string, Record<string, unknown>>;
      for (const [resourceGroup, resourceMap] of Object.entries(resources)) {
        for (const resourceKey of Object.keys(resourceMap ?? {})) {
          const key = `${resourceGroup}.${resourceKey}`;
          if (!resourceSourceMap.has(key)) resourceSourceMap.set(key, filePath);
        }
      }
    } catch {
      // ignore unreadable / non-YAML files
    }
  }

  for (const pattern of includePatterns) {
    const parts = pattern.split("/");
    const [dir0, glob] = parts;
    if (parts.length === 2 && glob !== undefined && glob.startsWith("*.") && dir0 !== undefined) {
      const ext = glob.slice(1);
      const dir = join(bundleRoot, dir0);
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (entry.endsWith(ext)) await parseResourceFile(join(dir, entry));
        }
      } catch { /* directory missing */ }
    } else {
      await parseResourceFile(join(bundleRoot, pattern));
    }
  }

  // Also scan the bundle root databricks.yml / databricks.yaml
  for (const name of ["databricks.yml", "databricks.yaml"]) {
    const p = join(bundleRoot, name);
    await parseResourceFile(p);
  }

  return { resourceSourceMap, yamlLocationMaps };
}

/**
 * Flattens all resource entries from a parsed bundle config into a uniform list.
 */
export function extractResourceNodes(parsedBundle: ParsedBundleConfig): ResourceNode[] {
  const nodes: ResourceNode[] = [];

  for (const [resourceGroup, resourceMap] of Object.entries(parsedBundle.resources ?? {})) {
    const typedResourceMap = (resourceMap ?? {}) as Record<string, unknown>;
    for (const [resourceKey, resourceValue] of Object.entries(typedResourceMap)) {
      const resourceData = toRecord(resourceValue);
      nodes.push({
        id: `resources.${resourceGroup}.${resourceKey}`,
        resourceGroup,
        resourceKey,
        displayName: getResourceDisplayName(
          resourceGroup,
          resourceKey,
          resourceData,
        ),
        data: resourceData,
      });
    }
  }

  return nodes;
}

/**
 * Builds a graph of nodes and edges from a parsed bundle config.
 *
 * Without `bundleRoot`, the graph contains job, task, and resource nodes connected
 * by `contains` and `depends_on` edges — the structural skeleton.
 *
 * With `bundleRoot`, the graph is enriched with `file`, `variable`, `library`,
 * `cluster`, and `warehouse` nodes plus `references` and `uses` edges derived
 * from each task's local path and expression analysis.
 */
export async function extractBundleGraph(
  parsedBundle: ParsedBundleConfig,
  bundleRoot?: string,
): Promise<BundleGraph> {
  const nodeMap = new Map<string, BundleGraphNode>();
  const edgeIds = new Set<string>();
  const edges: BundleEdge[] = [];

  function addNode(node: BundleGraphNode): void {
    if (!nodeMap.has(node.id)) nodeMap.set(node.id, node);
  }

  function addEdge(edge: BundleEdge): void {
    if (!edgeIds.has(edge.id)) {
      edgeIds.add(edge.id);
      edges.push(edge);
    }
  }

  const resourceNodes = extractResourceNodes(parsedBundle);

  const sourceIndex = bundleRoot
    ? await buildSourceIndex(
        bundleRoot,
        (parsedBundle.include ?? []).filter((p): p is string => typeof p === "string"),
      )
    : { resourceSourceMap: new Map<string, string>(), yamlLocationMaps: new Map<string, YamlLocationMap>() };
  const { resourceSourceMap, yamlLocationMaps } = sourceIndex;

  // Variable nodes from bundle definition (always, when bundleRoot provided)
  if (bundleRoot) {
    for (const [varName, varDef] of Object.entries(parsedBundle.variables ?? {})) {
      const varId = `var:${varName}`;
      addNode({ id: varId, kind: "variable", nodeType: "variable", displayName: varName, data: toRecord(varDef) });

      const lookup = toRecord(varDef).lookup as Record<string, unknown> | undefined;
      if (lookup) {
        for (const [resourceType, resourceName] of Object.entries(lookup)) {
          if (typeof resourceName === "string") {
            const targetId = `resources.${resourceType}s.${resourceName}`;
            addEdge({ id: `${varId}->lookup->${targetId}`, source: varId, target: targetId, kind: "lookup" });
          }
        }
      }
    }
  }

  resourceNodes.forEach((resourceNode) => {
    const isJobGroup = resourceNode.resourceGroup === "jobs" || resourceNode.resourceGroup === "job";
    if (!isJobGroup) {
      addNode({
        id: resourceNode.id,
        kind: resourceKind(resourceNode.resourceGroup),
        nodeType: resourceNodeType(resourceNode.resourceGroup),
        displayName: resourceNode.displayName,
        resourceGroup: resourceNode.resourceGroup,
        resourceKey: resourceNode.resourceKey,
        data: resourceNode.data,
      });
      return;
    }

    const job = resourceNode.data as Job;
    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    const jobId = resourceNode.id;

    addNode({
      id: jobId,
      kind: "job",
      nodeType: "job",
      displayName: resourceNode.displayName,
      trigger: formatTrigger(job),
      ...(job.schedule?.quartz_cron_expression
        ? {
            triggerTooltip: [
              describeCronExpression(
                job.schedule.quartz_cron_expression,
                job.schedule.timezone_id,
              ),
              job.schedule.pause_status
                ? `Status: ${job.schedule.pause_status}`
                : undefined,
            ]
              .filter(Boolean)
              .join(" - "),
          }
        : {}),
      runAs: formatRunAs(job),
      taskCount: tasks.length,
      parameters: getParameterSummary(job),
      compute: getJobComputeSummary(job, tasks, parsedBundle.resources),
      resourceGroup: resourceNode.resourceGroup,
      resourceKey: resourceNode.resourceKey,
      data: resourceNode.data,
    });

    const tasksByKey = new Map(
      tasks.map((jobTask, index) => [
        jobTask.task_key ?? `task-${index + 1}`,
        jobTask,
      ]),
    );

    tasks.forEach((task, taskIndex) => {
      const taskKey = task.task_key ?? `task-${taskIndex + 1}`;
      const taskId = `${jobId}.tasks.${taskKey}`;
      const taskCompute = getTaskCompute(task, job, parsedBundle.resources);
      const taskType = detectTaskType(task);
      const taskParameters = getEffectiveTaskParameters(job, task);
      const sourceFilePath = resourceSourceMap.get(
        `${resourceNode.resourceGroup}.${resourceNode.resourceKey}`,
      ) ?? "";
      const sourceFileDir = sourceFilePath ? dirname(sourceFilePath) : "";
      const taskYamlPrefix = `resources.${resourceNode.resourceGroup}.${resourceNode.resourceKey}.tasks[${taskIndex}]`;
      const sourceLocations = sourceFilePath
        ? yamlLocationMaps.get(sourceFilePath)
        : undefined;
      const resolveSourceLocation = (yamlPath: string) => {
        const taskPrefix = `tasks.${taskKey}`;
        if (yamlPath.startsWith(taskPrefix)) {
          const suffix = yamlPath.slice(taskPrefix.length);
          return sourceLocations?.get(`${taskYamlPrefix}${suffix}`);
        }
        if (yamlPath.startsWith("parameters")) {
          return sourceLocations?.get(
            `resources.${resourceNode.resourceGroup}.${resourceNode.resourceKey}.${yamlPath}`,
          );
        }
        return undefined;
      };
      const taskData = bundleRoot
        ? buildTaskNodeData(
            toRecord(task),
            resourceNode.data,
            jobId,
            taskKey,
            bundleRoot,
            sourceFilePath,
            sourceFileDir,
            resolveSourceLocation,
          )
        : undefined;

      const hasMissingFile = taskData?.fileReferences.some(
        (ref) => ref.resolvedPath !== undefined && !ref.exists,
      ) ?? false;

      addNode({
        id: taskId,
        kind: taskType.kind,
        nodeType: "task",
        displayName: taskKey,
        taskTypeLabel: taskType.label,
        status: "READY",
        compute: taskCompute,
        ...(taskParameters ? { parameters: taskParameters } : {}),
        taskKey,
        parentId: jobId,
        resourceGroup: resourceNode.resourceGroup,
        resourceKey: resourceNode.resourceKey,
        ...(hasMissingFile ? { hasMissingFile: true } : {}),
        data: toRecord(task),
        ...(taskType.subtitle ? { subtitle: taskType.subtitle } : {}),
        ...(taskData ? { taskData } : {}),
      });

      addEdge({ id: `${jobId}->${taskId}`, source: jobId, target: taskId, kind: "contains" });

      const dependencies = Array.isArray(task.depends_on) ? task.depends_on : [];
      dependencies.forEach((dependency) => {
        if (!dependency.task_key) return;
        const dependencySourceTask = tasksByKey.get(dependency.task_key);
        const outcome = dependencySourceTask?.condition_task
          ? normalizeDependencyOutcome(dependency.outcome)
          : undefined;
        addEdge({
          id: `${jobId}.tasks.${dependency.task_key}->${taskId}`,
          source: `${jobId}.tasks.${dependency.task_key}`,
          target: taskId,
          kind: "depends_on",
          ...(outcome ? { data: { outcome } } : {}),
        });
      });

      if (bundleRoot && taskData) {
        addTaskReferenceGraph(
          taskId,
          taskData,
          task,
          job,
          parsedBundle.resources,
          addNode,
          addEdge,
        );
      }
    });
  });

  return { nodes: [...nodeMap.values()], edges };
}
