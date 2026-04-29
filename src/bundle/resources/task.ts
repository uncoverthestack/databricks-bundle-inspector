import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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

  dependsOn: string[];
  runIf: string | undefined;
  // TODO: Our Databricks Bundle Inspector Comment
  dbiComment: string | undefined;
  nestedTask: TaskNodeData | undefined;
}

export type TaskType =
  | "notebook"
  | "sql"
  | "python_wheel"
  | "spark_jar"
  | "spark_python"
  | "pipeline"
  | "run_job"
  | "dbt"
  | "condition"
  | "for_each"
  | "dashboard"
  | "unknown";

export interface FileReference {
  path: string;
  resolvedPath: string | undefined;
  exists: boolean;
  source: "GIT" | "WORKSPACE" | undefined;
  isInGitignore: boolean;
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
  isOverriddenByJob: boolean;
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
const RESOURCE_PATTERN = /\$\{resources\.([^.}]+)\.([^.}]+)\.([^}]+)\}/g;
const GIT_NOTEBOOK_EXTENSIONS = [".py", ".sql", ".scala", ".r", ".ipynb"];

interface SourceLocation {
  line: number;
  column: number;
}

type SourceLocationResolver = (yamlPath: string) => SourceLocation | undefined;

function isRemotePath(p: string): boolean {
  return (
    p.startsWith("/Workspace/") ||
    p.startsWith("dbfs:/") ||
    p.startsWith("s3://") ||
    p.startsWith("abfss://") ||
    p.startsWith("gs://")
  );
}

function containsTemplate(p: string): boolean {
  return p.includes("${") || p.includes("{{");
}

function resolveLocalPath(
  rawPath: string,
  primaryDir: string,
  fallbackDir?: string,
  options?: {
    baseMode?: "primary_then_fallback" | "fallback_only";
    extensions?: string[];
  },
): { resolvedPath: string | undefined; exists: boolean } {
  if (isRemotePath(rawPath) || containsTemplate(rawPath)) {
    return { resolvedPath: undefined, exists: false };
  }
  if (isAbsolute(rawPath)) {
    return { resolvedPath: rawPath, exists: existsSync(rawPath) };
  }

  const baseDirs =
    options?.baseMode === "fallback_only" && fallbackDir
      ? [fallbackDir]
      : fallbackDir && fallbackDir !== primaryDir
        ? [primaryDir, fallbackDir]
        : [primaryDir];
  const candidates = (baseDir: string) => {
    const exact = resolve(baseDir, rawPath);
    return [
      exact,
      ...(options?.extensions ?? []).map((extension) => `${exact}${extension}`),
    ];
  };

  for (const baseDir of baseDirs) {
    for (const candidate of candidates(baseDir)) {
      if (existsSync(candidate)) {
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
  if ("notebook_task" in task || "clean_rooms_notebook_task" in task)
    return "notebook";
  if ("sql_task" in task) return "sql";
  if ("python_wheel_task" in task) return "python_wheel";
  if ("spark_jar_task" in task) return "spark_jar";
  if ("spark_python_task" in task) return "spark_python";
  if ("pipeline_task" in task) return "pipeline";
  if ("run_job_task" in task) return "run_job";
  if ("dbt_task" in task || "dbt_platform_task" in task) return "dbt";
  if ("condition_task" in task) return "condition";
  if ("for_each_task" in task) return "for_each";
  if ("dashboard_task" in task) return "dashboard";
  return "unknown";
}

function getFileReferences(
  task: Record<string, unknown>,
  taskKey: string,
  sourceFileDir: string,
  bundleRoot: string,
  sourceFile: string,
  resolveSourceLocation?: SourceLocationResolver,
): FileReference[] {
  const refs: FileReference[] = [];

  function addRef(
    rawPath: unknown,
    referenceType: FileReference["referenceType"],
    yamlSubPath: string,
    source?: FileReference["source"],
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
            baseMode: "fallback_only",
            extensions: GIT_NOTEBOOK_EXTENSIONS,
          }
        : undefined,
    );
    const yamlPath = `tasks.${taskKey}.${yamlSubPath}`;
    const sourceLocation = resolveSourceLocation?.(yamlPath);
    refs.push({
      path: rawPath,
      resolvedPath,
      exists,
      source,
      isInGitignore: false,
      referenceType,
      sourceFile,
      sourceLine: sourceLocation?.line ?? 0,
      ...(sourceLocation ? { sourceColumn: sourceLocation.column } : {}),
      yamlPath,
    });
  }

  const nb = task.notebook_task as Record<string, unknown> | undefined;
  if (nb)
    addRef(
      nb.notebook_path,
      "notebook",
      "notebook_task.notebook_path",
      normalizedNotebookSource(nb.source),
    );

  const cleanNb = task.clean_rooms_notebook_task as
    | Record<string, unknown>
    | undefined;
  if (cleanNb)
    addRef(
      cleanNb.notebook_path,
      "notebook",
      "clean_rooms_notebook_task.notebook_path",
      normalizedNotebookSource(cleanNb.source),
    );

  const py = task.spark_python_task as Record<string, unknown> | undefined;
  if (py)
    addRef(py.python_file, "python_script", "spark_python_task.python_file");

  const sql = task.sql_task as Record<string, unknown> | undefined;
  if (sql) {
    const sqlFile = sql.file as Record<string, unknown> | undefined;
    addRef(sqlFile?.path, "sql", "sql_task.file.path");
  }

  const dbt = (task.dbt_task ?? task.dbt_platform_task) as
    | Record<string, unknown>
    | undefined;
  if (dbt)
    addRef(dbt.project_directory, "dbt_project", "dbt_task.project_directory");

  return refs;
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
      const { resolvedPath, exists } = resolveLocalPath(
        lib.whl,
        primaryDir,
        fallbackDir,
      );
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
      const { resolvedPath, exists } = resolveLocalPath(
        lib.jar,
        primaryDir,
        fallbackDir,
      );
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
): { params: Record<string, unknown>; payloadKey: string } | null {
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

  const { params, payloadKey } = result;
  const jobParamDefaults = getJobParamDefaults(rawJob);
  const refs: TaskParameterReference[] = [];

  for (const [paramName, paramValue] of Object.entries(params)) {
    const yamlPath = `tasks.${taskKey}.${payloadKey}.base_parameters.${paramName}`;
    const sourceLocation = resolveSourceLocation?.(yamlPath);
    const valueStr =
      typeof paramValue === "string" ? paramValue : String(paramValue ?? "");
    VAR_PATTERN.lastIndex = 0;
    const containsVariableRef = VAR_PATTERN.test(valueStr);
    const isOverriddenByJob =
      valueStr.includes("{{job.parameters.") ||
      valueStr.includes("${job.parameters.");
    const jobDefault = jobParamDefaults.get(paramName);

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
      effectiveValue: isOverriddenByJob ? jobDefault : valueStr || undefined,
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
): TaskNodeData {
  const taskType = getTaskType(rawTask);
  const resolveBase = sourceFileDir || bundleRoot;
  const fileReferences = getFileReferences(
    rawTask,
    taskKey,
    resolveBase,
    bundleRoot,
    sourceFile,
    resolveSourceLocation,
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
        `${taskKey}.__nested__`,
        bundleRoot,
        sourceFile,
        sourceFileDir,
        resolveSourceLocation,
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
    dependsOn,
    runIf,
    dbiComment: undefined,
    nestedTask,
  };
}
