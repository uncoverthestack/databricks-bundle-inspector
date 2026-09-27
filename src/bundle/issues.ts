import path from "node:path";
import type { BundleDiagnostic } from "./parseBundleDiagnostics.js";
import type { ParsedBundleConfig } from "./graph/bundleGraph.js";
import type { BundleGraph, BundleGraphNode } from "./graph/bundleGraph.js";
import type { ValidationIssue } from "./validateBundle.js";
import type { TaskNodeData } from "./resources/task.js";
import type { WidgetUsage } from "./taskFileDetections.js";
import { isVariableResolvedForTarget } from "./targetResolution.js";
import { notebookHeaderFor, type NotebookPathProblem } from "./notebookFiles.js";
import { createSyncExclusion, type SyncExclusion } from "./syncRules.js";

export type InspectorIssueSeverity = "error" | "warning" | "info";

export type InspectorIssueKind =
  | "missing_file"
  | "missing_library"
  | "unresolved_variable"
  | "validation_diagnostic"
  | "unknown_or_deprecated_field"
  | "unknown_task_type"
  | "git_source_not_recommended"
  | "secret_scope_name_mismatch"
  | "notebook_type_mismatch"
  | "widget_parameter_mismatch";
  | "excluded_from_sync";

export interface InspectorIssue {
  id: string;
  severity: InspectorIssueSeverity;
  kind: InspectorIssueKind;
  title: string;
  detail?: string;
  taskId?: string;
  taskName?: string;
  /**
   * The job or other resource an issue belongs to, when it is not tied to a task
   * (e.g. `resources.pipelines.bronze`). Issues with neither this nor a taskId are bundle-wide.
   */
  resourceId?: string;
  file?: string;
  line?: number;
  column?: number;
  yamlPath?: string;
  fixHint?: string;
}

function isMissingLocalPath(ref: {
  resolvedPath: string | undefined;
  exists: boolean | undefined;
}): boolean {
  return ref.resolvedPath !== undefined && ref.exists === false;
}

function sourceFileForTask(task: BundleGraphNode): string | undefined {
  const sourceFile = task.taskData?.sourceFile;
  return sourceFile && sourceFile.trim() ? sourceFile : undefined;
}

function parentJobHasGitSource(
  graph: BundleGraph,
  task: BundleGraphNode,
): boolean {
  const parentJobId = task.parentId ?? task.taskData?.parentJobId;
  if (!parentJobId) return false;
  const parentJob = graph.nodes.find((node) => node.id === parentJobId);
  const gitSource = parentJob?.data?.git_source;
  return Boolean(gitSource && typeof gitSource === "object");
}

function validationFile(
  bundleRoot: string,
  diagnostic: BundleDiagnostic,
): string | undefined {
  return diagnostic.path
    ? path.resolve(bundleRoot, diagnostic.path)
    : undefined;
}

/** `resources.<group>.<key>` for a config path inside a resource, e.g. `resources.jobs.ingest.tasks[0]`. */
function resourceIdFromYamlPath(yamlPath: string | undefined): string | undefined {
  const match = /^(resources\.[^.[\]]+\.[^.[\]]+)/.exec(yamlPath ?? "");
  return match?.[1];
}

/**
 * Whether an issue should be listed for a job: issues on one of its tasks, on the
 * job itself, or bundle-wide. Issues on another resource (e.g. a pipeline) are not.
 */
export function issueBelongsToJob(
  issue: Pick<InspectorIssue, "taskId" | "resourceId">,
  jobId: string,
  jobTaskIds: ReadonlySet<string>,
): boolean {
  if (issue.taskId) return jobTaskIds.has(issue.taskId);
  return !issue.resourceId || issue.resourceId === jobId;
}

/**
 * The title and fix for a path that breaks the CLI's notebook rules. Worded as a
 * hint: the inspector reads the local file, while the CLI decides at deploy.
 */
function notebookProblemIssue(
  path: string,
  problem: NotebookPathProblem,
): Pick<InspectorIssue, "kind" | "title" | "fixHint"> {
  if (problem.kind === "missing_extension") {
    return {
      kind: "missing_file",
      title: `Notebook "${path}" may not be found. Did you mean "${problem.suggestedPath}"?`,
      fixHint:
        "Local notebook paths need their file extension (.py, .r, .scala, .sql or .ipynb).",
    };
  }
  if (problem.kind === "is_a_notebook") {
    return {
      kind: "notebook_type_mismatch",
      title: `"${path}" may be a notebook, not a file.`,
      fixHint:
        "Its first line is the Databricks notebook header, so the CLI treats it as a notebook. Remove that line, or run it from a notebook task or a pipeline notebook library.",
    };
  }
  const header = notebookHeaderFor(path);
  return {
    kind: "notebook_type_mismatch",
    title: `"${path}" may not be a notebook.`,
    fixHint: header
      ? `Add "${header}" as its first line, or run it from a task that takes a file.`
      : /\.ipynb$/i.test(path)
        ? "It is not a valid Jupyter notebook: it needs cells and metadata, at nbformat 4 or later."
        : "Notebooks need a .py, .r, .scala, .sql or .ipynb extension.",
  };
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** The passed parameter a widget name was most likely meant to be, if one is close. */
function closestName(name: string, candidates: string[]): string | undefined {
  const normalise = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "");
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const [n, c] = [normalise(name), normalise(candidate)];
    // Same name up to case and separators, or one extends the other (schema, schema_name).
    const distance = n === c ? 0 : n.includes(c) || c.includes(n) ? 1 : editDistance(name, candidate);
    if (distance <= Math.max(2, Math.floor(name.length / 3)) && (!best || distance < best.distance)) {
      best = { candidate, distance };
    }
  }
  return best?.candidate;
}

/**
 * Compares the widgets a notebook task's notebook reads with the parameters the task
 * receives: its `base_parameters` and the job's parameters, which Databricks pushes
 * down to notebook tasks. A widget read with no parameter and no default fails the run.
 */
function widgetParameterIssues(
  graph: BundleGraph,
  task: BundleGraphNode,
  taskData: TaskNodeData,
  jobParameterNames: ReadonlySet<string>,
): InspectorIssue[] {
  const issues: InspectorIssue[] = [];
  for (const ref of taskData.fileReferences) {
    if (ref.referenceType !== "notebook" || ref.source === "GIT" || !ref.exists) continue;
    const fileNode = graph.nodes.find((node) => node.id === `file:${ref.resolvedPath ?? ref.path}`);
    const usage = fileNode?.data.widgetUsage as WidgetUsage | undefined;
    // A notebook that uses %run can get widgets from the notebook it runs.
    if (!usage || usage.runsOtherNotebooks) continue;

    const taskParameters = taskData.taskParameterReferences;
    const passed = new Set([...taskParameters.map((p) => p.name), ...jobParameterNames]);
    const defaults = new Set(usage.defaults);
    const readNames = new Set(usage.reads.map((read) => read.name));
    const unreadParameters = [...passed].filter((name) => !readNames.has(name));
    const suggested = new Set<string>();
    const reported = new Set<string>();

    for (const read of usage.reads) {
      if (passed.has(read.name) || defaults.has(read.name) || reported.has(read.name)) continue;
      reported.add(read.name);
      const suggestion = closestName(read.name, unreadParameters);
      if (suggestion) suggested.add(suggestion);
      issues.push({
        id: `widget-not-passed:${task.id}:${ref.resolvedPath}:${read.name}`,
        severity: "warning",
        kind: "widget_parameter_mismatch",
        title: suggestion
          ? `Notebook reads widget "${read.name}", which this task may not pass. Did you mean "${suggestion}"?`
          : `Notebook reads widget "${read.name}", which this task may not pass.`,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint: `Pass "${read.name}" in the task's base_parameters or the job's parameters, or give the widget a default in the notebook.`,
        ...issueLocation(ref.resolvedPath, read.line),
      });
    }

    // Only the task's own parameters: job parameters reach every task, used or not.
    // A widget the notebook defines is meant to be set, even if it's read elsewhere.
    const unread = taskParameters.filter(
      (parameter) =>
        !readNames.has(parameter.name) &&
        !defaults.has(parameter.name) &&
        !suggested.has(parameter.name),
    );
    if (unread.length === 0) continue;

    // Names read at runtime can't be matched, so say what wasn't checked instead of
    // guessing that these parameters are unused.
    if (usage.hasDynamicReads) {
      const names = unread.map((parameter) => `"${parameter.name}"`).join(", ");
      issues.push({
        id: `parameters-not-checked:${task.id}:${ref.yamlPath}`,
        severity: "info",
        kind: "widget_parameter_mismatch",
        title: `Not checked whether the notebook uses ${names}: it reads widgets by names only known at runtime.`,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint:
          "The notebook reads a widget name from a variable, calls dbutils.widgets.getAll(), or passes dbutils.widgets to other code, so the inspector can't match these parameters to reads.",
        ...issueLocation(ref.resolvedPath),
      });
      continue;
    }

    for (const parameter of unread) {
      issues.push({
        id: `parameter-not-read:${task.id}:${parameter.yamlPath}`,
        severity: "info",
        kind: "widget_parameter_mismatch",
        title: `Parameter "${parameter.name}" may not be used: the notebook doesn't read a widget with that name.`,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: parameter.yamlPath,
        fixHint: `Read it in the notebook, or remove it from base_parameters.`,
        ...issueLocation(sourceFileForTask(task), parameter.sourceLine || undefined, parameter.sourceColumn),
      });
    }
  }
  return issues;
/**
 * A referenced file that exists locally but that `bundle deploy` would not upload.
 * `bundle validate` passes, so the job or pipeline only fails when it runs.
 */
function syncExclusionIssue(
  filePath: string,
  exclusion: SyncExclusion,
  bundleRoot: string,
): Pick<InspectorIssue, "kind" | "title" | "fixHint"> {
  if (exclusion.rule === "gitignore") {
    const gitignore = path
      .relative(bundleRoot, exclusion.gitignoreFile)
      .split(path.sep)
      .join("/");
    return {
      kind: "excluded_from_sync",
      title: `"${filePath}" may not be deployed: it matches ${gitignore}.`,
      fixHint: `bundle deploy skips gitignored files. Add the file to sync.include in databricks.yml, or remove it from ${gitignore}.`,
    };
  }
  if (exclusion.rule === "sync_exclude") {
    return {
      kind: "excluded_from_sync",
      title: `"${filePath}" may not be deployed: it matches sync.exclude.`,
      fixHint: "Remove or narrow the sync.exclude pattern in databricks.yml that matches this file.",
    };
  }
  return {
    kind: "excluded_from_sync",
    title: `"${filePath}" may not be deployed: .databricks and .git are never synced.`,
    fixHint: "Move the file out of .databricks or .git.",
  };
}

function issueLocation(file?: string, line?: number, column?: number) {
  return {
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
  };
}

function validationDiagnosticIssue(
  issue: ValidationIssue,
  diagnostic: BundleDiagnostic,
): Pick<InspectorIssue, "kind" | "title" | "detail" | "fixHint"> {
  const fieldMatch = /^(?:unknown|deprecated) field:\s*(.+)$/i.exec(
    diagnostic.message,
  );
  if (fieldMatch?.[1]) {
    return {
      kind: "unknown_or_deprecated_field",
      title: "Unknown or deprecated field",
      detail: fieldMatch[1],
      fixHint:
        "Remove the field or update it to a Databricks Bundle field supported by your CLI version.",
    };
  }

  return {
    kind: "validation_diagnostic",
    title: diagnostic.message ?? issue.message,
    fixHint: "Review the Databricks CLI validation diagnostic.",
  };
}

export function buildInspectorIssues(
  graph: BundleGraph,
  parsedBundle: ParsedBundleConfig,
  validationIssues: ValidationIssue[],
  bundleRoot: string,
  targetName?: string | null,
): InspectorIssue[] {
  const issues: InspectorIssue[] = [];
  const tasks = graph.nodes.filter((node) => node.nodeType === "task");
  // With sync.paths the CLI syncs from a different root, which is not modelled.
  const syncExclusionOf = parsedBundle.sync?.paths?.length
    ? () => undefined
    : createSyncExclusion(bundleRoot, parsedBundle.sync);

  for (const task of tasks) {
    const taskData = task.taskData;
    if (!taskData) continue;

    // An unrecognised task type is a gap in the inspector, not a problem in the
    // bundle: an invalid task key is already reported by the CLI as an unknown field.
    if (taskData.taskType === "unknown") {
      issues.push({
        id: `unknown-task:${task.id}`,
        severity: "info",
        kind: "unknown_task_type",
        title: "Task type not recognised by the inspector",
        detail: task.displayName,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: `tasks.${taskData.taskKey}`,
        fixHint:
          "The inspector shows this task without type-specific details. It does not mean the task is invalid.",
        ...issueLocation(sourceFileForTask(task)),
      });
    }

    // A for_each task's inner task is checked too; its issues belong to the outer task.
    const checkedTaskData = taskData.nestedTask ? [taskData, taskData.nestedTask] : [taskData];

    if (!parentJobHasGitSource(graph, task)) {
      const jobParameterNames = new Set(taskData.jobParameterReferences.map((p) => p.name));
      for (const data of checkedTaskData) {
        issues.push(...widgetParameterIssues(graph, task, data, jobParameterNames));
      }
    }

    for (const ref of checkedTaskData.flatMap((data) => data.fileReferences)) {
      if (ref.source === "GIT" && !parentJobHasGitSource(graph, task)) {
        issues.push({
          id: `git-source:${task.id}:${ref.yamlPath}:${ref.path}`,
          severity: "warning",
          kind: "git_source_not_recommended",
          title: "Git-sourced task path is not recommended for bundles",
          detail: ref.path,
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: ref.yamlPath,
          fixHint:
            "Prefer workspace-synced local task files by omitting source or using WORKSPACE.",
          ...issueLocation(
            ref.sourceFile || sourceFileForTask(task),
            ref.sourceLine || undefined,
            ref.sourceColumn,
          ),
        });
      }

      // The CLI does not check task paths in a job with a git_source.
      if (ref.notebookProblem && !parentJobHasGitSource(graph, task)) {
        issues.push({
          id: `notebook-path:${task.id}:${ref.yamlPath}:${ref.path}`,
          severity: "error",
          ...notebookProblemIssue(ref.path, ref.notebookProblem),
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: ref.yamlPath,
          ...issueLocation(
            ref.sourceFile || sourceFileForTask(task),
            ref.sourceLine || undefined,
            ref.sourceColumn,
          ),
        });
        continue;
      }

      const exclusion =
        ref.exists &&
        ref.resolvedPath &&
        ref.source !== "GIT" &&
        ref.referenceType !== "directory" &&
        ref.referenceType !== "dbt_project" &&
        !parentJobHasGitSource(graph, task)
          ? syncExclusionOf(ref.resolvedPath)
          : undefined;
      if (exclusion) {
        issues.push({
          id: `excluded-from-sync:${task.id}:${ref.yamlPath}:${ref.path}`,
          severity: "warning",
          ...syncExclusionIssue(ref.path, exclusion, bundleRoot),
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: ref.yamlPath,
          ...issueLocation(
            ref.sourceFile || sourceFileForTask(task),
            ref.sourceLine || undefined,
            ref.sourceColumn,
          ),
        });
        continue;
      }

      if (!isMissingLocalPath(ref)) continue;
      issues.push({
        id: `missing-file:${task.id}:${ref.yamlPath}:${ref.path}`,
        severity: "error",
        kind: "missing_file",
        title: "Missing local file reference",
        detail: ref.path,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint:
          "Create the file or update the path in the task configuration.",
        ...issueLocation(
          ref.sourceFile || sourceFileForTask(task),
          ref.sourceLine || undefined,
          ref.sourceColumn,
        ),
      });
    }

    for (const ref of checkedTaskData.flatMap((data) => data.libraryReferences)) {
      if (!ref.isLocal || ref.exists !== false) continue;
      issues.push({
        id: `missing-library:${task.id}:${ref.yamlPath}:${ref.identifier}`,
        severity: "error",
        kind: "missing_library",
        title: "Missing local library",
        detail: ref.identifier,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint:
          "Create the local library artifact or update the library path.",
        ...issueLocation(
          sourceFileForTask(task),
          ref.sourceLine || undefined,
          ref.sourceColumn,
        ),
      });
    }

    for (const ref of checkedTaskData.flatMap((data) => data.variableReferences)) {
      if (isVariableResolvedForTarget(parsedBundle, ref.variableName, targetName)) {
        continue;
      }
      issues.push({
        id: `unresolved-var:${task.id}:${ref.yamlPath}:${ref.variableName}`,
        severity: "error",
        kind: "unresolved_variable",
        title: "Unresolved variable",
        detail: ref.variableName,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint: "Define the variable in the bundle or replace the reference.",
        ...issueLocation(
          ref.sourceFile || sourceFileForTask(task),
          ref.sourceLine || undefined,
          ref.sourceColumn,
        ),
      });
    }
  }

  for (const pipeline of graph.nodes) {
    for (const ref of pipeline.pipelineLibraries ?? []) {
      if (ref.checked && ref.notebookProblem) {
        issues.push({
          id: `notebook-path:${pipeline.id}:${ref.yamlPath}`,
          severity: "error",
          ...notebookProblemIssue(ref.path, ref.notebookProblem),
          resourceId: pipeline.id,
          yamlPath: `${pipeline.id}.${ref.yamlPath}`,
          ...issueLocation(ref.sourceFile, ref.sourceLine || undefined, ref.sourceColumn),
        });
        continue;
      }
      const exclusion =
        ref.checked && ref.exists && ref.kind !== "glob" && ref.resolvedPath
          ? syncExclusionOf(ref.resolvedPath)
          : undefined;
      if (exclusion) {
        issues.push({
          id: `excluded-from-sync:${pipeline.id}:${ref.yamlPath}`,
          severity: "warning",
          ...syncExclusionIssue(ref.path, exclusion, bundleRoot),
          resourceId: pipeline.id,
          yamlPath: `${pipeline.id}.${ref.yamlPath}`,
          ...issueLocation(ref.sourceFile, ref.sourceLine || undefined, ref.sourceColumn),
        });
        continue;
      }
      if (!ref.checked || ref.exists) continue;
      issues.push({
        id: `missing-pipeline-source:${pipeline.id}:${ref.yamlPath}`,
        severity: "error",
        kind: "missing_file",
        title:
          ref.kind === "glob"
            ? "Pipeline source folder has no files"
            : "Missing pipeline source file",
        detail: ref.path,
        resourceId: pipeline.id,
        yamlPath: `${pipeline.id}.${ref.yamlPath}`,
        fixHint:
          ref.kind === "glob"
            ? "Add the pipeline source files, or update the glob include path in the pipeline's libraries."
            : "Create the file or update the path in the pipeline's libraries.",
        ...issueLocation(ref.sourceFile, ref.sourceLine || undefined, ref.sourceColumn),
      });
    }
  }

  for (const [issueIndex, issue] of validationIssues.entries()) {
    if (issue.code === "AUTH_NOT_CONFIGURED") continue;
    for (const [diagnosticIndex, diagnostic] of (
      issue.diagnostics ?? []
    ).entries()) {
      const normalized = validationDiagnosticIssue(issue, diagnostic);
      const resourceId = resourceIdFromYamlPath(diagnostic.yamlPath);
      issues.push({
        id: `validation:${issueIndex}:${diagnosticIndex}`,
        severity: diagnostic.severity ?? "warning",
        ...normalized,
        ...(diagnostic.yamlPath ? { yamlPath: diagnostic.yamlPath } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...issueLocation(
          validationFile(bundleRoot, diagnostic),
          diagnostic.line,
          diagnostic.column,
        ),
      });
    }
  }

  issues.push(...secretScopeNameIssues(graph));

  return issues;
}

/**
 * Warns where code or config names a secret scope by a bundle scope's resource key
 * instead of its `name`, e.g. `app_scope` for a scope named `app-secrets`. That
 * scope does not exist at runtime. Names matching nothing are left alone: they may
 * be scopes managed outside the bundle.
 */
function secretScopeNameIssues(graph: BundleGraph): InspectorIssue[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const issues = new Map<string, InspectorIssue>();

  for (const edge of graph.edges) {
    const scopeNode = nodeById.get(edge.target);
    const misuse = scopeNode?.data.resourceKeyMisuse as
      | { resourceId: string; scopeName: string }
      | undefined;
    if (!scopeNode || !misuse) continue;

    const source = nodeById.get(edge.source);
    if (!source) continue;
    // Who owns the warning: the task using the file or config, or the pipeline/cluster.
    const taskId =
      source.nodeType === "task"
        ? source.id
        : source.nodeType === "file"
          ? graph.edges.find(
              (other) => other.target === source.id && nodeById.get(other.source)?.nodeType === "task",
            )?.source
          : undefined;
    const file = typeof edge.data?.file === "string" ? edge.data.file : undefined;
    const line = typeof edge.data?.line === "number" ? edge.data.line : undefined;
    const column = typeof edge.data?.column === "number" ? edge.data.column : undefined;
    const id = `secret-scope-name:${scopeNode.id}:${file ?? source.id}:${line ?? 0}`;
    if (issues.has(id)) continue;

    const used = String(scopeNode.data.scope ?? scopeNode.displayName);
    issues.set(id, {
      id,
      severity: "warning",
      kind: "secret_scope_name_mismatch",
      title: `Secret scope "${used}" may not exist. Did you mean "${misuse.scopeName}"?`,
      ...(taskId ? { taskId, taskName: nodeById.get(taskId)?.displayName ?? taskId } : {}),
      ...(!taskId && source.nodeType !== "file" ? { resourceId: source.id } : {}),
      ...(typeof edge.data?.yamlPath === "string" ? { yamlPath: edge.data.yamlPath } : {}),
      fixHint: `"${used}" is the resource key of the bundle's secret scope named "${misuse.scopeName}". Unless a scope called "${used}" exists outside this bundle, use "${misuse.scopeName}".`,
      ...issueLocation(file, line, column),
    });
  }
  return [...issues.values()];
}
