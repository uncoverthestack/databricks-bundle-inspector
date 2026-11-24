import { existsSync, readdirSync } from "node:fs";
import { checkNotebookPath, type NotebookHeaderRule, type NotebookPathProblem } from "../notebookFiles.js";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRemotePath as isRemotePathRule } from "../fileStatus.js";
import { hasGlobCharacters } from "../goGlob.js";
import { localLibrary } from "../localLibraries.js";

export interface TaskNodeData {
  taskKey: string;
  taskType: TaskType;
  parentJobId: string;
  sourceFile: string;
  sourceLine: number;
  sourceColumn: number;

  fileReferences: FileReference[];
  variableReferences: VariableReference[];
  libraryReferences: LibraryReference[];
  resourceReferences: ResourceReference[];
  jobParameterReferences: JobParameterReference[];
  taskParameterReferences: TaskParameterReference[];
  /** A pipeline task's selected tables and flows (issue 539), when it sets any. */
  pipelineSelections?: PipelineSelection[];

  dependsOn: string[];
  runIf: string | undefined;
  // TODO: Our Databricks Bundle Inspector Comment
  dbiComment: string | undefined;
  nestedTask: TaskNodeData | undefined;
}

/** One name in a `pipeline_task`'s refresh selection, with where it is written. */
export interface PipelineSelection {
  field: "refresh_selection" | "full_refresh_selection" | "refresh_flow_selection";
  name: string;
  yamlPath: string;
  sourceLine: number;
  sourceColumn?: number;
}

/**
 * The selection fields checked against the pipeline (issue 539). Each was run live with an
 * unknown name, which failed the run; `reset_checkpoint_selection` has not been, so it isn't read.
 */
const PIPELINE_SELECTION_FIELDS = ["refresh_selection", "full_refresh_selection", "refresh_flow_selection"] as const;

function getPipelineSelections(
  rawTask: Record<string, unknown>,
  taskKey: string,
  resolveSourceLocation?: SourceLocationResolver,
): PipelineSelection[] {
  const pipelineTask = rawTask.pipeline_task;
  if (typeof pipelineTask !== "object" || pipelineTask === null) return [];
  const selections: PipelineSelection[] = [];
  for (const field of PIPELINE_SELECTION_FIELDS) {
    // The structural preview keeps `${var.tables}` as text: not a list, so not checked.
    const names = (pipelineTask as Record<string, unknown>)[field];
    if (!Array.isArray(names)) continue;
    names.forEach((name, index) => {
      if (typeof name !== "string" || !name.trim()) return;
      const yamlPath = `tasks.${taskKey}.pipeline_task.${field}[${index}]`;
      const location = resolveSourceLocation?.(yamlPath);
      selections.push({
        field,
        name,
        yamlPath,
        sourceLine: location?.line ?? 0,
        ...(location?.column ? { sourceColumn: location.column } : {}),
      });
    });
  }
  return selections;
}

export type TaskType =
  | "notebook"
  | "sql"
  | "python_wheel"
  | "spark_jar"
  | "spark_python"
  | "spark_submit"
  | "pipeline"
  | "run_job"
  | "dbt"
  | "dbt_cloud"
  | "condition"
  | "for_each"
  | "dashboard"
  | "power_bi"
  | "alert"
  | "ai_runtime"
  | "gen_ai_compute"
  | "python_operator"
  | "ai_function"
  | "unknown";

/**
 * Every job task payload key in the bundle schema (`databricks bundle schema`, CLI 1.24.0),
 * mapped to the inspector's task type. This is the single list of supported task types:
 * labels, parameters and classification all derive from it.
 */
const TASK_TYPE_BY_PAYLOAD_KEY = {
  notebook_task: "notebook",
  clean_rooms_notebook_task: "notebook",
  sql_task: "sql",
  python_wheel_task: "python_wheel",
  spark_jar_task: "spark_jar",
  spark_python_task: "spark_python",
  spark_submit_task: "spark_submit",
  pipeline_task: "pipeline",
  run_job_task: "run_job",
  dbt_task: "dbt",
  dbt_platform_task: "dbt",
  dbt_cloud_task: "dbt_cloud",
  condition_task: "condition",
  for_each_task: "for_each",
  dashboard_task: "dashboard",
  power_bi_task: "power_bi",
  alert_task: "alert",
  ai_runtime_task: "ai_runtime",
  gen_ai_compute_task: "gen_ai_compute",
  python_operator_task: "python_operator",
  ai_function_task: "ai_function",
} as const satisfies Record<string, Exclude<TaskType, "unknown">>;

export type TaskPayloadKey = keyof typeof TASK_TYPE_BY_PAYLOAD_KEY;

export const TASK_PAYLOAD_KEYS = Object.keys(
  TASK_TYPE_BY_PAYLOAD_KEY,
) as TaskPayloadKey[];

/** Returns the recognised payload key on a task (e.g. `notebook_task`), if any. */
export function getTaskPayloadKey(
  task: Record<string, unknown>,
): TaskPayloadKey | undefined {
  return TASK_PAYLOAD_KEYS.find((key) => {
    const payload = task[key];
    return typeof payload === "object" && payload !== null;
  });
}

/**
 * Returns the `*_task` key of a task type the inspector does not recognise,
 * so it can be shown by name instead of as an anonymous task.
 */
export function getUnrecognisedTaskKey(
  task: Record<string, unknown>,
): string | undefined {
  return Object.keys(task).find(
    (key) => key.endsWith("_task") && !(key in TASK_TYPE_BY_PAYLOAD_KEY),
  );
}

export interface FileReference {
  path: string;
  resolvedPath: string | undefined;
  exists: boolean;
  source: "GIT" | "WORKSPACE" | undefined;
  /**
   * `source: GIT` on a task whose job has no `git_source` (#521). The CLI reads the path as a
   * local file then, so `source` is left out and the path is checked like any other; deploy
   * fails on the setting itself ("source is set to GIT but no git_source settings are provided").
   */
  strayGitSource?: true;
  isInGitignore: boolean;
  /** Set when the path breaks the CLI's notebook rules (see notebookFiles.ts). */
  notebookProblem?: NotebookPathProblem;
  referenceType:
    | "notebook"
    | "sql"
    | "python_script"
    | "python_wheel"
    | "jar"
    | "directory"
    | "dbt_project";
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
  yamlPath: string;
}

export interface LibraryReference {
  libraryType: "pypi" | "maven" | "whl" | "jar" | "cran" | "egg";
  identifier: string;
  isLocal: boolean;
  resolvedPath: string | undefined;
  exists: boolean | undefined;
  sourceLine: number;
  sourceColumn?: number;
  yamlPath: string;
}

export interface VariableReference {
  expression: string;
  variableName: string;
  resolvedValue: string | undefined;
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
  yamlPath: string;
}

export interface ResourceReference {
  expression: string;
  resourceType: string;
  resourceName: string;
  field: string;
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
  yamlPath: string;
}

export interface JobParameterReference {
  name: string;
  default: string | undefined;
  // TODO: Our Databricks Bundle Inspector Comment
  dbiComment: string | undefined;
  sourceLine: number;
  sourceColumn?: number;
  referencedByTasks: string[];
  hasRuntimeOnlyUsage: boolean;
}

export interface TaskParameterReference {
  name: string;
  value: string | undefined;
  jobParameterDefault: string | undefined;
  /**
   * The task's value comes from a job parameter: a job parameter with the same name, which
   * Databricks uses instead of the task's value, or a `{{job.parameters.<name>}}` reference.
   */
  isOverriddenByJob: boolean;
  /** The job parameter the value comes from, when `isOverriddenByJob`. */
  jobParameterName?: string;
  /** A job parameter has the same name, so the task's own value is never used (issue 537). */
  ignoredByJob?: boolean;
  effectiveValue: string | undefined;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  containsVariableRef: boolean;
  // TODO: Our Databricks Bundle Inspector Comment
  dbiComment: string | undefined;
  sourceLine: number;
  sourceColumn?: number;
  yamlPath: string;
}

// --- internals ---

const VAR_PATTERN = /\$\{var\.([^}]+)\}/g;
/** `{{job.parameters.<name>}}`, or the older `${job.parameters.<name>}`. */
const JOB_PARAMETER_REFERENCE = /\{\{\s*job\.parameters\.([\w.-]+?)\s*\}\}|\$\{job\.parameters\.([\w.-]+?)\}/g;
const JOB_PARAMETER_REFERENCE_TEST = /\{\{\s*job\.parameters\.|\$\{job\.parameters\./;
const RESOURCE_PATTERN = /\$\{resources\.([^.}]+)\.([^.}]+)\.([^}]+)\}/g;
export const NOTEBOOK_EXTENSIONS = [".py", ".sql", ".scala", ".r", ".ipynb"];
const GIT_NOTEBOOK_EXTENSIONS = NOTEBOOK_EXTENSIONS;

export interface SourceLocation {
  line: number;
  column: number;
}

export type SourceLocationResolver = (yamlPath: string) => SourceLocation | undefined;

// Absolute workspace paths (with or without the /Workspace prefix) never exist locally.
export { isRemotePath } from "../fileStatus.js";

export function containsTemplate(p: string): boolean {
  return p.includes("${") || p.includes("{{");
}

/**
 * Whether `candidate` exists with the letter case written, for every folder and file
 * name below `anchor`. The workspace is case sensitive: on a disk that ignores case
 * (macOS, Windows) `./Notebooks/Main.py` finds `notebooks/main.py`, `bundle validate`
 * and deploy pass, and the job fails because sync uploads the real name (#475, checked
 * live on CLI v1.27.0). Names above `anchor` aren't uploaded, so they aren't compared.
 */
/**
 * Folder names, read once per check while one runs ({@link withFolderNames}): many tasks
 * share a folder, and one can hold thousands of files. Outside a check each lookup reads
 * the folder, and each check starts afresh, so a rename is always seen. A folder's
 * modified time can't tell instead: on Windows it didn't change for a rename in CI.
 */
let folderNames: Map<string, Set<string>> | undefined;
let checksRunning = 0;
function namesIn(folder: string): Set<string> {
  let names = folderNames?.get(folder);
  if (!names) {
    names = new Set(readdirSync(folder));
    folderNames?.set(folder, names);
  }
  return names;
}

/** Runs one check with folder names read once. Checks running at the same time share them. */
export async function withFolderNames<T>(check: () => Promise<T>): Promise<T> {
  if (checksRunning++ === 0) folderNames = new Map();
  try {
    return await check();
  } finally {
    if (--checksRunning === 0) folderNames = undefined;
  }
}

export function existsWithCase(candidate: string, anchor: string): boolean {
  if (!existsSync(candidate)) return false;
  const rel = relative(anchor, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  let folder = anchor;
  for (const name of rel.split(sep)) {
    try {
      if (!namesIn(folder).has(name)) return false;
    } catch {
      return true;
    }
    folder = join(folder, name);
  }
  return true;
}

/**
 * Whether a path the inspector didn't find is there only when letter case is ignored, as
 * on macOS and Windows. Then nothing should read it: on a case-sensitive disk, and in the
 * workspace, it isn't there (#475).
 */
export function foundOnlyIgnoringCase(resolvedPath: string, exists: boolean): boolean {
  return !exists && existsSync(resolvedPath);
}

/**
 * Where a relative path in the YAML points, and whether a file is there.
 *
 * Read from `primaryDir`, the folder of the YAML file that writes it, as the CLI does. Never
 * from the bundle root as well: no CLI version from 0.299.0 on reads it from there, so a path
 * written from the bundle root in `resources/job.yml` fails in the CLI (#518). The CLI's old
 * fallback, removed in v1.22.0, used the folder of the file defining the job, which is
 * `primaryDir` here too.
 *
 * @param bundleRoot The folder of `databricks.yml`: letter case is compared from there, and a
 *   Git notebook (`bundleRootOnly`) is read from there, as the repo's top folder.
 */
export function resolveLocalPath(
  rawPath: string,
  primaryDir: string,
  bundleRoot?: string,
  options?: {
    bundleRootOnly?: boolean;
    extensions?: string[];
  },
): { resolvedPath: string | undefined; exists: boolean } {
  if (isRemotePathRule(rawPath) || containsTemplate(rawPath)) {
    return { resolvedPath: undefined, exists: false };
  }
  if (isAbsolute(rawPath)) {
    return { resolvedPath: rawPath, exists: existsSync(rawPath) };
  }

  const baseDirs = options?.bundleRootOnly && bundleRoot ? [bundleRoot] : [primaryDir];
  const candidates = (baseDir: string) => {
    const exact = resolve(baseDir, rawPath);
    return [
      exact,
      ...(options?.extensions ?? []).map((extension) => `${exact}${extension}`),
    ];
  };

  // Names are compared from the bundle folder, when given, or the base folder.
  const anchor = bundleRoot ?? primaryDir;
  for (const baseDir of baseDirs) {
    for (const candidate of candidates(baseDir)) {
      if (existsWithCase(candidate, relative(anchor, candidate).startsWith("..") ? baseDir : anchor)) {
        return { resolvedPath: candidate, exists: true };
      }
    }
  }

  return { resolvedPath: candidates(baseDirs[0] ?? primaryDir)[0], exists: false };
}

function normalizedNotebookSource(value: unknown): "GIT" | "WORKSPACE" | undefined {
  if (value === "GIT") return "GIT";
  if (value === "WORKSPACE") return "WORKSPACE";
  return undefined;
}

function extractVarRefs(
  value: string,
  yamlPath: string,
  sourceFile: string,
  resolveSourceLocation?: SourceLocationResolver,
): VariableReference[] {
  const refs: VariableReference[] = [];
  VAR_PATTERN.lastIndex = 0;
  const sourceLocation = resolveSourceLocation?.(yamlPath);
  let match: RegExpExecArray | null;
  while ((match = VAR_PATTERN.exec(value)) !== null) {
    refs.push({
      expression: match[0],
      variableName: match[1]!,
      resolvedValue: undefined,
      sourceFile,
      sourceLine: sourceLocation?.line ?? 0,
      ...(sourceLocation ? { sourceColumn: sourceLocation.column } : {}),
      yamlPath,
    });
  }
  return refs;
}

function extractResourceRefs(
  value: string,
  yamlPath: string,
  sourceFile: string,
  resolveSourceLocation?: SourceLocationResolver,
): ResourceReference[] {
  const refs: ResourceReference[] = [];
  RESOURCE_PATTERN.lastIndex = 0;
  const sourceLocation = resolveSourceLocation?.(yamlPath);
  let match: RegExpExecArray | null;
  while ((match = RESOURCE_PATTERN.exec(value)) !== null) {
    refs.push({
      expression: match[0],
      resourceType: match[1]!,
      resourceName: match[2]!,
      field: match[3]!,
      sourceFile,
      sourceLine: sourceLocation?.line ?? 0,
      ...(sourceLocation ? { sourceColumn: sourceLocation.column } : {}),
      yamlPath,
    });
  }
  return refs;
}

function scanForRefs(
  obj: Record<string, unknown>,
  prefix: string,
  sourceFile: string,
  resolveSourceLocation?: SourceLocationResolver,
): { varRefs: VariableReference[]; resourceRefs: ResourceReference[] } {
  const varRefs: VariableReference[] = [];
  const resourceRefs: ResourceReference[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      varRefs.push(
        ...extractVarRefs(value, path, sourceFile, resolveSourceLocation),
      );
      resourceRefs.push(
        ...extractResourceRefs(value, path, sourceFile, resolveSourceLocation),
      );
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "string") {
          varRefs.push(
            ...extractVarRefs(
              item,
              `${path}[${i}]`,
              sourceFile,
              resolveSourceLocation,
            ),
          );
          resourceRefs.push(
            ...extractResourceRefs(
              item,
              `${path}[${i}]`,
              sourceFile,
              resolveSourceLocation,
            ),
          );
        } else if (typeof item === "object" && item !== null) {
          const nested = scanForRefs(
            item as Record<string, unknown>,
            `${path}[${i}]`,
            sourceFile,
            resolveSourceLocation,
          );
          varRefs.push(...nested.varRefs);
          resourceRefs.push(...nested.resourceRefs);
        }
      });
    } else if (typeof value === "object" && value !== null) {
      const nested = scanForRefs(
        value as Record<string, unknown>,
        path,
        sourceFile,
        resolveSourceLocation,
      );
      varRefs.push(...nested.varRefs);
      resourceRefs.push(...nested.resourceRefs);
    }
  }

  return { varRefs, resourceRefs };
}

function getTaskType(task: Record<string, unknown>): TaskType {
  const payloadKey = getTaskPayloadKey(task);
  return payloadKey ? TASK_TYPE_BY_PAYLOAD_KEY[payloadKey] : "unknown";
}

function getFileReferences(
  task: Record<string, unknown>,
  taskKey: string,
  sourceFileDir: string,
  bundleRoot: string,
  sourceFile: string,
  resolveSourceLocation?: SourceLocationResolver,
  notebookRule: NotebookHeaderRule = "contains",
  jobHasGitSource = false,
): FileReference[] {
  const refs: FileReference[] = [];

  /**
   * A task block's `source`, as the CLI uses it: GIT only in a job with a `git_source`.
   * Without one, the CLI reads the path as a local file whatever `source` says (CLI
   * `translate_paths_jobs.go` keys off the job's `git_source` only).
   */
  function sourceOf(block: Record<string, unknown> | undefined): {
    source: FileReference["source"];
    stray: boolean;
  } {
    const declared = normalizedNotebookSource(block?.source);
    if (declared === "GIT" && !jobHasGitSource) return { source: undefined, stray: true };
    return { source: declared, stray: false };
  }

  function addRef(
    rawPath: unknown,
    referenceType: FileReference["referenceType"],
    yamlSubPath: string,
    source?: FileReference["source"],
    expects?: "notebook" | "file",
    stray = false,
  ): void {
    if (typeof rawPath !== "string" || !rawPath) return;
    const gitNotebook =
      referenceType === "notebook" && source === "GIT";
    const { resolvedPath, exists } = resolveLocalPath(
      rawPath,
      sourceFileDir,
      bundleRoot,
      gitNotebook
        ? {
            bundleRootOnly: true,
            extensions: GIT_NOTEBOOK_EXTENSIONS,
          }
        : undefined,
    );
    const yamlPath = `tasks.${taskKey}.${yamlSubPath}`;
    const sourceLocation = resolveSourceLocation?.(yamlPath);
    const notebookProblem =
      expects && resolvedPath && !foundOnlyIgnoringCase(resolvedPath, exists)
        ? checkNotebookPath(rawPath, resolvedPath, expects, notebookRule, bundleRoot)
        : undefined;
    refs.push({
      path: rawPath,
      resolvedPath,
      exists,
      source,
      ...(stray ? { strayGitSource: true as const } : {}),
      isInGitignore: false,
      ...(notebookProblem ? { notebookProblem } : {}),
      referenceType,
      sourceFile,
      sourceLine: sourceLocation?.line ?? 0,
      ...(sourceLocation ? { sourceColumn: sourceLocation.column } : {}),
      yamlPath,
    });
  }

  const nb = task.notebook_task as Record<string, unknown> | undefined;
  if (nb) {
    const { source, stray } = sourceOf(nb);
    addRef(
      nb.notebook_path,
      "notebook",
      "notebook_task.notebook_path",
      source,
      source === "GIT" ? undefined : "notebook",
      stray,
    );
  }

  const cleanNb = task.clean_rooms_notebook_task as
    | Record<string, unknown>
    | undefined;
  if (cleanNb) {
    addRef(
      cleanNb.notebook_path,
      "notebook",
      "clean_rooms_notebook_task.notebook_path",
      normalizedNotebookSource(cleanNb.source),
    );
  }

  const py = task.spark_python_task as Record<string, unknown> | undefined;
  if (py) {
    const { source, stray } = sourceOf(py);
    addRef(
      py.python_file,
      "python_script",
      "spark_python_task.python_file",
      source,
      source === "GIT" ? undefined : "file",
      stray,
    );
  }

  const sql = task.sql_task as Record<string, unknown> | undefined;
  if (sql) {
    const sqlFile = sql.file as Record<string, unknown> | undefined;
    const { source, stray } = sourceOf(sqlFile);
    addRef(
      sqlFile?.path,
      "sql",
      "sql_task.file.path",
      source,
      source === "GIT" ? undefined : "file",
      stray,
    );
  }

  const dbt = (task.dbt_task ?? task.dbt_platform_task) as
    | Record<string, unknown>
    | undefined;
  if (dbt) {
    addRef(dbt.project_directory, "dbt_project", "dbt_task.project_directory");
  }

  return refs;
}

/**
 * A task library's local file. Deploy expands a `whl` or `jar` glob (`../dist/*.whl`) and
 * fails only when no file matches it (CLI v1.27.0, expand_glob_references.go), so a glob
 * exists when one file matches (#525). An `egg` glob is not expanded by the CLI.
 */
function libraryPath(
  rawPath: string,
  primaryDir: string,
  fallbackDir?: string,
): { resolvedPath: string | undefined; exists: boolean } {
  const plain = resolveLocalPath(rawPath, primaryDir, fallbackDir);
  if (plain.resolvedPath === undefined || !hasGlobCharacters(rawPath)) return plain;
  return localLibrary(rawPath, primaryDir);
}

function getLibraryReferences(
  task: Record<string, unknown>,
  taskKey: string,
  primaryDir: string,
  fallbackDir?: string,
  resolveSourceLocation?: SourceLocationResolver,
): LibraryReference[] {
  const libraries = task.libraries as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(libraries)) return [];

  const refs: LibraryReference[] = [];

  for (const [i, lib] of libraries.entries()) {
    const yamlPath = `tasks.${taskKey}.libraries[${i}]`;
    const sourceLocation = resolveSourceLocation?.(yamlPath);
    const sourceFields = {
      sourceLine: sourceLocation?.line ?? 0,
      ...(sourceLocation ? { sourceColumn: sourceLocation.column } : {}),
    };

    if (lib.pypi) {
      const pypi = lib.pypi as Record<string, unknown>;
      refs.push({
        libraryType: "pypi",
        identifier: typeof pypi.package === "string" ? pypi.package : "",
        isLocal: false,
        resolvedPath: undefined,
        exists: undefined,
        ...sourceFields,
        yamlPath,
      });
    } else if (lib.maven) {
      const maven = lib.maven as Record<string, unknown>;
      refs.push({
        libraryType: "maven",
        identifier:
          typeof maven.coordinates === "string" ? maven.coordinates : "",
        isLocal: false,
        resolvedPath: undefined,
        exists: undefined,
        ...sourceFields,
        yamlPath,
      });
    } else if (typeof lib.whl === "string") {
      const { resolvedPath, exists } = libraryPath(lib.whl, primaryDir, fallbackDir);
      const isLocal = resolvedPath !== undefined;
      refs.push({
        libraryType: "whl",
        identifier: lib.whl,
        isLocal,
        resolvedPath,
        exists: isLocal ? exists : undefined,
        ...sourceFields,
        yamlPath,
      });
    } else if (typeof lib.jar === "string") {
      const { resolvedPath, exists } = libraryPath(lib.jar, primaryDir, fallbackDir);
      const isLocal = resolvedPath !== undefined;
      refs.push({
        libraryType: "jar",
        identifier: lib.jar,
        isLocal,
        resolvedPath,
        exists: isLocal ? exists : undefined,
        ...sourceFields,
        yamlPath,
      });
    } else if (lib.cran) {
      const cran = lib.cran as Record<string, unknown>;
      refs.push({
        libraryType: "cran",
        identifier: typeof cran.package === "string" ? cran.package : "",
        isLocal: false,
        resolvedPath: undefined,
        exists: undefined,
        ...sourceFields,
        yamlPath,
      });
    } else if (typeof lib.egg === "string") {
      const { resolvedPath, exists } = resolveLocalPath(
        lib.egg,
        primaryDir,
        fallbackDir,
      );
      const isLocal = resolvedPath !== undefined;
      refs.push({
        libraryType: "egg",
        identifier: lib.egg,
        isLocal,
        resolvedPath,
        exists: isLocal ? exists : undefined,
        ...sourceFields,
        yamlPath,
      });
    }
  }

  return refs;
}

function getTaskBaseParameters(
  task: Record<string, unknown>,
): { params: Record<string, unknown>; payloadKey: string; field: string } | null {
  // A SQL file task passes `sql_task.parameters`, a map like base_parameters (issue 234).
  const sql = task.sql_task as Record<string, unknown> | undefined;
  if (sql && typeof sql.parameters === "object" && sql.parameters !== null && !Array.isArray(sql.parameters)) {
    return { params: sql.parameters as Record<string, unknown>, payloadKey: "sql_task", field: "parameters" };
  }
  const payloadKeys = [
    "notebook_task",
    "sql_task",
    "spark_python_task",
    "python_wheel_task",
    "spark_jar_task",
    "dbt_task",
    "dbt_platform_task",
    "for_each_task",
  ] as const;

  for (const key of payloadKeys) {
    const payload = task[key] as Record<string, unknown> | undefined;
    if (
      payload &&
      typeof payload.base_parameters === "object" &&
      payload.base_parameters !== null &&
      !Array.isArray(payload.base_parameters)
    ) {
      return {
        params: payload.base_parameters as Record<string, unknown>,
        payloadKey: key,
        field: "base_parameters",
      };
    }
  }

  return null;
}

function getJobParamDefaults(
  rawJob: Record<string, unknown>,
): Map<string, string> {
  const jobParameters = Array.isArray(rawJob.parameters)
    ? rawJob.parameters
    : [];
  return new Map(
    (jobParameters as Array<Record<string, unknown>>)
      .filter((p) => typeof p.name === "string")
      .map((p) => [
        p.name as string,
        typeof p.default === "string" ? p.default : "",
      ]),
  );
}

function getTaskParameterReferences(
  task: Record<string, unknown>,
  rawJob: Record<string, unknown>,
  taskKey: string,
  resolveSourceLocation?: SourceLocationResolver,
): TaskParameterReference[] {
  const result = getTaskBaseParameters(task);
  if (!result) return [];

  const { params, payloadKey, field } = result;
  const jobParamDefaults = getJobParamDefaults(rawJob);
  const refs: TaskParameterReference[] = [];

  for (const [paramName, paramValue] of Object.entries(params)) {
    const yamlPath = `tasks.${taskKey}.${payloadKey}.${field}.${paramName}`;
    const sourceLocation = resolveSourceLocation?.(yamlPath);
    const valueStr =
      typeof paramValue === "string" ? paramValue : String(paramValue ?? "");
    VAR_PATTERN.lastIndex = 0;
    const containsVariableRef = VAR_PATTERN.test(valueStr);
    // Databricks pushes job parameters down to tasks with key-value parameters, and a job
    // parameter wins over a task parameter with the same name (issue 537,
    // https://docs.databricks.com/aws/en/jobs/job-parameters). Otherwise the task's value
    // can still point at a job parameter, under any name.
    const ignoredByJob = jobParamDefaults.has(paramName);
    const referenced = [...valueStr.matchAll(JOB_PARAMETER_REFERENCE)].map((match) => match[1] ?? match[2]!);
    const isOverriddenByJob = ignoredByJob || referenced.length > 0;
    const jobParameterName = ignoredByJob ? paramName : referenced[0];
    const jobDefault = jobParameterName !== undefined ? jobParamDefaults.get(jobParameterName) : undefined;
    // The value the notebook or SQL file gets by default: the job parameter's, or the task's
    // with each job parameter it names filled in, when every one has a default.
    const filled = valueStr.replace(JOB_PARAMETER_REFERENCE, (whole, a: string | undefined, b: string | undefined) =>
      jobParamDefaults.get((a ?? b)!) || whole,
    );
    const effectiveValue = ignoredByJob
      ? jobDefault || undefined
      : referenced.length > 0
        ? JOB_PARAMETER_REFERENCE_TEST.test(filled) ? undefined : filled || undefined
        : valueStr || undefined;

    let confidence: TaskParameterReference["confidence"];
    if (
      containsVariableRef ||
      (isOverriddenByJob && jobDefault === undefined)
    ) {
      confidence = "LOW";
    } else if (isOverriddenByJob || jobDefault !== undefined) {
      confidence = "MEDIUM";
    } else {
      confidence = "HIGH";
    }

    refs.push({
      name: paramName,
      value: valueStr || undefined,
      jobParameterDefault: jobDefault,
      isOverriddenByJob,
      ...(jobParameterName !== undefined ? { jobParameterName } : {}),
      ...(ignoredByJob ? { ignoredByJob } : {}),
      effectiveValue,
      confidence,
      containsVariableRef,
      // TODO: Our Databricks Bundle Inspector Comment
      dbiComment: undefined,
      sourceLine: sourceLocation?.line ?? 0,
      ...(sourceLocation ? { sourceColumn: sourceLocation.column } : {}),
      yamlPath,
    });
  }

  return refs;
}

function getJobParameterReferences(
  rawJob: Record<string, unknown>,
  taskKey: string,
  resolveSourceLocation?: SourceLocationResolver,
): JobParameterReference[] {
  const jobParameters = Array.isArray(rawJob.parameters)
    ? rawJob.parameters
    : [];
  return (jobParameters as Array<Record<string, unknown>>)
    .filter((p) => typeof p.name === "string")
    .map((p, index) => {
      const sourceLocation = resolveSourceLocation?.(`parameters[${index}]`);
      return {
        name: p.name as string,
        default: typeof p.default === "string" ? p.default : undefined,
        // TODO: Our Databricks Bundle Inspector Comment
        dbiComment: undefined,
        sourceLine: sourceLocation?.line ?? 0,
        ...(sourceLocation ? { sourceColumn: sourceLocation.column } : {}),
        referencedByTasks: [taskKey],
        hasRuntimeOnlyUsage: typeof p.default !== "string",
      };
    });
}

/**
 * Builds a `TaskNodeData` from raw task and job objects out of a parsed bundle config.
 *
 * `sourceLine` / `sourceColumn` are populated when a YAML source-location resolver
 * is available. `isInGitignore` on file references is always false because the CLI
 * JSON output does not include gitignore state.
 *
 * @param rawTask Raw task object from the parsed bundle.
 * @param rawJob Raw job object that owns this task.
 * @param jobId Resource ID of the parent job node (e.g. `resources.jobs.my_job`).
 * @param taskKey The `task_key` value for this task.
 * @param bundleRoot Absolute path to the bundle root directory used to resolve local paths.
 * @param sourceFile Optional source file path stored on reference metadata.
 * @param resolveSourceLocation Optional resolver for YAML path source locations.
 */
export function buildTaskNodeData(
  rawTask: Record<string, unknown>,
  rawJob: Record<string, unknown>,
  jobId: string,
  taskKey: string,
  bundleRoot: string,
  sourceFile: string = "",
  sourceFileDir: string = "",
  resolveSourceLocation?: SourceLocationResolver,
  notebookRule: NotebookHeaderRule = "contains",
): TaskNodeData {
  const taskType = getTaskType(rawTask);
  const resolveBase = sourceFileDir || bundleRoot;
  const gitSource = rawJob.git_source;
  const fileReferences = getFileReferences(
    rawTask,
    taskKey,
    resolveBase,
    bundleRoot,
    sourceFile,
    resolveSourceLocation,
    notebookRule,
    Boolean(gitSource && typeof gitSource === "object"),
  );
  const libraryReferences = getLibraryReferences(
    rawTask,
    taskKey,
    resolveBase,
    bundleRoot,
    resolveSourceLocation,
  );
  const { varRefs: variableReferences, resourceRefs: resourceReferences } =
    scanForRefs(rawTask, `tasks.${taskKey}`, sourceFile, resolveSourceLocation);
  const taskParameterReferences = getTaskParameterReferences(
    rawTask,
    rawJob,
    taskKey,
    resolveSourceLocation,
  );
  const jobParameterReferences = getJobParameterReferences(
    rawJob,
    taskKey,
    resolveSourceLocation,
  );

  const pipelineSelections = getPipelineSelections(rawTask, taskKey, resolveSourceLocation);

  const dependsOn = Array.isArray(rawTask.depends_on)
    ? (rawTask.depends_on as Array<Record<string, unknown>>)
        .filter((d) => typeof d.task_key === "string")
        .map((d) => d.task_key as string)
    : [];

  const runIf = typeof rawTask.run_if === "string" ? rawTask.run_if : undefined;
  const taskSourceLocation = resolveSourceLocation?.(`tasks.${taskKey}`);

  let nestedTask: TaskNodeData | undefined;
  if (taskType === "for_each") {
    const forEachPayload = rawTask.for_each_task as
      | Record<string, unknown>
      | undefined;
    const nestedRaw = forEachPayload?.task;
    if (
      typeof nestedRaw === "object" &&
      nestedRaw !== null &&
      !Array.isArray(nestedRaw)
    ) {
      nestedTask = buildTaskNodeData(
        nestedRaw as Record<string, unknown>,
        rawJob,
        jobId,
        // Matches the YAML, so the inner task's paths resolve to real source lines.
        `${taskKey}.for_each_task.task`,
        bundleRoot,
        sourceFile,
        sourceFileDir,
        resolveSourceLocation,
        notebookRule,
      );
    }
  }

  return {
    taskKey,
    taskType,
    parentJobId: jobId,
    sourceFile,
    sourceLine: taskSourceLocation?.line ?? 0,
    sourceColumn: taskSourceLocation?.column ?? 0,
    fileReferences,
    variableReferences,
    libraryReferences,
    resourceReferences,
    jobParameterReferences,
    taskParameterReferences,
    ...(pipelineSelections.length > 0 ? { pipelineSelections } : {}),
    dependsOn,
    runIf,
    dbiComment: undefined,
    nestedTask,
  };
}
