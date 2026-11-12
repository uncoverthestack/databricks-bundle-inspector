/**
 * The Settings a compute box shows in the bundle overview's details (issue 417): a SQL
 * warehouse's, a cluster's or a job cluster's key settings in the labels Databricks shows on
 * its own pages, its permissions, and an "Also set" list naming every other field the bundle
 * sets, each with the line it is written on. For serverless compute: the jobs' environments
 * and performance targets. Only what the bundle sets is shown; no default is guessed.
 */

export interface SettingRow {
  label: string;
  value: string;
  /** The value as written when the label puts it in words, such as `SINGLE_USER`. */
  raw?: string;
  /** Written with `${...}`: the value is shown as written, in grey. */
  expression?: boolean;
  /** One value per line, such as an environment's dependencies. */
  lines?: string[];
}

export interface SettingSection {
  title: string;
  rows: SettingRow[];
}

export interface AlsoSetField {
  field: string;
  /** How many entries a list or map has. */
  count?: number;
  line?: number;
}

export interface ComputeSettings {
  sections: SettingSection[];
  alsoSet: AlsoSetField[];
  /** The file the "Also set" lines are in. */
  file?: string;
}

type Resolve = (value: string) => string;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const isSet = (value: unknown) => value !== undefined && value !== null && value !== "";

/** An API value in words, as Databricks shows it: CAN_MANAGE is "Can manage". */
export function words(value: string): string {
  const text = value.toLowerCase().replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A row for a value that may be written with `${...}`: shown resolved for the target, else as written. */
function row(label: string, value: unknown, resolve: Resolve, show: (text: string) => string = (text) => text): SettingRow | undefined {
  if (!isSet(value)) return undefined;
  const text = String(value);
  if (!text.includes("${")) return { label, value: show(text) };
  const resolved = resolve(text);
  return resolved.includes("${") ? { label, value: text, expression: true } : { label, value: show(resolved) };
}

const minutes = (text: string) => (text === "0" ? "Off" : `After ${text} minute${text === "1" ? "" : "s"}`);

// Access modes, from the CLI schema's description of data_security_mode (v1.26.0): the
// legacy aliases USER_ISOLATION and SINGLE_USER are Standard and Dedicated.
const ACCESS_MODES: Record<string, string> = {
  DATA_SECURITY_MODE_AUTO: "Auto",
  DATA_SECURITY_MODE_STANDARD: "Standard",
  USER_ISOLATION: "Standard",
  DATA_SECURITY_MODE_DEDICATED: "Dedicated",
  SINGLE_USER: "Dedicated",
};

function permissionsSection(permissions: unknown, resolve: Resolve): SettingSection | undefined {
  if (!Array.isArray(permissions)) return undefined;
  const rows = permissions.flatMap((entry) => {
    const permission = record(entry);
    const who = permission.user_name ?? permission.group_name ?? permission.service_principal_name;
    if (!isSet(who) || !isSet(permission.level)) return [];
    const level = row(String(resolve(String(who))), permission.level, resolve, words);
    return level ? [level] : [];
  });
  return rows.length > 0 ? { title: "Permissions", rows } : undefined;
}

/** The fields the bundle sets that Settings and Permissions don't show, with their lines. */
function alsoSet(
  config: Record<string, unknown>,
  shown: ReadonlySet<string>,
  fieldLines: Record<string, number> | undefined,
  prefix = "",
): AlsoSetField[] {
  // The fields as written, where known (fieldLines), else the ones the CLI output sets.
  const fromLines = fieldLines
    ? Object.keys(fieldLines)
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("."))
        .map((key) => key.slice(prefix.length))
    : [];
  const written = fromLines.length > 0 ? fromLines : Object.keys(config).filter((field) => isSet(config[field]));
  return written
    .filter((field) => !shown.has(field))
    .sort()
    .map((field) => {
      const value = config[field];
      const count = Array.isArray(value) ? value.length : typeof value === "object" && value !== null ? Object.keys(value).length : undefined;
      const line = fieldLines?.[`${prefix}${field}`];
      return { field, ...(count !== undefined ? { count } : {}), ...(line ? { line } : {}) };
    });
}

const WAREHOUSE_FIELDS = new Set([
  "name",
  "enable_serverless_compute",
  "warehouse_type",
  "cluster_size",
  "auto_stop_mins",
  "min_num_clusters",
  "max_num_clusters",
  "channel",
  "permissions",
]);

/** A SQL warehouse resource's settings, in the rows of its Overview page in Databricks. */
export function warehouseSettings(
  config: Record<string, unknown>,
  resolve: Resolve = (value) => value,
  fieldLines?: Record<string, number>,
  file?: string,
): ComputeSettings {
  const serverless = config.enable_serverless_compute;
  const type =
    serverless === true || serverless === "true"
      ? { label: "Type", value: "Serverless" }
      : row("Type", config.warehouse_type, resolve, words);
  const scaling = [
    isSet(config.min_num_clusters) ? `Min ${resolve(String(config.min_num_clusters))}` : "",
    isSet(config.max_num_clusters) ? `Max ${resolve(String(config.max_num_clusters))}` : "",
  ].filter(Boolean);
  const rows = [
    row("Name", config.name, resolve),
    type,
    row("Cluster size", config.cluster_size, resolve),
    row("Auto stop", config.auto_stop_mins, resolve, minutes),
    scaling.length > 0 ? { label: "Scaling", value: scaling.join(" · ") } : undefined,
    row("Channel", record(config.channel).name, resolve, (text) => words(text.replace(/^CHANNEL_NAME_/, ""))),
  ].filter((entry): entry is SettingRow => entry !== undefined);
  return settings(rows, permissionsSection(config.permissions, resolve), alsoSet(config, WAREHOUSE_FIELDS, fieldLines), file);
}

const CLUSTER_FIELDS = new Set([
  "cluster_name",
  "spark_version",
  "node_type_id",
  "num_workers",
  "autoscale",
  "data_security_mode",
  "autotermination_minutes",
  "permissions",
]);

/**
 * A cluster's settings: a `clusters` resource, or a job cluster's `new_cluster`, whose
 * field lines are under `job_clusters.<key>.`.
 */
export function clusterSettings(
  config: Record<string, unknown>,
  resolve: Resolve = (value) => value,
  fieldLines?: Record<string, number>,
  file?: string,
  fieldPrefix = "",
): ComputeSettings {
  const autoscale = record(config.autoscale);
  const workers = isSet(config.num_workers)
    ? row("Workers", config.num_workers, resolve)
    : isSet(autoscale.min_workers) || isSet(autoscale.max_workers)
      ? {
          label: "Workers",
          value: `${isSet(autoscale.min_workers) ? resolve(String(autoscale.min_workers)) : "?"} – ${
            isSet(autoscale.max_workers) ? resolve(String(autoscale.max_workers)) : "?"
          }, autoscaling`,
        }
      : undefined;
  const mode = row("Access mode", config.data_security_mode, resolve);
  const access = mode && !mode.expression && ACCESS_MODES[mode.value] ? { ...mode, value: ACCESS_MODES[mode.value]!, raw: mode.value } : mode;
  const rows = [
    row("Name", config.cluster_name, resolve),
    row("Runtime", config.spark_version, resolve),
    row("Worker type", config.node_type_id, resolve),
    workers,
    access,
    row("Auto termination", config.autotermination_minutes, resolve, minutes),
  ].filter((entry): entry is SettingRow => entry !== undefined);
  return settings(rows, permissionsSection(config.permissions, resolve), alsoSet(config, CLUSTER_FIELDS, fieldLines, fieldPrefix), file);
}

function settings(rows: SettingRow[], permissions: SettingSection | undefined, also: AlsoSetField[], file: string | undefined): ComputeSettings {
  return {
    sections: [...(rows.length > 0 ? [{ title: "Settings", rows }] : []), ...(permissions ? [permissions] : [])],
    alsoSet: also,
    ...(file ? { file } : {}),
  };
}

export interface ServerlessJob {
  /** The job's resource key. */
  jobKey: string;
  /** The job's resolved settings, for its `environments`, `performance_target` and `tasks`. */
  job: Record<string, unknown>;
  /** The keys of its tasks that run on serverless or inherited compute. */
  taskKeys: string[];
}

/**
 * Serverless compute's settings: each environment the tasks use, by job, and each job's
 * performance target. A notebook task with no environment in the job gets one row that
 * says only what the bundle says: the job doesn't set it.
 */
export function serverlessSettings(jobs: ServerlessJob[], resolve: Resolve = (value) => value): ComputeSettings {
  const sections: SettingSection[] = [];
  const severalJobs = jobs.length > 1;
  const notebookRows = new Map<string, string[]>();
  const performance: SettingRow[] = [];

  for (const { jobKey, job, taskKeys } of jobs) {
    const tasks = new Map(
      (Array.isArray(job.tasks) ? job.tasks : []).map((task) => [String(record(task).task_key), record(task)] as const),
    );
    const environments = new Map(
      (Array.isArray(job.environments) ? job.environments : []).map((environment) => [
        String(record(environment).environment_key),
        record(record(environment).spec),
      ]),
    );
    const byEnvironment = new Map<string, string[]>();
    for (const taskKey of taskKeys) {
      const task = tasks.get(taskKey);
      if (!task) continue;
      if (isSet(task.environment_key)) {
        const key = resolve(String(task.environment_key));
        byEnvironment.set(key, [...(byEnvironment.get(key) ?? []), taskKey]);
      } else if (task.notebook_task) {
        // An .ipynb can carry its own environment, which a job runs on (#419); a source notebook can't.
        const path = String(record(task.notebook_task).notebook_path ?? "");
        const text = /\.ipynb$/i.test(path)
          ? "Not set in the job. The notebook may set its own."
          : "Not set in the job. Databricks chooses the version.";
        notebookRows.set(text, [...(notebookRows.get(text) ?? []), severalJobs ? `${jobKey}.${taskKey}` : taskKey]);
      }
    }
    for (const [key, taskList] of byEnvironment) {
      const spec = environments.get(key);
      const rows = spec
        ? [
            row("Version", spec.environment_version, resolve),
            row("Client", spec.client, resolve),
            row("Base environment", spec.base_environment, resolve),
            row("Project", spec.project_environment, resolve),
            Array.isArray(spec.dependencies) && spec.dependencies.length > 0
              ? { label: "Dependencies", value: `${spec.dependencies.length}`, lines: spec.dependencies.map((d) => resolve(String(d))) }
              : undefined,
          ].filter((entry): entry is SettingRow => entry !== undefined)
        : [{ label: "Version", value: "Not in the job's environments" }];
      rows.push({ label: "Tasks", value: taskList.join(", ") });
      sections.push({ title: `Environment ${key}${severalJobs ? ` · ${jobKey}` : ""}`, rows });
    }
    const target = row(jobKey, job.performance_target, resolve, words);
    if (target) performance.push(target);
  }

  if (notebookRows.size > 0) {
    sections.push({
      title: "Notebook tasks",
      rows: [...notebookRows].flatMap(([text, taskList]) => [
        { label: "Environment", value: text },
        { label: "Tasks", value: taskList.join(", ") },
      ]),
    });
  }
  if (performance.length > 0) sections.push({ title: "Performance", rows: performance });
  return { sections, alsoSet: [] };
}
