export type VariableValue = unknown;

export interface Variable {
  type?: "complex";
  default?: VariableValue;
  description?: string;
  value?: VariableValue;
  lookup?: Record<string, unknown>;
}

export type Variables = Record<string, Variable>;

export interface JobPermission {
  [key: string]: unknown;
}

export interface JobTaskDependency {
  task_key?: string;
  [key: string]: unknown;
}

export interface JobTask {
  task_key?: string;
  depends_on?: JobTaskDependency[];
  clean_rooms_notebook_task?: {
    notebook_path?: string;
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
  sql_alert_task?: {
    alert_id?: string;
    pause_subscriptions?: boolean;
  };
  dbt_task?: {
    commands?: string[];
    warehouse_id?: string;
  };
  dbt_platform_task?: {
    commands?: string[];
    warehouse_id?: string;
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
    dashboard_id?: string;
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
  permissions?: JobPermission[];
  parameters?: Array<{ name?: string; default?: string }>;
  trigger?: {
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

export interface ParsedBundleConfig {
  bundle: Bundle;
  sync?: Sync;
  variables?: Variables;
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
}

export interface GraphCompute {
  kind: string;
  label: string;
}

export interface BundleGraphNode {
  id: string;
  kind: string;
  nodeType: "job" | "task" | "resource";
  displayName: string;
  taskTypeLabel?: string;
  subtitle?: string;
  status?: string;
  trigger?: string;
  runAs?: string;
  taskCount?: number;
  parameters?: GraphParameter[];
  compute?: GraphCompute[];
  resourceGroup?: string;
  resourceKey?: string;
  taskKey?: string;
  parentId?: string;
  data: Record<string, unknown>;
}

export interface BundleGraphEdge {
  id: string;
  source: string;
  target: string;
  relationship: "contains" | "depends_on";
}

export interface BundleGraph {
  nodes: BundleGraphNode[];
  edges: BundleGraphEdge[];
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return {};
}

function getResourceDisplayName(
  resourceKey: string,
  resourceData: Record<string, unknown>,
): string {
  return typeof resourceData.name === "string" ? resourceData.name : resourceKey;
}

function normalizeReference(value: string): string {
  const variableReference = value.match(/^\$\{var\.([^}]+)\}$/);
  if (variableReference?.[1]) {
    return variableReference[1];
  }

  return value;
}

function withOptionalSubtitle(
  kind: string,
  label: string,
  subtitle?: string,
): {
  kind: string;
  label: string;
  subtitle?: string;
} {
  return {
    kind,
    label,
    ...(subtitle ? { subtitle } : {}),
  };
}

function detectTaskType(task: JobTask): {
  kind: string;
  label: string;
  subtitle?: string;
} {
  if (task.clean_rooms_notebook_task) {
    return withOptionalSubtitle(
      "notebook",
      "Clean room",
      task.clean_rooms_notebook_task.notebook_path,
    );
  }

  if (task.condition_task) {
    return withOptionalSubtitle("job", "If/else", task.condition_task.op);
  }

  if (task.dashboard_task) {
    return withOptionalSubtitle(
      "dashboard",
      "Dashboards",
      task.dashboard_task.dashboard_id,
    );
  }

  if (task.sql_alert_task) {
    return withOptionalSubtitle(
      "alert",
      "SQL Alert (Beta)",
      task.sql_alert_task.alert_id,
    );
  }

  if (task.dbt_task) {
    return withOptionalSubtitle(
      "script",
      "dbt",
      task.dbt_task.commands?.join(" "),
    );
  }

  if (task.dbt_platform_task) {
    return withOptionalSubtitle(
      "script",
      "dbt platform (Beta)",
      task.dbt_platform_task.commands?.join(" "),
    );
  }

  if (task.for_each_task) {
    return withOptionalSubtitle("job", "For each", task.for_each_task.inputs);
  }

  if (task.spark_jar_task) {
    return withOptionalSubtitle(
      "script",
      "JAR",
      task.spark_jar_task.main_class_name,
    );
  }

  if (task.notebook_task) {
    return withOptionalSubtitle(
      "notebook",
      "Notebook",
      task.notebook_task.notebook_path,
    );
  }

  if (task.pipeline_task) {
    return withOptionalSubtitle(
      "pipeline",
      "Pipeline",
      task.pipeline_task.pipeline_id
        ? normalizeReference(task.pipeline_task.pipeline_id)
        : undefined,
    );
  }

  if (task.power_bi_task) {
    return withOptionalSubtitle(
      "dashboard",
      "Power BI",
      task.power_bi_task.dashboard_id,
    );
  }

  if (task.spark_python_task) {
    return withOptionalSubtitle(
      "script",
      "Python script",
      task.spark_python_task.python_file,
    );
  }

  if (task.python_wheel_task) {
    return withOptionalSubtitle(
      "script",
      "Python wheel",
      task.python_wheel_task.package_name,
    );
  }

  if (task.run_job_task) {
    return withOptionalSubtitle(
      "job",
      "Run Job",
      task.run_job_task.job_id,
    );
  }

  if (task.sql_task) {
    return withOptionalSubtitle("sql", "SQL", task.sql_task.file?.path);
  }

  if (task.spark_submit_task) {
    return withOptionalSubtitle(
      "script",
      "Spark Submit",
      task.spark_submit_task.parameters?.join(" "),
    );
  }

  return {
    kind: "job",
    label: "Task",
    subtitle: "Other task settings",
  };
}

function formatTrigger(job: Job): string {
  const periodic = job.trigger?.periodic;

  if (!periodic?.interval || !periodic.unit) {
    return "Not specified";
  }

  const unit = periodic.interval === 1 ? periodic.unit.slice(0, -1) : periodic.unit;
  return `Every ${periodic.interval} ${unit.toLowerCase()}`;
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
      value:
        typeof parameter.default === "string" ? normalizeReference(parameter.default) : "set",
    }));
}

function stringifyParameterValue(value: unknown): string {
  if (typeof value === "string") {
    return normalizeReference(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => stringifyParameterValue(item)).join(", ");
  }

  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }

  return "set";
}

function getTaskPayload(task: JobTask): Record<string, unknown> | null {
  const taskPayloadKeys = [
    "clean_rooms_notebook_task",
    "condition_task",
    "dashboard_task",
    "sql_alert_task",
    "dbt_task",
    "dbt_platform_task",
    "for_each_task",
    "spark_jar_task",
    "notebook_task",
    "pipeline_task",
    "power_bi_task",
    "sql_task",
    "spark_python_task",
    "python_wheel_task",
    "run_job_task",
    "spark_submit_task",
  ] as const;

  for (const taskPayloadKey of taskPayloadKeys) {
    const taskPayload = task[taskPayloadKey];
    if (typeof taskPayload === "object" && taskPayload !== null) {
      return taskPayload as Record<string, unknown>;
    }
  }

  return null;
}

function getEffectiveTaskParameters(
  job: Job,
  task: JobTask,
): GraphParameter[] | undefined {
  const mergedParameters = new Map<string, string>();

  for (const parameter of job.parameters ?? []) {
    if (typeof parameter.name !== "string") {
      continue;
    }

    mergedParameters.set(
      parameter.name,
      stringifyParameterValue(parameter.default),
    );
  }

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

  if (mergedParameters.size === 0) {
    return undefined;
  }

  return [...mergedParameters.entries()].map(([name, value]) => ({
    name,
    value,
  }));
}

function getTaskCompute(task: JobTask): GraphCompute[] {
  const compute: GraphCompute[] = [];

  if (task.sql_task?.warehouse_id) {
    compute.push({
      kind: "sqlWarehouse",
      label: normalizeReference(task.sql_task.warehouse_id),
    });
  }

  if (task.job_cluster_key) {
    compute.push({
      kind: "cluster",
      label: task.job_cluster_key,
    });
  }

  if (task.existing_cluster_id) {
    compute.push({
      kind: "cluster",
      label: task.existing_cluster_id,
    });
  }

  return compute;
}

function getJobComputeSummary(tasks: JobTask[]): GraphCompute[] {
  const computeMap = new Map<string, GraphCompute>();

  tasks.forEach((task) => {
    getTaskCompute(task).forEach((item) => {
      computeMap.set(`${item.kind}:${item.label}`, item);
    });
  });

  if (computeMap.size === 0) {
    return [{ kind: "cluster", label: "Serverless / inherited compute" }];
  }

  return [...computeMap.values()];
}

/**
 * Flattens all resource entries from a parsed bundle config into a uniform list.
 *
 * @param parsedBundle The validated bundle configuration produced by `databricks bundle validate`.
 * @returns An array of resource nodes, one per named resource across all resource groups.
 */
export function extractResourceNodes(
  parsedBundle: ParsedBundleConfig,
): ResourceNode[] {
  const nodes: ResourceNode[] = [];

  for (const [resourceGroup, resourceMap] of Object.entries(
    parsedBundle.resources ?? {},
  )) {
    const typedResourceMap = (resourceMap ?? {}) as Record<string, unknown>;

    for (const [resourceKey, resourceValue] of Object.entries(typedResourceMap)) {
      const resourceData = toRecord(resourceValue);

      nodes.push({
        id: `resources.${resourceGroup}.${resourceKey}`,
        resourceGroup,
        resourceKey,
        displayName: getResourceDisplayName(resourceKey, resourceData),
        data: resourceData,
      });
    }
  }

  return nodes;
}

/**
 * Builds a graph of nodes and edges from a parsed bundle config.
 *
 * Jobs are expanded into job nodes and individual task nodes connected by
 * `contains` edges. Task-to-task `depends_on` relationships become `depends_on`
 * edges. All other resource types become single leaf nodes.
 *
 * @param parsedBundle The validated bundle configuration produced by `databricks bundle validate`.
 * @returns A graph with `nodes` (jobs, tasks, and other resources) and `edges`
 *   (containment and dependency relationships).
 */
export function extractBundleGraph(
  parsedBundle: ParsedBundleConfig,
): BundleGraph {
  const resourceNodes = extractResourceNodes(parsedBundle);
  const nodes: BundleGraphNode[] = [];
  const edges: BundleGraphEdge[] = [];

  resourceNodes.forEach((resourceNode) => {
    if (resourceNode.resourceGroup !== "jobs") {
      nodes.push({
        id: resourceNode.id,
        kind: resourceNode.resourceGroup.replace(/s$/, ""),
        nodeType: "resource",
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

    nodes.push({
      id: jobId,
      kind: "job",
      nodeType: "job",
      displayName: resourceNode.displayName,
      trigger: formatTrigger(job),
      runAs: formatRunAs(job),
      taskCount: tasks.length,
      parameters: getParameterSummary(job),
      compute: getJobComputeSummary(tasks),
      resourceGroup: resourceNode.resourceGroup,
      resourceKey: resourceNode.resourceKey,
      data: resourceNode.data,
    });

    tasks.forEach((task, taskIndex) => {
      const taskKey = task.task_key ?? `task-${taskIndex + 1}`;
      const taskId = `${jobId}.tasks.${taskKey}`;
      const taskCompute = getTaskCompute(task);
      const taskType = detectTaskType(task);
      const taskParameters = getEffectiveTaskParameters(job, task);

      nodes.push({
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
        data: toRecord(task),
        ...(taskType.subtitle ? { subtitle: taskType.subtitle } : {}),
      });

      edges.push({
        id: `${jobId}->${taskId}`,
        source: jobId,
        target: taskId,
        relationship: "contains",
      });

      const dependencies = Array.isArray(task.depends_on) ? task.depends_on : [];
      dependencies.forEach((dependency) => {
        if (!dependency.task_key) {
          return;
        }

        edges.push({
          id: `${jobId}.tasks.${dependency.task_key}->${taskId}`,
          source: `${jobId}.tasks.${dependency.task_key}`,
          target: taskId,
          relationship: "depends_on",
        });
      });
    });
  });

  return { nodes, edges };
}
