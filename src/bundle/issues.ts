import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BundleDiagnostic } from "./parseBundleDiagnostics.js";
import type { ParsedBundleConfig } from "./graph/bundleGraph.js";
import type { BundleGraph, BundleGraphNode } from "./graph/bundleGraph.js";
import type { ValidationIssue } from "./validateBundle.js";
import type { TaskNodeData } from "./resources/task.js";
import type { TaskValueUsage, WidgetUsage } from "./taskFileDetections.js";
import { isVariableResolvedForTarget } from "./targetResolution.js";
import { notebookHeaderFor, type NotebookPathProblem } from "./notebookFiles.js";
import { createSyncExclusion, type SyncExclusion } from "./syncRules.js";
import { globSync, hasGlobCharacters } from "./goGlob.js";
import { findUnloadedResourceFiles, readIncludeEntries } from "./includeFiles.js";
import { writtenValueAt } from "./quickFix.js";
import { isRemotePath } from "./resources/task.js";
import { closestName } from "./closestName.js";

export type InspectorIssueSeverity = "error" | "warning" | "info";

/**
 * The code each finding shows in the Problems panel, and its section in docs/checks.md,
 * in the order the page lists them. A code that has shipped is never renamed or removed:
 * users write them down, and quick fixes, telemetry and the docs rely on them. Each code
 * means one fix.
 */
export const INSPECTOR_ISSUE_KINDS = [
  "missing_file",
  "notebook_missing_extension",
  "missing_pipeline_source",
  "missing_library",
  "not_a_notebook",
  "file_is_a_notebook",
  "excluded_from_sync",
  "path_not_checked",
  "include_matches_nothing",
  "resource_not_included",
  "unknown_task_dependency",
  "task_dependency_loop",
  "duplicate_task_key",
  "duplicate_job_parameter",
  "widget_not_set",
  "unused_parameter",
  "task_value_unknown_task",
  "task_value_not_upstream",
  "task_value_key_not_set",
  "secret_scope_name_mismatch",
  "unresolved_variable",
  "cli_diagnostic",
  "unknown_or_deprecated_field",
  "unknown_task_type",
  "git_source_not_recommended",
] as const;

export type InspectorIssueKind = (typeof INSPECTOR_ISSUE_KINDS)[number];

/**
 * A fix that is one exact replacement in the issue's file, on the issue's line: the
 * value written as `oldText` becomes `newText`. Only offered while the file still says
 * `oldText` there, so it never edits a value that came from somewhere else.
 */
export interface IssueFix {
  oldText: string;
  newText: string;
  /** What the Quick Fix menu says, e.g. `Change to "src/etl.py"`. */
  title: string;
}

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
  fix?: IssueFix;
}

/**
 * A local path the structural preview leaves unresolved because it uses a variable, so
 * none of the checks that read the file ran. Remote paths are not local files.
 */
function usesVariable(rawPath: string): boolean {
  return rawPath.includes("${") && !isRemotePath(rawPath);
}

/**
 * Says a file was not checked, so that "not checked" never looks like "no problems".
 * The variable's value can come from places the preview doesn't see (target, overrides,
 * BUNDLE_VAR_, --var), so the inspector doesn't resolve it itself.
 */
function pathNotCheckedIssue(
  rawPath: string,
  targetName: string | null | undefined,
): Pick<InspectorIssue, "severity" | "kind" | "title" | "fixHint"> {
  return {
    severity: "info",
    kind: "path_not_checked",
    title: targetName
      ? `Not checked: "${rawPath}" still uses a variable for target "${targetName}", so the file isn't known.`
      : `Not checked: "${rawPath}" uses a variable, so the file is only known once a target is resolved. Pick a target in the graph to check it.`,
    fixHint:
      "The structural preview leaves variables in paths unresolved, so the missing file, notebook and code checks don't run on this file.",
  };
}

function replacementFix(oldText: string, newText: string): IssueFix {
  return { oldText, newText, title: `Change to "${newText}"` };
}

/**
 * The fix for an include entry, at the column its value starts after `- `, so the
 * Quick Fix menu checks the exact place and never edits part of a longer value.
 * Nothing when the entry isn't written there as one value (a flow list, an escape).
 */
function includeEntryFix(
  bundleText: string | undefined,
  line: number,
  entry: string,
  suggestion: string,
): Pick<InspectorIssue, "column" | "fix"> {
  const lineText = bundleText?.split(/\r?\n/)[line - 1] ?? "";
  const marker = /^\s*-\s+/.exec(lineText);
  if (!marker) return {};
  const column = marker[0].length + 1;
  if (writtenValueAt(lineText, column) !== entry) return {};
  return { column, fix: replacementFix(entry, suggestion) };
}

/**
 * The fix for a notebook path without its extension: the path as written in the file
 * gets the extension. The CLI reports paths from the bundle root, while a resource file
 * holds them from its own folder, so the fix is built from the file. Nothing is offered
 * when the written value leads somewhere else, as a variable or target override does.
 */
function missingExtensionFix(
  rawPath: string,
  problem: NotebookPathProblem,
  resolvedPath: string | undefined,
  file: string | undefined,
  line: number | undefined,
  column: number | undefined,
): Pick<InspectorIssue, "fix"> {
  if (problem.kind !== "missing_extension" || !resolvedPath || !file || !line || !column) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const written = writtenValueAt(text.split(/\r?\n/)[line - 1] ?? "", column);
  if (!written || path.resolve(path.dirname(file), written) !== resolvedPath) return {};
  const extension = problem.suggestedPath.slice(rawPath.length);
  return { fix: replacementFix(written, written + extension) };
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
      kind: "notebook_missing_extension",
      title: `Notebook "${path}" may not be found. Did you mean "${problem.suggestedPath}"?`,
      fixHint:
        "Local notebook paths need their file extension (.py, .r, .scala, .sql or .ipynb).",
    };
  }
  if (problem.kind === "is_a_notebook") {
    return {
      kind: "file_is_a_notebook",
      title: `"${path}" may be a notebook, not a file.`,
      fixHint:
        "Its first line is the Databricks notebook header, so the CLI treats it as a notebook. Remove that line, or run it from a notebook task or a pipeline notebook library.",
    };
  }
  const header = notebookHeaderFor(path);
  return {
    kind: "not_a_notebook",
    title: `"${path}" may not be a notebook.`,
    fixHint: header
      ? `Add "${header}" as its first line, or run it from a task that takes a file.`
      : /\.ipynb$/i.test(path)
        ? "It is not a valid Jupyter notebook: it needs cells and metadata, at nbformat 4 or later."
        : "Notebooks need a .py, .r, .scala, .sql or .ipynb extension.",
  };
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
    if (!usage) continue;

    // Notebooks run with %run use their own widget defaults and the $name="value"
    // values on the %run line, not the task's parameters.
    for (const unset of usage.unsetRunReads) {
      const id = `run-widget-not-set:${task.id}:${unset.file}:${unset.name}`;
      if (issues.some((issue) => issue.id === id)) continue;
      issues.push({
        id,
        severity: "warning",
        kind: "widget_not_set",
        title: `Notebook "${unset.target}", run with %run, reads widget "${unset.name}", which may not be set.`,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint: `%run runs a notebook with its own widget defaults and the values on the %run line. Pass it with %run ${unset.target} $${unset.name}="<value>", or give the widget a default in that notebook.`,
        ...issueLocation(unset.file, unset.line),
      });
    }
    // A %run the inspector can't follow can define widgets it doesn't see.
    if (usage.hasUnresolvedRuns) continue;

    const taskParameters = taskData.taskParameterReferences;
    const passed = new Set([...taskParameters.map((p) => p.name), ...jobParameterNames]);
    const defaults = new Set(usage.defaults);
    const readNames = new Set([...usage.reads.map((read) => read.name), ...usage.runReadNames]);
    const unreadParameters = [...passed].filter((name) => !readNames.has(name));
    const suggested = new Set<string>();
    const reported = new Set<string>();

    for (const read of usage.reads) {
      if (passed.has(read.name) || reported.has(read.name)) continue;
      // A default created in the other language's cells doesn't reach this read when
      // the notebook runs as a job; one from a %run notebook is not language-bound here.
      const ownLanguages = usage.defaultLanguages[read.name];
      if (ownLanguages && !ownLanguages.includes(read.language)) {
        reported.add(read.name);
        const where = read.language === "sql" ? "a SQL cell" : "a Python cell";
        const created = ownLanguages[0] === "sql" ? "a SQL cell" : "a Python cell";
        issues.push({
          id: `widget-other-language:${task.id}:${ref.resolvedPath}:${read.name}`,
          severity: "warning",
          kind: "widget_not_set",
          title: `Widget "${read.name}" is read in ${where} but created in ${created}, so it may not be set when the notebook runs as a job.`,
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: ref.yamlPath,
          fixHint: `Widgets can't pass between languages under Run All or in a job. Pass "${read.name}" in the task's base_parameters or the job's parameters, or create it in ${where}.`,
          ...issueLocation(ref.resolvedPath, read.line),
        });
        continue;
      }
      if (defaults.has(read.name)) continue;
      reported.add(read.name);
      const suggestion = closestName(read.name, unreadParameters);
      if (suggestion) suggested.add(suggestion);
      issues.push({
        id: `widget-not-passed:${task.id}:${ref.resolvedPath}:${read.name}`,
        severity: "warning",
        kind: "widget_not_set",
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
        kind: "unused_parameter",
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
        kind: "unused_parameter",
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
}

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
    kind: "cli_diagnostic",
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

      if (usesVariable(ref.path) && ref.source !== "GIT" && !parentJobHasGitSource(graph, task)) {
        const id = `path-not-checked:${task.id}:${ref.yamlPath}`;
        if (!issues.some((issue) => issue.id === id)) {
          issues.push({
            id,
            ...pathNotCheckedIssue(ref.path, targetName),
            taskId: task.id,
            taskName: task.displayName,
            yamlPath: ref.yamlPath,
            ...issueLocation(
              ref.sourceFile || sourceFileForTask(task),
              ref.sourceLine || undefined,
              ref.sourceColumn,
            ),
          });
        }
        continue;
      }

      // The CLI does not check task paths in a job with a git_source.
      if (ref.notebookProblem && !parentJobHasGitSource(graph, task)) {
        issues.push({
          id: `notebook-path:${task.id}:${ref.yamlPath}:${ref.path}`,
          severity: "error",
          ...notebookProblemIssue(ref.path, ref.notebookProblem),
          ...missingExtensionFix(
            ref.path,
            ref.notebookProblem,
            ref.resolvedPath,
            ref.sourceFile || sourceFileForTask(task),
            ref.sourceLine || undefined,
            ref.sourceColumn,
          ),
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
      if (!ref.checked && usesVariable(ref.path)) {
        issues.push({
          id: `path-not-checked:${pipeline.id}:${ref.yamlPath}`,
          ...pathNotCheckedIssue(ref.path, targetName),
          resourceId: pipeline.id,
          yamlPath: `${pipeline.id}.${ref.yamlPath}`,
          ...issueLocation(ref.sourceFile, ref.sourceLine || undefined, ref.sourceColumn),
        });
        continue;
      }
      if (ref.checked && ref.notebookProblem) {
        issues.push({
          id: `notebook-path:${pipeline.id}:${ref.yamlPath}`,
          severity: "error",
          ...notebookProblemIssue(ref.path, ref.notebookProblem),
          ...missingExtensionFix(
            ref.path,
            ref.notebookProblem,
            ref.resolvedPath,
            ref.sourceFile,
            ref.sourceLine || undefined,
            ref.sourceColumn,
          ),
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
        kind: "missing_pipeline_source",
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
  issues.push(...taskValueIssues(graph));
  issues.push(...includeIssues(parsedBundle, bundleRoot));
  issues.push(...jobStructureIssues(graph));

  return issues;
}

/** Task graph and duplicate key mistakes in jobs (#135). Deploy rejects the first two. */
function jobStructureIssues(graph: BundleGraph): InspectorIssue[] {
  return (graph.jobStructureFindings ?? []).map((finding) => {
    const jobId = `resources.jobs.${finding.jobKey}`;
    const { file, line, column } = finding.location ?? {};
    return {
      id: `job-structure:${finding.kind}:${jobId}:${finding.taskKey ?? ""}:${file ?? ""}:${line ?? ""}`,
      severity:
        finding.kind === "unknown_task_dependency" || finding.kind === "task_dependency_loop" ? "error" : "warning",
      kind: finding.kind,
      title: finding.title,
      ...(finding.taskKey
        ? { taskId: `${jobId}.tasks.${finding.taskKey}`, taskName: finding.taskKey }
        : { resourceId: jobId }),
      fixHint: finding.fixHint,
      ...issueLocation(file, line, column),
    };
  });
}

/** What the CLI does with `**` and `{a,b}` in `include`, which its documentation does not say. */
function includeCaveat(entry: string): string | undefined {
  if (entry.includes("**")) {
    return 'The CLI treats "**" like "*": it matches exactly one folder level, not every level.';
  }
  if (entry.includes("{")) {
    return 'The CLI does not support "{a,b}" in include. Use one entry per pattern.';
  }
  return undefined;
}

/** The include entry an entry matching nothing was most likely meant to be, if one matches files. */
function suggestInclude(bundleRoot: string, entry: string): string | undefined {
  const swapped = entry.replace(/\.(yml|yaml)$/, (_, extension: string) => (extension === "yml" ? ".yaml" : ".yml"));
  if (swapped !== entry && (globSync(bundleRoot, swapped)?.length ?? 0) > 0) return swapped;

  // A misspelled folder name, e.g. `resource/*.yml` for `resources/*.yml`.
  const segments = entry.split("/");
  let folder = "";
  for (const [index, segment] of segments.entries()) {
    if (hasGlobCharacters(segment)) return undefined;
    if (existsSync(path.join(bundleRoot, folder, segment))) {
      folder = path.posix.join(folder, segment);
      continue;
    }
    let folders: string[];
    try {
      folders = readdirSync(path.join(bundleRoot, folder), { withFileTypes: true })
        .filter((child) => child.isDirectory() && !child.name.startsWith("."))
        .map((child) => child.name);
    } catch {
      return undefined;
    }
    const closest = closestName(segment, folders);
    if (!closest) return undefined;
    const fixed = [...segments.slice(0, index), closest, ...segments.slice(index + 1)].join("/");
    return (globSync(bundleRoot, fixed)?.length ?? 0) > 0 ? fixed : undefined;
  }
  return undefined;
}

/**
 * Warns about two silent `include` mistakes. The CLI loads only `databricks.yml` and the
 * files `include` selects, and says nothing when a pattern selects nothing or when a
 * file that defines resources is left out, so the bundle just has fewer resources.
 *
 * "Left out" is judged from the CLI's own expanded `include` list, not by matching
 * patterns again. That list is the CLI's answer, so when it still holds patterns (not
 * the CLI's output) nothing is said.
 */
export function includeIssues(parsedBundle: ParsedBundleConfig, bundleRoot: string): InspectorIssue[] {
  const issues: InspectorIssue[] = [];
  const { file: bundleFile, text: bundleText, entries } = readIncludeEntries(bundleRoot);
  const bundleFilePath = path.join(bundleRoot, bundleFile ?? "databricks.yml");

  for (const { entry, line } of entries) {
    // An entry without wildcards that matches nothing is already an error from the CLI.
    if (!hasGlobCharacters(entry) || path.isAbsolute(entry)) continue;
    const matches = globSync(bundleRoot, entry);
    if (matches === undefined || matches.length > 0) continue;

    // Without a likely fix this is usually a template default that matches nothing yet,
    // such as `resources/*.yml` in a bundle whose resources are written in Python.
    const suggestion = suggestInclude(bundleRoot, entry);
    if (!suggestion) continue;

    issues.push({
      id: `include:matches-nothing:${entry}`,
      severity: "warning",
      kind: "include_matches_nothing",
      title: `No files match the include pattern "${entry}", so nothing from it is loaded. Did you mean "${suggestion}"?`,
      fixHint:
        includeCaveat(entry) ??
        "Check the folder name and the file extension (.yml or .yaml) in the include entry in databricks.yml.",
      file: bundleFilePath,
      ...(line ? { line, ...includeEntryFix(bundleText, line, entry, suggestion) } : {}),
    });
  }

  // Without an include entry the CLI output has no include list at all.
  const loaded = parsedBundle.include ?? (entries.length === 0 ? [] : undefined);
  if (loaded && !loaded.some(hasGlobCharacters)) {
    const caveat = entries.map(({ entry }) => includeCaveat(entry)).find(Boolean);
    for (const { file, line } of findUnloadedResourceFiles(bundleRoot, loaded, bundleText)) {
      issues.push({
        id: `include:not-included:${file}`,
        severity: "warning",
        kind: "resource_not_included",
        title: `"${file}" defines resources, but no include entry loads it, so they are not part of the bundle.`,
        fixHint:
          "Add a pattern that covers this file to include in databricks.yml, or remove the file if it is unused." +
          (caveat ? ` ${caveat}` : ""),
        file: path.join(bundleRoot, file),
        line,
      });
    }
  }

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

// `{{tasks.<task_key>.values.<key>}}` in task settings.
const TASK_VALUE_REFERENCE = /\{\{\s*tasks\.([\w-]+)\.values\.([\w-]+)\s*\}\}/g;

/**
 * Checks task values (https://docs.databricks.com/aws/en/jobs/task-values), read with
 * `dbutils.jobs.taskValues.get(taskKey=..., key=...)` or `{{tasks.<task>.values.<key>}}`:
 * the task must exist in the job, run before the reader (be upstream through
 * `depends_on`), and set the key. Databricks reports a missing key or a wrongly named
 * task as an error when the job runs.
 */
function taskValueIssues(graph: BundleGraph): InspectorIssue[] {
  const issues: InspectorIssue[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const tasksByJob = new Map<string, Map<string, BundleGraphNode>>();
  for (const node of graph.nodes) {
    if (node.nodeType !== "task" || !node.taskData || !node.parentId) continue;
    const tasks = tasksByJob.get(node.parentId) ?? new Map<string, BundleGraphNode>();
    tasks.set(node.taskData.taskKey, node);
    tasksByJob.set(node.parentId, tasks);
  }

  const usagesOf = (task: BundleGraphNode): TaskValueUsage[] => {
    const data = task.taskData;
    if (!data) return [];
    return [data, ...(data.nestedTask ? [data.nestedTask] : [])]
      .flatMap((d) => d.fileReferences)
      .flatMap((ref) => {
        const usage = nodeById.get(`file:${ref.resolvedPath ?? ref.path}`)?.data.taskValueUsage;
        return usage ? [usage as TaskValueUsage] : [];
      });
  };

  /** The keys a task sets, or `undefined` when the inspector can't know them all. */
  const keysSetBy = (task: BundleGraphNode): Set<string> | undefined => {
    const data = task.taskData;
    const refs = data ? [data, ...(data.nestedTask ? [data.nestedTask] : [])].flatMap((d) => d.fileReferences) : [];
    const scanned = refs.filter((ref) => ref.referenceType === "notebook" || ref.referenceType === "python_script");
    const usages = usagesOf(task);
    // Only tasks whose code was all read, with no %run and no key known only at runtime.
    if (scanned.length === 0 || usages.length !== scanned.length) return undefined;
    if (usages.some((usage) => usage.runsOtherNotebooks || usage.sets.some((set) => set.key === null))) {
      return undefined;
    }
    return new Set(usages.flatMap((usage) => usage.sets.map((set) => set.key!)));
  };

  for (const [, tasks] of tasksByJob) {
    const upstreamCache = new Map<string, Set<string>>();
    const upstreamOf = (taskKey: string): Set<string> => {
      const cached = upstreamCache.get(taskKey);
      if (cached) return cached;
      const result = new Set<string>();
      upstreamCache.set(taskKey, result);
      for (const dependency of tasks.get(taskKey)?.taskData?.dependsOn ?? []) {
        result.add(dependency);
        for (const further of upstreamOf(dependency)) result.add(further);
      }
      return result;
    };

    for (const [readerKey, reader] of tasks) {
      if (parentJobHasGitSource(graph, reader)) continue;
      const reads: Array<{ taskKey: string; key: string | null; file?: string; line?: number; yamlPath?: string }> = [];
      const readerRefs = reader.taskData
        ? [reader.taskData, ...(reader.taskData.nestedTask ? [reader.taskData.nestedTask] : [])].flatMap((d) => d.fileReferences)
        : [];
      for (const ref of readerRefs) {
        const usage = nodeById.get(`file:${ref.resolvedPath ?? ref.path}`)?.data.taskValueUsage as TaskValueUsage | undefined;
        for (const get of usage?.gets ?? []) {
          if (!get.taskKey) continue;
          reads.push({ taskKey: get.taskKey, key: get.key, line: get.line, ...(ref.resolvedPath ? { file: ref.resolvedPath } : {}) });
        }
      }
      const settings = JSON.stringify(reader.data ?? {});
      for (const match of settings.matchAll(TASK_VALUE_REFERENCE)) {
        reads.push({ taskKey: match[1]!, key: match[2]!, yamlPath: `tasks.${readerKey}` });
      }

      const reported = new Set<string>();
      for (const read of reads) {
        const id = `task-value:${reader.id}:${read.taskKey}:${read.key ?? ""}`;
        if (reported.has(id) || read.taskKey === readerKey) continue;
        reported.add(id);
        const location = read.file
          ? issueLocation(read.file, read.line)
          : issueLocation(sourceFileForTask(reader), reader.taskData?.sourceLine || undefined);
        const base = {
          id,
          severity: "warning" as const,
          taskId: reader.id,
          taskName: reader.displayName,
          yamlPath: read.yamlPath ?? `tasks.${readerKey}`,
          ...location,
        };
        const valueName = read.key ? `"${read.key}"` : "a value";
        if (!tasks.has(read.taskKey)) {
          const suggestion = closestName(read.taskKey, [...tasks.keys()]);
          issues.push({
            ...base,
            kind: "task_value_unknown_task",
            title: `Task value ${valueName} is read from task "${read.taskKey}", which may not exist.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
            fixHint: "taskKey must be the task_key of a task in the same job. Databricks reports an incorrectly named task as an error when the job runs.",
          });
          continue;
        }
        if (!upstreamOf(readerKey).has(read.taskKey)) {
          issues.push({
            ...base,
            kind: "task_value_not_upstream",
            title: `Task "${read.taskKey}" isn't upstream of this task, so its value ${valueName} may not be set yet.`,
            fixHint: `Add "${read.taskKey}" to this task's depends_on, directly or through another dependency, so it runs first.`,
          });
          continue;
        }
        const keys = read.key ? keysSetBy(tasks.get(read.taskKey)!) : undefined;
        if (keys && read.key && !keys.has(read.key)) {
          const suggestion = closestName(read.key, [...keys]);
          issues.push({
            ...base,
            kind: "task_value_key_not_set",
            title: `Task "${read.taskKey}" may not set value "${read.key}".${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
            fixHint: `The task's code has no dbutils.jobs.taskValues.set(key="${read.key}", ...). Databricks reports a missing key as an error when the job runs.`,
          });
        }
      }
    }
  }
  return issues;
}

