import { jobTriggerWords, type JobTriggerWords } from "../jobTrigger.js";
import { readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { hasGlobCharacters } from "../goGlob.js";
import { buildOutputs, isLocalDependency, localLibrary, mayBeBuilt, wheelBuildHint, withoutWheelExtras, type BuildOutputs } from "../localLibraries.js";
import { parse as parseYaml } from "yaml";
import {
  buildTaskNodeData,
  getTaskPayloadKey,
  getUnrecognisedTaskKey,
  resolveLocalPath,
  type TaskNodeData,
  type TaskPayloadKey,
  withFolderNames,
} from "../resources/task.js";
import {
  getPipelineLibraryReferences,
  type PipelineLibraryReference,
} from "../resources/pipeline.js";
import {
  parseYamlLocations,
  type YamlLocationMap,
} from "../sourceLocations.js";
import type { BundleEdge, EdgeKind } from "./edges.js";
import { describeCronExpression } from "./cronDescription.js";
import { findVariableSources, type VariableSources } from "../variableSources.js";
import {
  findDependencyProblems,
  findDuplicateKeys,
  findEnvironmentProblems,
  type JobStructureFinding,
} from "../jobStructure.js";
import { findJobSettingProblems } from "../jobSettings.js";
import { resolveExpressionForTarget } from "../targetResolution.js";
import { findRuntimeSupportProblems, type RuntimeSupportFinding } from "../runtimeSupport.js";
import { BUNDLE_PROBE_TARGET } from "../validateBundle.js";
import type { NotebookHeaderRule } from "../notebookFiles.js";
import { findTargetCheckProblems, type TargetCheckFinding } from "../targetChecks.js";
import { findResourceKeyProblems, type ResourceKeyFinding } from "../resourceKeys.js";
import { findTargetOnlyJobs, type TargetOnlyJob } from "../targetOnlyJobs.js";
import { createSyncExclusion, syncsFromBundleRoot } from "../syncRules.js";
import { localizeBundleRootPaths, localizeWorkspacePaths, type SourceDocument } from "../workspacePaths.js";
import {
  findClusterSecretReferences,
  matchSecretScope,
  type BundleSecretScope,
} from "../resources/secretScope.js";

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
  ai_function_task?: {
    ai_classify?: unknown;
    ai_extract?: unknown;
    ai_parse_document?: unknown;
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
    job_id?: string | number;
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
  continuous?: {
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
  /** Required by the docs, but the CLI deploys without it when root_path is set (#340). */
  name?: string;
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
  /** A cluster defined in the job itself, named by `job_cluster_key`. */
  jobCluster?: boolean;
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
  | "schema"
  /** Something an app's `resources` names by plain name that the bundle does not define (#446). `data.group` is its resource group. */
  | "named"
  | "widget";

export interface BundleGraphNode {
  /** File checks that failed; a failed scan never means the source was clean. */
  scanFailures?: Array<{ file: string; checks: string[]; directory?: true }>;
  id: string;
  kind: string;
  nodeType: BundleNodeType;
  displayName: string;
  location?: "local" | "workspace" | "dbfs";
  taskTypeLabel?: string;
  /** Local sources in a pipeline's `libraries` (pipeline nodes only, when bundleRoot is known). */
  pipelineLibraries?: PipelineLibraryReference[];
  /** A pipeline's data flow from its SQL sources (pipeline nodes only, issue 398). */
  pipelineDataFlow?: import("../pipelineDataFlow.js").PipelineDataFlow;
  /** Where a resource is defined: its YAML file and the line of its key (job and resource nodes, when bundleRoot is known). */
  sourceFile?: string;
  sourceLine?: number;
  /**
   * Where each setting the resource sets is written in `sourceFile`, by field: `cluster_size`,
   * and for a job's cluster `job_clusters.<job_cluster_key>.<field>` (issue 417).
   */
  fieldLines?: Record<string, number>;
  subtitle?: string;
  status?: string;
  trigger?: string;
  triggerTooltip?: string;
  /** A job's schedule or trigger in words, for the overview (issue 733). */
  triggerWords?: JobTriggerWords;
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
  /** What reading a local file's code found (file nodes only; see enrichGraph.ts). */
  codeFacts?: FileCodeFacts;
  /** Secrets a pipeline's source code reads with a scope only known at run time (pipeline nodes only). */
  pipelineRuntimeSecrets?: Array<{ file: string; line: number }>;
}

/**
 * What reading a file's code found, kept on its node for the checks. Each field is left out
 * when the reader found nothing or doesn't apply to the file's kind of task.
 */
export interface FileCodeFacts {
  widgetUsage?: import("../taskFileDetections.js").WidgetUsage;
  taskValueUsage?: import("../taskFileDetections.js").TaskValueUsage;
  runTargets?: import("../taskFileDetections.js").RunTarget[];
  sqlParameterMarkers?: Array<{ name: string; line: number }>;
  sqlTextParameters?: import("../taskFileDetections.js").SqlTextParameter[];
  qualifiedNames?: import("../taskFileDetections.js").QualifiedName[];
  /** Secrets whose scope isn't written in the code (issue 535). */
  runtimeSecrets?: import("../runtimeSecrets.js").RuntimeSecretRead[];
}

/** @deprecated use BundleEdge from edges.ts — kept for callers that destructure relationship */
export interface BundleGraphEdge extends BundleEdge {}

export interface BundleGraph {
  nodes: BundleGraphNode[];
  edges: BundleEdge[];
  /** Per variable name, the lines that set its value, for the task panel to open. */
  variableSources?: Record<string, VariableSources>;
  /** Task graph and duplicate key mistakes in jobs (#135), for the issue list. */
  jobStructureFindings?: JobStructureFinding[];
  /** Problems the CLI only reports once a target is picked (#389), for the issue list. */
  targetCheckFindings?: TargetCheckFinding[];
  /** Resource keys deploy doesn't accept (#511), for the issue list. */
  resourceKeyFindings?: ResourceKeyFinding[];
  /** Jobs only a target writes, which the structural preview doesn't check: a note in the panel's Issues list only. */
  targetOnlyJobs?: TargetOnlyJob[];
  /** Clusters on a Databricks Runtime near or past end of support (#485), for the issue list. */
  runtimeSupportFindings?: RuntimeSupportFinding[];
  /** The CLI version's rule for notebook headers, used again by the issue list's suggestions. */
  notebookRule?: NotebookHeaderRule;
  /** Where deploy may build library files before checking them (#482, #525). */
  buildOutputs?: BuildOutputs;
  /** Upload rules for local source scans. Absent when external sync roots are not modelled. */
  sourceUpload?: { root: string; sync?: Sync };
  /**
   * Local files the environment checks read: `project_environment` files and local
   * `dependencies`, as absolute paths that may hold Go glob characters. Watched, so
   * editing or building one re-checks the bundle (#590).
   */
  environmentPaths?: string[];
}

export interface ExtractBundleGraphOptions {
  /** The rule of the CLI that validated the bundle (see notebookHeaderRuleFor). */
  notebookRule?: NotebookHeaderRule;
  /** The version of the CLI that validated, such as `v1.26.0`, for the rules that changed between versions. */
  cliVersion?: string;
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
  // Every resource shows its `name` when it has one. For a secret scope that is the
  // name Databricks knows, which is what code and config refer to.
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

// Short code shown on each task node. Keyed like TASK_PRESENTATION so a new task type
// needs one here too. Codes already shown by kind (NB, SQL, PY, P, DB, J) are kept.
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
  dbt_task: (task) => withOptionalSubtitle("script", "dbt", listOf(task.dbt_task?.commands)?.join(" ")),
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
  run_job_task: (task) => withOptionalSubtitle("job", "Run Job", task.run_job_task?.job_id === undefined ? undefined : String(task.run_job_task.job_id)),
  sql_task: (task) => withOptionalSubtitle("sql", "SQL", task.sql_task?.file?.path),
  spark_submit_task: (task) =>
    withOptionalSubtitle("script", "Spark Submit", listOf(task.spark_submit_task?.parameters)?.join(" ")),
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
  ai_function_task: (task) =>
    withOptionalSubtitle("script", "AI function", aiFunctionName(task.ai_function_task)),
};

/** The AI function an `ai_function_task` applies, such as `ai_classify`. */
function aiFunctionName(task: JobTask["ai_function_task"]): string | undefined {
  if (!task) return undefined;
  return (["ai_classify", "ai_extract", "ai_parse_document"] as const).find(
    (name) => task[name] !== undefined,
  );
}

/** The label the graph shows for a task's type, such as "Notebook" or "If/else". */
export function taskTypeLabel(task: JobTask): string {
  return detectTaskType(task).label;
}

function detectTaskType(task: JobTask): TaskPresentation {
  const payloadKey = getTaskPayloadKey(task);
  if (payloadKey) return TASK_PRESENTATION[payloadKey](task);
  // Show an unrecognised task type by its key rather than as an anonymous task.
  return {
    kind: "job",
    label: "Task",
    subtitle: getUnrecognisedTaskKey(task) ?? "Other task settings",
  };
}

function formatTrigger(job: Job): string {
  if (job.schedule?.quartz_cron_expression) {
    const tz = job.schedule.timezone_id ? ` (${job.schedule.timezone_id})` : "";
    const pauseStatus = job.schedule.pause_status
      ? ` - ${job.schedule.pause_status}`
      : "";
    return `Schedule: ${job.schedule.quartz_cron_expression}${tz}${pauseStatus}`;
  }
  if (job.continuous && typeof job.continuous === "object") {
    return job.continuous.pause_status ? `Continuous - ${job.continuous.pause_status}` : "Continuous";
  }
  const trigger = job.trigger;
  if (!trigger) return "Not specified";
  if (trigger.file_arrival?.url) {
    return `File arrival: ${trigger.file_arrival.url}`;
  }
  const updatedTables = listOf(trigger.table_update?.table_names);
  if (updatedTables?.length) {
    return `Table update: ${updatedTables.join(", ")}`;
  }
  const tables = listOf(trigger.table?.table_names);
  if (tables?.length) {
    return `Table: ${tables.join(", ")}`;
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

/**
 * A list field, or `undefined` when it isn't one: the structural preview leaves a complex
 * variable such as `tasks: ${var.job_tasks}` as its text.
 */
function listOf<T>(value: readonly T[] | undefined): readonly T[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function getParameterSummary(job: Job): GraphParameter[] {
  return (listOf(job.parameters) ?? [])
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
  const jobCluster = (listOf(job?.job_clusters) ?? []).find(
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
      jobCluster: true,
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
  // A for_each task runs its inner task's files, so they are the outer task's files too.
  const fileReferences = [...taskData.fileReferences, ...(taskData.nestedTask?.fileReferences ?? [])];
  for (const ref of fileReferences) {
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
          ...(item.jobCluster ? { jobCluster: true } : {}),
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
    // A job_id can be a number (an existing job's ID) or a string reference.
    const jobIdRef = String(task.run_job_task.job_id);
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
  /**
   * For each job, its tasks' positions in the file that defines it, by task_key.
   * In a real target the CLI sorts tasks by key, so a task's position in the CLI
   * output is not its position in the file.
   */
  taskPositions: Map<string, Map<string, number>>;
  /** Per `group.key`, the line its key is written on in its file. */
  resourceKeyLines: Map<string, number>;
  /** Per `group.key`, the line of each field it sets in that file (see BundleGraphNode.fieldLines). */
  resourceFieldLines: Map<string, Record<string, number>>;
  /** Every YAML file read, as written: the anchors for mapping a real target's workspace paths back. */
  sourceDocuments: SourceDocument[];
  /** Every YAML file read, as text. */
  sourceTexts: Map<string, string>;
}

/** Positions in a `tasks:` list by key. A repeated key keeps its first position, which is where the CLI merges the copies. */
function positionsByTaskKey(tasks: unknown[]): Map<string, number> {
  const positions = new Map<string, number>();
  tasks.forEach((task, index) => {
    const key = toRecord(task).task_key;
    if (typeof key === "string" && !positions.has(key)) positions.set(key, index);
  });
  return positions;
}

/**
 * The line each field of a resource is written on: its top-level fields, and for a job each
 * `job_clusters` entry's `new_cluster` fields by its job_cluster_key (issue 417).
 */
function fieldLinesOf(resource: unknown, prefix: string, keyLocations: YamlLocationMap): Record<string, number> {
  const lines: Record<string, number> = {};
  for (const field of Object.keys(toRecord(resource))) {
    const line = keyLocations.get(`${prefix}.${field}`)?.line;
    if (line) lines[field] = line;
  }
  const jobClusters = toRecord(resource).job_clusters;
  if (Array.isArray(jobClusters)) {
    jobClusters.forEach((jobCluster, index) => {
      const key = toRecord(jobCluster).job_cluster_key;
      if (typeof key !== "string") return;
      for (const field of Object.keys(toRecord(toRecord(jobCluster).new_cluster))) {
        const line = keyLocations.get(`${prefix}.job_clusters[${index}].new_cluster.${field}`)?.line;
        if (line) lines[`job_clusters.${key}.${field}`] = line;
      }
    });
  }
  return lines;
}

async function buildSourceIndex(
  bundleRoot: string,
  includePatterns: string[],
): Promise<SourceIndex> {
  const resourceSourceMap = new Map<string, string>();
  const yamlLocationMaps = new Map<string, YamlLocationMap>();
  const taskPositions = new Map<string, Map<string, number>>();
  const resourceKeyLines = new Map<string, number>();
  const resourceFieldLines = new Map<string, Record<string, number>>();
  const sourceDocuments: SourceDocument[] = [];
  const sourceTexts = new Map<string, string>();

  async function parseResourceFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, "utf-8");
      sourceTexts.set(filePath, content);
      const keyLocations: YamlLocationMap = new Map();
      yamlLocationMaps.set(filePath, parseYamlLocations(filePath, content, keyLocations));
      const yaml = parseYaml(content) as Record<string, unknown> | null;
      // With `<<` merge keys resolved, as the CLI does, so jobs built from YAML anchors are found.
      sourceDocuments.push({ file: filePath, doc: parseYaml(content, { merge: true }) });
      const resources = (yaml?.resources ?? {}) as Record<string, Record<string, unknown>>;
      for (const [resourceGroup, resourceMap] of Object.entries(resources)) {
        for (const [resourceKey, resource] of Object.entries(resourceMap ?? {})) {
          const key = `${resourceGroup}.${resourceKey}`;
          if (resourceSourceMap.has(key)) continue;
          resourceSourceMap.set(key, filePath);
          const keyLine = keyLocations.get(`resources.${key}`)?.line;
          if (keyLine) resourceKeyLines.set(key, keyLine);
          resourceFieldLines.set(key, fieldLinesOf(resource, `resources.${key}`, keyLocations));
          const tasks = toRecord(resource).tasks;
          if (Array.isArray(tasks)) taskPositions.set(key, positionsByTaskKey(tasks));
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

  return { resourceSourceMap, yamlLocationMaps, taskPositions, resourceKeyLines, resourceFieldLines, sourceDocuments, sourceTexts };
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
/**
 * The bundle's files in the order the CLI loads them: its databricks.yml, then the
 * files `include` loaded. The CLI's `include` output is that file list, in that order.
 */
function loadOrder(bundleRoot: string | undefined, include: unknown): string[] {
  if (!bundleRoot) return [];
  const included = Array.isArray(include) ? include.filter((p): p is string => typeof p === "string") : [];
  return [
    join(bundleRoot, "databricks.yml"),
    join(bundleRoot, "databricks.yaml"),
    ...included.map((file) => join(bundleRoot, file)),
  ];
}

export async function extractBundleGraph(
  cliOutput: ParsedBundleConfig,
  bundleRoot?: string,
  options: ExtractBundleGraphOptions = {},
): Promise<BundleGraph> {
  // Folder names for the letter case check (#475), read once for this check.
  return withFolderNames(() => buildBundleGraph(cliOutput, bundleRoot, options));
}

async function buildBundleGraph(
  cliOutput: ParsedBundleConfig,
  bundleRoot: string | undefined,
  options: ExtractBundleGraphOptions,
): Promise<BundleGraph> {
  const notebookRule = options.notebookRule ?? "contains";
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

  const sourceIndex = bundleRoot
    ? await buildSourceIndex(
        bundleRoot,
        (cliOutput.include ?? []).filter((p): p is string => typeof p === "string"),
      )
    : {
        resourceSourceMap: new Map<string, string>(),
        yamlLocationMaps: new Map<string, YamlLocationMap>(),
        taskPositions: new Map<string, Map<string, number>>(),
        resourceKeyLines: new Map<string, number>(),
        resourceFieldLines: new Map<string, Record<string, number>>(),
        sourceDocuments: [],
        sourceTexts: new Map<string, string>(),
      };
  const { resourceSourceMap, yamlLocationMaps, taskPositions, resourceKeyLines, resourceFieldLines } = sourceIndex;

  // A fully resolved real target has workspace paths; read the local files instead.
  const dirOf = (group: string, key: string) => {
    const file = resourceSourceMap.get(`${group}.${key}`);
    return file ? dirname(file) : bundleRoot!;
  };
  // Real-target paths, read back as the YAML has them: uploaded paths first, then paths the
  // CLI left relative to the bundle root because one of them failed its check.
  const parsedBundle = bundleRoot
    ? localizeBundleRootPaths(
        localizeWorkspacePaths(cliOutput, sourceIndex.sourceDocuments, dirOf),
        sourceIndex.sourceDocuments,
        dirOf,
        bundleRoot,
      )
    : cliOutput;

  const resourceNodes = extractResourceNodes(parsedBundle);

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

  const fieldLinesFor = (resourceNode: ResourceNode) => {
    const lines = resourceFieldLines.get(`${resourceNode.resourceGroup}.${resourceNode.resourceKey}`);
    return lines && Object.keys(lines).length > 0 ? { fieldLines: lines } : {};
  };
  resourceNodes.forEach((resourceNode) => {
    const isJobGroup = resourceNode.resourceGroup === "jobs" || resourceNode.resourceGroup === "job";
    if (!isJobGroup) {
      const sourceFilePath = resourceSourceMap.get(
        `${resourceNode.resourceGroup}.${resourceNode.resourceKey}`,
      ) ?? "";
      const pipelineLibraries =
        resourceNode.resourceGroup === "pipelines" && bundleRoot
          ? getPipelineLibraryReferences(
              resourceNode.data,
              sourceFilePath,
              sourceFilePath ? dirname(sourceFilePath) : bundleRoot,
              bundleRoot,
              (yamlPath) =>
                yamlLocationMaps
                  .get(sourceFilePath)
                  ?.get(`resources.pipelines.${resourceNode.resourceKey}.${yamlPath}`),
              notebookRule,
            )
          : undefined;
      const definedAtLine = resourceKeyLines.get(`${resourceNode.resourceGroup}.${resourceNode.resourceKey}`);
      addNode({
        id: resourceNode.id,
        kind: resourceKind(resourceNode.resourceGroup),
        nodeType: resourceNodeType(resourceNode.resourceGroup),
        displayName: resourceNode.displayName,
        resourceGroup: resourceNode.resourceGroup,
        resourceKey: resourceNode.resourceKey,
        data: resourceNode.data,
        ...(pipelineLibraries?.length ? { pipelineLibraries } : {}),
        ...(sourceFilePath ? { sourceFile: sourceFilePath } : {}),
        ...(definedAtLine ? { sourceLine: definedAtLine } : {}),
        ...fieldLinesFor(resourceNode),
      });
      return;
    }

    const job = resourceNode.data as Job;
    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    const jobId = resourceNode.id;
    const jobSourceFile = resourceSourceMap.get(`${resourceNode.resourceGroup}.${resourceNode.resourceKey}`);
    const jobDefinedAtLine = resourceKeyLines.get(`${resourceNode.resourceGroup}.${resourceNode.resourceKey}`);
    const triggerWords = jobTriggerWords(job);

    addNode({
      id: jobId,
      kind: "job",
      nodeType: "job",
      displayName: resourceNode.displayName,
      trigger: formatTrigger(job),
      ...(triggerWords ? { triggerWords } : {}),
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
      ...(jobSourceFile ? { sourceFile: jobSourceFile } : {}),
      ...(jobDefinedAtLine ? { sourceLine: jobDefinedAtLine } : {}),
      ...fieldLinesFor(resourceNode),
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
      // Found by key, not by taskIndex: a real target sorts the tasks. A task that is not
      // in the job's file (for example one a target adds) gets no location there.
      const sourceTaskIndex = taskPositions
        .get(`${resourceNode.resourceGroup}.${resourceNode.resourceKey}`)
        ?.get(taskKey);
      const taskYamlPrefix =
        sourceTaskIndex === undefined
          ? undefined
          : `resources.${resourceNode.resourceGroup}.${resourceNode.resourceKey}.tasks[${sourceTaskIndex}]`;
      const sourceLocations = sourceFilePath
        ? yamlLocationMaps.get(sourceFilePath)
        : undefined;
      const resolveSourceLocation = (yamlPath: string) => {
        const taskPrefix = `tasks.${taskKey}`;
        if (yamlPath.startsWith(taskPrefix)) {
          if (!taskYamlPrefix) return undefined;
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
            notebookRule,
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

  addConfigSecretReferences(parsedBundle, sourceIndex, nodeMap, addNode, addEdge);
  addResourceReferences(parsedBundle, sourceIndex, addEdge);
  addNamedOutside(parsedBundle, sourceIndex, addNode, addEdge);

  const sourceFiles = sourceIndex.sourceDocuments.map(({ file, doc }) => ({
    file,
    doc,
    text: sourceIndex.sourceTexts.get(file),
    locations: yamlLocationMaps.get(file),
  }));
  // The CLI's output names the target it resolved; the structural preview's names none.
  const activeTarget =
    typeof parsedBundle.bundle?.target === "string" && parsedBundle.bundle.target !== BUNDLE_PROBE_TARGET
      ? parsedBundle.bundle.target
      : undefined;
  // A BUNDLE_VAR_ environment variable wins over a variable's default and target value (docs,
  // precedence order), so a value that uses one is not judged by the value in the files.
  const setOutsideFiles = (value: string) =>
    [...value.matchAll(/\$\{var\.([A-Za-z0-9_-]+)/g)].some((match) => process.env[`BUNDLE_VAR_${match[1]}`] !== undefined);
  const jobStructureOptions = {
    ...(activeTarget ? { activeTarget } : {}),
    resolve: (value: string, target: string | undefined) =>
      setOutsideFiles(value) ? undefined : resolveExpressionForTarget(value, parsedBundle, target).value,
  };
  // An artifact's relative paths are read from the folder of the YAML file defining it.
  const artifactDir = (name: string) => {
    for (const { file, doc } of sourceIndex.sourceDocuments) {
      const d = toRecord(doc);
      const targetArtifacts = activeTarget ? toRecord(toRecord(toRecord(d.targets)[activeTarget]).artifacts) : {};
      if (name in toRecord(d.artifacts) || name in targetArtifacts) return dirname(file);
    }
    return bundleRoot!;
  };
  const outputs = bundleRoot ? buildOutputs(parsedBundle, bundleRoot, artifactDir) : undefined;
  const projectExclusion = bundleRoot && syncsFromBundleRoot(bundleRoot, parsedBundle.sync)
    ? createSyncExclusion(bundleRoot, parsedBundle.sync) : () => undefined;
  // Filled in while the environment checks below read their files.
  const environmentPaths: string[] = [];
  return {
    nodes: [...nodeMap.values()],
    edges,
    notebookRule,
    environmentPaths,
    ...(outputs ? { buildOutputs: outputs } : {}),
    ...(bundleRoot && syncsFromBundleRoot(bundleRoot, parsedBundle.sync)
      ? { sourceUpload: { root: bundleRoot, ...(parsedBundle.sync ? { sync: parsedBundle.sync } : {}) } } : {}),
    variableSources: findVariableSources(
      loadOrder(bundleRoot, cliOutput.include).flatMap((file) => {
        const text = sourceIndex.sourceTexts.get(file);
        return text === undefined ? [] : [{ file, text }];
      }),
    ),
    runtimeSupportFindings: findRuntimeSupportProblems(toRecord(parsedBundle.resources), sourceFiles, jobStructureOptions),
    jobStructureFindings: [
      ...findDependencyProblems(toRecord(parsedBundle.resources?.jobs), sourceFiles, jobStructureOptions),
      ...findDuplicateKeys(sourceFiles, jobStructureOptions),
      ...findJobSettingProblems(toRecord(parsedBundle.resources?.jobs), sourceFiles, jobStructureOptions),
      ...findEnvironmentProblems(toRecord(parsedBundle.resources?.jobs), sourceFiles, {
        ...jobStructureOptions,
        // Relative to the job's YAML folder, as the CLI reads it; a real target's workspace
        // path is already mapped back to the local file. Only a small file is read.
        isLocalDependency,
        missingDependency: (jobKey, value) => {
          if (!bundleRoot) return undefined;
          const written = withoutWheelExtras(value);
          const { resolvedPath, exists, notAFile } = localLibrary(written, dirOf("jobs", jobKey));
          environmentPaths.push(resolvedPath);
          if (exists || mayBeBuilt(resolvedPath, outputs)) return undefined;
          const glob = hasGlobCharacters(written);
          // Written from the bundle root, the usual mistake (#518): name the path from the YAML folder.
          const fromRoot = localLibrary(written, bundleRoot);
          const suggestion = fromRoot.exists
            ? relative(dirOf("jobs", jobKey), fromRoot.resolvedPath).split(sep).join("/")
            : undefined;
          const hint = wheelBuildHint(written, outputs);
          return {
            glob,
            ...(notAFile ? { notAFile } : {}),
            ...(suggestion && suggestion !== written ? { suggestion } : {}),
            ...(hint ? { hint } : {}),
          };
        },
        projectFileExcluded: (jobKey, value) => {
          if (!bundleRoot) return false;
          const { resolvedPath, exists } = resolveLocalPath(value, dirOf("jobs", jobKey), bundleRoot);
          return !!(exists && resolvedPath && projectExclusion(resolvedPath));
        },
        readProjectFile: (jobKey, value) => {
          if (!bundleRoot) return undefined;
          const { resolvedPath, exists } = resolveLocalPath(value, dirOf("jobs", jobKey), bundleRoot);
          if (resolvedPath) environmentPaths.push(resolvedPath);
          if (!resolvedPath || !exists) return undefined;
          try {
            const stats = statSync(resolvedPath);
            return stats.isFile() && stats.size <= 1_000_000 ? readFileSync(resolvedPath, "utf8") : undefined;
          } catch {
            return undefined;
          }
        },
      }),
    ],
    // The CLI's own output, before the paths are mapped back to local files.
    targetCheckFindings: findTargetCheckProblems(cliOutput, sourceFiles, options.cliVersion),
    resourceKeyFindings: findResourceKeyProblems(cliOutput, sourceFiles),
    targetOnlyJobs: findTargetOnlyJobs(cliOutput, sourceFiles),
  };
}

/** The bundle's `secret_scopes` resources, with the scope name Databricks uses. */
export function bundleSecretScopes(nodes: Iterable<BundleGraphNode>): BundleSecretScope[] {
  const scopes: BundleSecretScope[] = [];
  for (const node of nodes) {
    if (node.resourceGroup !== "secret_scopes" || !node.resourceKey) continue;
    const name = typeof node.data.name === "string" ? node.data.name : node.resourceKey;
    scopes.push({ id: node.id, resourceKey: node.resourceKey, name });
  }
  return scopes;
}

/**
 * Links `{{secrets/<scope>/<key>}}` in cluster `spark_conf` / `spark_env_vars` to the
 * scope, from whatever uses that cluster: the job's tasks on a job cluster, a task's
 * own new_cluster, a `clusters` resource (and tasks pointing at it), or a pipeline.
 */
function addConfigSecretReferences(
  parsedBundle: ParsedBundleConfig,
  { resourceSourceMap, yamlLocationMaps, taskPositions }: SourceIndex,
  nodeMap: Map<string, BundleGraphNode>,
  addNode: (node: BundleGraphNode) => void,
  addEdge: (edge: BundleEdge) => void,
): void {
  const resources = parsedBundle.resources ?? {};
  const scopes = bundleSecretScopes(nodeMap.values());

  function link(
    group: string,
    key: string,
    clusterPath: string,
    cluster: unknown,
    sourceIds: string[],
    locate = true,
  ): void {
    const file = resourceSourceMap.get(`${group}.${key}`) ?? "";
    for (const ref of findClusterSecretReferences(cluster)) {
      const base = clusterPath ? `resources.${group}.${key}.${clusterPath}` : `resources.${group}.${key}`;
      const yamlPath = `${base}.${ref.path}`;
      const location = locate ? yamlLocationMaps.get(file)?.get(yamlPath) : undefined;
      const match = matchSecretScope(ref.scope, scopes);
      addNode({
        id: match.nodeId,
        kind: "secret_scope",
        nodeType: "secret_scope",
        displayName: ref.scope,
        data: {
          scope: ref.scope,
          ...(match.resourceKeyMisuse ? { resourceKeyMisuse: match.resourceKeyMisuse } : {}),
        },
      });
      for (const source of sourceIds) {
        if (!nodeMap.has(source)) continue;
        addEdge({
          id: `${source}->secret->${match.nodeId}@${yamlPath}`,
          source,
          target: match.nodeId,
          kind: "references",
          data: {
            key: ref.key,
            yamlPath,
            ...(file ? { file } : {}),
            ...(location ? { line: location.line, column: location.column } : {}),
          },
        });
      }
    }
  }

  for (const [jobKey, rawJob] of Object.entries(resources.jobs ?? {})) {
    // A job declared with no body (`my_job:`) is null in the CLI output.
    const job = toRecord(rawJob) as Job;
    const jobId = `resources.jobs.${jobKey}`;
    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    const taskId = (task: JobTask, index: number) =>
      `${jobId}.tasks.${task.task_key ?? `task-${index + 1}`}`;
    (listOf(job.job_clusters) ?? []).forEach((jobCluster, index) => {
      const users = tasks
        .map((task, taskIndex) => ({ task, taskIndex }))
        .filter(({ task }) => task.job_cluster_key && task.job_cluster_key === jobCluster.job_cluster_key)
        .map(({ task, taskIndex }) => taskId(task, taskIndex));
      link("jobs", jobKey, `job_clusters[${index}].new_cluster`, jobCluster.new_cluster, users);
    });
    // By key, as for task locations: a real target sorts the tasks.
    const positions = taskPositions.get(`jobs.${jobKey}`);
    tasks.forEach((task, index) => {
      const sourceIndex = task.task_key === undefined ? undefined : positions?.get(task.task_key);
      link(
        "jobs",
        jobKey,
        `tasks[${sourceIndex ?? index}].new_cluster`,
        task.new_cluster,
        [taskId(task, index)],
        sourceIndex !== undefined,
      );
    });
  }

  for (const [clusterKey, cluster] of Object.entries(resources.clusters ?? {})) {
    const clusterId = `resources.clusters.${clusterKey}`;
    const users = [...nodeMap.values()]
      .filter(
        (node) =>
          node.nodeType === "task" &&
          typeof node.data.existing_cluster_id === "string" &&
          node.data.existing_cluster_id.includes(`resources.clusters.${clusterKey}.`),
      )
      .map((node) => node.id);
    link("clusters", clusterKey, "", cluster, [clusterId, ...users]);
  }

  for (const [pipelineKey, pipeline] of Object.entries(resources.pipelines ?? {})) {
    const clusters = Array.isArray(toRecord(pipeline).clusters) ? (toRecord(pipeline).clusters as unknown[]) : [];
    clusters.forEach((cluster, index) => {
      link("pipelines", pipelineKey, `clusters[${index}]`, cluster, [`resources.pipelines.${pipelineKey}`]);
    });
  }
}

// `$${...}` is the CLI's escape for literal text, not a reference (#423).
const RESOURCE_REFERENCES = /(?<!\$)\$\{resources\.([^.}]+)\.([^.}]+)\.[^}]+\}/g;

/** Every `${resources.<group>.<key>.*}` in a value, with the YAML path of the string it is in. */
function findResourceReferences(
  value: unknown,
  path: string,
): Array<{ expression: string; group: string; key: string; yamlPath: string }> {
  if (typeof value === "string") {
    return [...value.matchAll(RESOURCE_REFERENCES)].map((match) => ({
      expression: match[0],
      group: match[1]!,
      key: match[2]!,
      yamlPath: path,
    }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findResourceReferences(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      findResourceReferences(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/**
 * Links a resource to each bundle resource it names with `${resources.<group>.<key>.*}`,
 * such as a pipeline's schema, a dashboard's or alert's SQL warehouse, a volume's schema or
 * an app's resources (#403, #423). One edge per resource, at its first use. The target may
 * be missing from the bundle; the overview shows that as a missing box. Jobs are left out:
 * their links come from their tasks.
 */
/** Resources whose `warehouse_id` names the SQL warehouse they run on (CLI v1.26.0 schema). */
const WAREHOUSE_GROUPS = ["dashboards", "alerts", "genie_spaces", "quality_monitors"];
/** Resources that live in a schema named by `catalog_name` and `schema_name` (CLI v1.26.0 schema). */
const SCHEMA_GROUPS = ["volumes", "registered_models", "secrets"];

/**
 * A warehouse or schema a resource names by a plain name, ID or `${var.*}`, not by
 * `${resources.*}` (those are edges from addResourceReferences). Each gets the same kind of
 * node a job task's warehouse gets, so a dashboard and a job naming one warehouse ID share it
 * (#423 follow-up). Other `${...}` values are kept as written.
 */
function addNamedOutside(
  parsedBundle: ParsedBundleConfig,
  { resourceSourceMap, yamlLocationMaps }: SourceIndex,
  addNode: (node: BundleGraphNode) => void,
  addEdge: (edge: BundleEdge) => void,
): void {
  const resources = (parsedBundle.resources ?? {}) as Record<string, unknown>;
  const edgeData = (group: string, key: string, field: string, expression: string) => {
    const file = resourceSourceMap.get(`${group}.${key}`) ?? "";
    const yamlPath = `resources.${group}.${key}.${field}`;
    const location = yamlLocationMaps.get(file)?.get(yamlPath);
    return {
      expression,
      yamlPath,
      ...(file ? { file } : {}),
      ...(location ? { line: location.line, column: location.column } : {}),
    };
  };
  const named = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.includes("${resources.");

  for (const group of WAREHOUSE_GROUPS) {
    for (const [key, resource] of Object.entries(toRecord(resources[group]) ?? {})) {
      const value = toRecord(resource)?.warehouse_id;
      if (!named(value)) continue;
      const source = `resources.${group}.${key}`;
      const nodeId = `warehouse:${normalizeReference(value)}`;
      const reference = computeReference(value);
      addNode({
        id: nodeId,
        kind: "warehouse",
        nodeType: "warehouse",
        displayName: normalizeReference(value),
        data: {
          ...(reference.expression ? { expression: reference.expression } : {}),
          ...(reference.variableName ? { variableName: reference.variableName } : {}),
        },
      });
      addEdge({ id: `${source}->uses->${nodeId}`, source, target: nodeId, kind: "uses", data: edgeData(group, key, "warehouse_id", value) });
    }
  }

  // The bundle's own schemas by `catalog_name.name` as written, so a plain name that matches
  // one is a line to that box, not a dashed box beside it.
  const bundleSchemas = new Map<string, string>();
  for (const [key, resource] of Object.entries(toRecord(resources.schemas) ?? {})) {
    const record = toRecord(resource);
    if (typeof record?.catalog_name === "string" && typeof record?.name === "string") {
      bundleSchemas.set(`${record.catalog_name}.${record.name}`, `resources.schemas.${key}`);
    }
  }

  for (const group of SCHEMA_GROUPS) {
    for (const [key, resource] of Object.entries(toRecord(resources[group]) ?? {})) {
      const record = toRecord(resource);
      const catalog = record?.catalog_name;
      const schema = record?.schema_name;
      if (!named(catalog) || !named(schema)) continue;
      const source = `resources.${group}.${key}`;
      const name = `${catalog}.${schema}`;
      const own = bundleSchemas.get(name);
      if (own) {
        addEdge({ id: `${source}->references->${own}`, source, target: own, kind: "references", data: edgeData(group, key, "schema_name", name) });
        continue;
      }
      const nodeId = `schema:${name}`;
      addNode({
        id: nodeId,
        kind: "schemas",
        nodeType: "schema",
        displayName: name,
        data: name.includes("${") ? { expression: name } : {},
      });
      addEdge({ id: `${source}->uses->${nodeId}`, source, target: nodeId, kind: "uses", data: edgeData(group, key, "schema_name", name) });
    }
  }

  addAppResources(resources, named, edgeData, addNode, addEdge);
}

/** `securable_type` of an app's `uc_securable` entry → the group its dashed box is shown in (CLI v1.27.0 schema). */
const UC_SECURABLE_GROUPS: Record<string, string> = {
  VOLUME: "volumes",
  TABLE: "tables",
  FUNCTION: "functions",
  CONNECTION: "connections",
  MODEL_SERVICE: "model_services",
};

/**
 * What an app's `resources` list names by plain name (#446): a line to the bundle's own box
 * when the name matches one, else to a dashed box shared with anything else naming it. Plain
 * IDs that only exist after deploy (`job`, `experiment`, `genie_space`) are left out, so a
 * dashed "job 123" box never sits beside the bundle job it may be. Names are matched as
 * written, as #444 does for schemas.
 */
function addAppResources(
  resources: Record<string, unknown>,
  named: (value: unknown) => value is string,
  edgeData: (group: string, key: string, field: string, expression: string) => Record<string, unknown>,
  addNode: (node: BundleGraphNode) => void,
  addEdge: (edge: BundleEdge) => void,
): void {
  const apps = Object.entries(toRecord(resources.apps) ?? {});
  if (apps.length === 0) return;

  /** The bundle's resources of one group, by the name Databricks knows them by. */
  const byName = (group: string, nameOf: (record: Record<string, unknown>) => unknown) => {
    const map = new Map<string, string>();
    for (const [key, resource] of Object.entries(toRecord(resources[group]) ?? {})) {
      const record = toRecord(resource);
      const name = record ? nameOf(record) : undefined;
      if (typeof name === "string" && !map.has(name)) map.set(name, `resources.${group}.${key}`);
    }
    return map;
  };
  const joined = (...parts: unknown[]) => (parts.every((part) => typeof part === "string") ? parts.join("") : undefined);
  const own: Record<string, Map<string, string>> = {
    model_serving_endpoints: byName("model_serving_endpoints", (r) => r.name),
    apps: byName("apps", (r) => r.name),
    database_instances: byName("database_instances", (r) => r.name),
    volumes: byName("volumes", (r) => joined(r.catalog_name, ".", r.schema_name, ".", r.name)),
    // A model service's parent is `schemas/<catalog>.<schema>` (CLI acceptance tests), so its full name adds the ID.
    model_services: byName("model_services", (r) =>
      typeof r.parent === "string" && r.parent.startsWith("schemas/") ? joined(r.parent.slice("schemas/".length), ".", r.model_service_id) : undefined,
    ),
    postgres_branches: byName("postgres_branches", (r) => joined(r.parent, "/branches/", r.branch_id)),
    postgres_databases: byName("postgres_databases", (r) => joined(r.parent, "/databases/", r.database_id)),
  };
  const scopes: BundleSecretScope[] = Object.entries(toRecord(resources.secret_scopes) ?? {}).map(([key, resource]) => {
    const name = toRecord(resource)?.name;
    return { id: `resources.secret_scopes.${key}`, resourceKey: key, name: typeof name === "string" ? name : key };
  });

  for (const [appKey, app] of apps) {
    const entries = toRecord(app)?.resources;
    if (!Array.isArray(entries)) continue;
    const source = `resources.apps.${appKey}`;

    /** A line to the bundle's box for `name` in `group`, or to a dashed one. */
    const link = (group: string, name: string, field: string) => {
      const data = edgeData("apps", appKey, field, name);
      const target = own[group]?.get(name);
      if (target) {
        if (target !== source) addEdge({ id: `${source}->references->${target}`, source, target, kind: "references", data });
        return;
      }
      const nodeId = `named:${group}:${name}`;
      addNode({ id: nodeId, kind: group, nodeType: "named", displayName: name, data: { group, ...(name.includes("${") ? { expression: name } : {}) } });
      addEdge({ id: `${source}->uses->${nodeId}`, source, target: nodeId, kind: "uses", data });
    };

    entries.forEach((rawEntry, index) => {
      const entry = toRecord(rawEntry);
      if (!entry) return;
      const at = `resources[${index}]`;

      const warehouseId = toRecord(entry.sql_warehouse)?.id;
      if (named(warehouseId)) {
        // The same dashed box a job task's or a dashboard's warehouse ID gets.
        const nodeId = `warehouse:${normalizeReference(warehouseId)}`;
        const reference = computeReference(warehouseId);
        addNode({
          id: nodeId,
          kind: "warehouse",
          nodeType: "warehouse",
          displayName: normalizeReference(warehouseId),
          data: {
            ...(reference.expression ? { expression: reference.expression } : {}),
            ...(reference.variableName ? { variableName: reference.variableName } : {}),
          },
        });
        addEdge({ id: `${source}->uses->${nodeId}`, source, target: nodeId, kind: "uses", data: edgeData("apps", appKey, `${at}.sql_warehouse.id`, warehouseId) });
      }

      const scope = toRecord(entry.secret)?.scope;
      if (named(scope)) {
        // The same scope node a `{{secrets/...}}` in cluster config gets, matched on the scope's real name.
        const match = matchSecretScope(scope, scopes);
        const field = `${at}.secret.scope`;
        if (match.nodeId.startsWith("secret:")) {
          addNode({
            id: match.nodeId,
            kind: "secret_scope",
            nodeType: "secret_scope",
            displayName: scope,
            data: { scope, ...(match.resourceKeyMisuse ? { resourceKeyMisuse: match.resourceKeyMisuse } : {}) },
          });
        }
        addEdge({
          id: `${source}->secret->${match.nodeId}@${source}.${field}`,
          source,
          target: match.nodeId,
          kind: "references",
          data: { ...edgeData("apps", appKey, field, scope), appResource: true },
        });
      }

      const endpoint = toRecord(entry.serving_endpoint)?.name;
      if (named(endpoint)) link("model_serving_endpoints", endpoint, `${at}.serving_endpoint.name`);

      const otherApp = toRecord(entry.app)?.name;
      if (named(otherApp)) link("apps", otherApp, `${at}.app.name`);

      const instance = toRecord(entry.database)?.instance_name;
      if (named(instance)) link("database_instances", instance, `${at}.database.instance_name`);

      const securable = toRecord(entry.uc_securable);
      const securableType = typeof securable?.securable_type === "string" ? securable.securable_type.toUpperCase() : "";
      const fullName = securable?.securable_full_name;
      if (UC_SECURABLE_GROUPS[securableType] && named(fullName)) {
        link(UC_SECURABLE_GROUPS[securableType]!, fullName, `${at}.uc_securable.securable_full_name`);
      }

      // A database is inside a branch, so the database is the more exact box when both are given.
      const postgres = toRecord(entry.postgres);
      if (named(postgres?.database)) link("postgres_databases", postgres.database, `${at}.postgres.database`);
      else if (named(postgres?.branch)) link("postgres_branches", postgres.branch, `${at}.postgres.branch`);
    });
  }
}

function addResourceReferences(
  parsedBundle: ParsedBundleConfig,
  { resourceSourceMap, yamlLocationMaps }: SourceIndex,
  addEdge: (edge: BundleEdge) => void,
): void {
  for (const [group, resources] of Object.entries(parsedBundle.resources ?? {})) {
    if (group === "jobs" || !resources || typeof resources !== "object") continue;
    for (const [resourceKey, resource] of Object.entries(resources as Record<string, unknown>)) {
      const source = `resources.${group}.${resourceKey}`;
      const file = resourceSourceMap.get(`${group}.${resourceKey}`) ?? "";
      for (const ref of findResourceReferences(resource, "")) {
        const target = `resources.${ref.group}.${ref.key}`;
        if (target === source) continue;
        const yamlPath = `${source}.${ref.yamlPath}`;
        const location = yamlLocationMaps.get(file)?.get(yamlPath);
        addEdge({
          id: `${source}->references->${target}`,
          source,
          target,
          kind: "references",
          data: {
            expression: ref.expression,
            yamlPath,
            ...(file ? { file } : {}),
            ...(location ? { line: location.line, column: location.column } : {}),
          },
        });
      }
    }
  }
}
