import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BundleDiagnostic } from "./parseBundleDiagnostics.js";
import type { ParsedBundleConfig, TargetConfig } from "./graph/bundleGraph.js";
import type { BundleGraph, BundleGraphNode } from "./graph/bundleGraph.js";
import { bundleSecretScopes } from "./graph/bundleGraph.js";
import { taskRuntimeSecrets } from "./runtimeSecrets.js";
import type { ValidationIssue } from "./validateBundle.js";
import type { FileReference, TaskNodeData } from "./resources/task.js";
import type { SqlTextParameter, TaskValueUsage, WidgetUsage } from "./taskFileDetections.js";
import { isVariableResolvedForTarget } from "./targetResolution.js";
import { notebookHeaderFor, NOTEBOOK_MARKER_RULE_CLI_VERSION, type NotebookHeaderRule, type NotebookPathProblem } from "./notebookFiles.js";
import { createSyncExclusion, syncsFromBundleRoot, type SyncExclusion } from "./syncRules.js";
import { globSync, hasGlobCharacters } from "./goGlob.js";
import { mayBeBuilt } from "./localLibraries.js";
import { findUnloadedResourceFiles, readIncludeEntries } from "./includeFiles.js";
import { writtenValueAt } from "./quickFix.js";
import { filesUnder, movedFileSuggestion, type ExpectedFile, type FileList } from "./pathSuggestions.js";
import { isRemotePath } from "./resources/task.js";
import { closestName } from "./closestName.js";
import { splitName } from "./pipelineDataFlow.js";
import { checkRunTarget, unquote } from "./runTargets.js";
import type { RunTarget } from "./taskFileDetections.js";
import { findVariableLoops } from "./variableLoops.js";
import { findWorkspacePathClashes } from "./workspacePathClashes.js";
import type { VariableSources } from "./variableSources.js";
import { own } from "./ownKeys.js";

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
  "unsupported_pipeline_file",
  "missing_library",
  "not_a_notebook",
  "file_is_a_notebook",
  "path_is_a_folder",
  "excluded_from_sync",
  "path_not_checked",
  "same_workspace_path",
  "include_matches_nothing",
  "resource_not_included",
  "unknown_task_dependency",
  "task_dependency_loop",
  "duplicate_task_key",
  "duplicate_job_parameter",
  "environment_version_missing",
  "unknown_environment_key",
  "project_environment_version_missing",
  "project_environment_conflict",
  "multiple_job_triggers",
  "invalid_job_parameter_name",
  "invalid_task_key",
  "outcome_without_condition",
  "invalid_outcome",
  "for_each_inputs_not_array",
  "for_each_inputs_too_long",
  "unknown_job_parameter",
  "job_parameter_reference_with_dot",
  "job_parameter_in_default",
  "pipeline_selection_not_found",
  "job_only_in_target",
  "runtime_end_of_support",
  "widget_not_set",
  "unused_parameter",
  "sql_parameter_not_set",
  "sql_parameter_quoted",
  "schema_renamed_in_target",
  "task_value_unknown_task",
  "task_value_not_upstream",
  "task_value_key_not_set",
  "secret_scope_name_mismatch",
  "run_target_not_found",
  "missing_bundle_name",
  "empty_bundle_name_in_root_path",
  "unresolved_variable",
  "variable_reference_loop",
  "resource_key_has_dot",
  "internal_resource_set",
  "resource_not_defined",
  "variable_in_auth_field",
  "variable_in_bundle_name",
  "invalid_engine",
  "terraform_engine_removed",
  "terraform_setting_has_no_effect",
  "script_no_content",
  "variable_in_script_content",
  "script_env_reference_not_resolved",
  "secret_value_not_variable",
  "secret_variable_has_default",
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
  /** A file the fix points to, offered as "Open … to the side" next to the change. */
  opens?: string;
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
  /** 1-based column the highlight ends before, when it is not the rest of the line. */
  endColumn?: number;
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
/**
 * How the Problems panel and graph say to check a path that uses a variable. The command-line
 * tool shows {@link CHECK_WITH_TARGET_CLI} in its place.
 */
export const PICK_TARGET_IN_GRAPH = "Pick a target in the graph to check it.";
export const CHECK_WITH_TARGET_CLI = "Use --target to check it.";

function pathNotCheckedIssue(
  rawPath: string,
  targetName: string | null | undefined,
): Pick<InspectorIssue, "severity" | "kind" | "title" | "fixHint"> {
  return {
    severity: "info",
    kind: "path_not_checked",
    title: targetName
      ? `Not checked: "${rawPath}" still uses a variable for target "${targetName}", so the file isn't known.`
      : `Not checked: "${rawPath}" uses a variable, so the file isn't known yet. ${PICK_TARGET_IN_GRAPH}`,
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
  if (problem.kind !== "missing_extension") return {};
  const written = writtenPathAt(resolvedPath, file, line, column);
  if (!written) return {};
  // Only the extension added, as written; or, when the suggestion also fixes letter case
  // (#477), the whole suggested path.
  const replacement = problem.suggestedPath.startsWith(rawPath)
    ? written + problem.suggestedPath.slice(rawPath.length)
    : problem.suggestedPath;
  return { fix: replacementFix(written, replacement) };
}

/**
 * The path as written at the issue's place, when it is the one that leads to
 * `resolvedPath` from the file's folder. Undefined when the value came from somewhere
 * else (a variable, a target override), so a fix never edits the wrong text.
 */
function writtenPathAt(
  resolvedPath: string | undefined,
  file: string | undefined,
  line: number | undefined,
  column: number | undefined,
): string | undefined {
  if (!resolvedPath || !file || !line || !column) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const written = writtenValueAt(text.split(/\r?\n/)[line - 1] ?? "", column);
  return written && path.resolve(path.dirname(file), written) === resolvedPath ? written : undefined;
}

/**
 * The title, detail and fix for a local path that doesn't exist, with "Did you mean"
 * when one file in the bundle fits (see pathSuggestions.ts). Without one, as before.
 */
function missingPathSuggestion(
  rawPath: string,
  resolvedPath: string | undefined,
  file: string | undefined,
  line: number | undefined,
  column: number | undefined,
  expects: ExpectedFile | undefined,
  bundleFiles: () => FileList,
  excluded: (file: string) => boolean,
  notebookRule: NotebookHeaderRule | undefined,
): Pick<InspectorIssue, "detail" | "fix"> {
  // A path from `/` is a workspace path to the CLI, which never looks for it locally
  // (checked on CLI 0.299.0 and 1.21.0): a local file is no answer to it.
  if (!expects || !resolvedPath || !file || rawPath.startsWith("/") || path.isAbsolute(rawPath)) return { detail: rawPath };
  const suggestion = movedFileSuggestion({ rawPath, resolvedPath, sourceFile: file, expects, files: bundleFiles, excluded, ...(notebookRule ? { notebookRule } : {}) });
  if (!suggestion) return { detail: rawPath };
  const written = writtenPathAt(resolvedPath, file, line, column);
  return {
    detail: `${rawPath}. Did you mean "${suggestion}"?`,
    ...(written
      ? { fix: { ...replacementFix(written, suggestion), opens: path.resolve(path.dirname(file), suggestion) } }
      : {}),
  };
}

/**
 * What a task's path field takes, for a suggestion. None for folders, dbt projects and
 * paths in a Git source, which aren't files in this bundle.
 */
function expectedFileFor(ref: Pick<FileReference, "referenceType" | "source">): ExpectedFile | undefined {
  if (ref.source === "GIT") return undefined;
  if (ref.referenceType === "notebook") return "notebook";
  if (ref.referenceType === "python_script" || ref.referenceType === "sql") return "file";
  if (ref.referenceType === "python_wheel" || ref.referenceType === "jar") return "any";
  return undefined;
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
  if (problem.kind === "is_a_folder") {
    return {
      kind: "path_is_a_folder",
      title: `"${path}" is a folder, not a ${problem.expects}.`,
      fixHint:
        problem.expects === "notebook"
          ? "Point it at a notebook in the folder, with its extension (.py, .r, .scala, .sql or .ipynb)."
          : "Point it at a file in the folder.",
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
    fixHint: header && problem.kind === "not_a_notebook" && problem.markerNotExact
      ? `Its first line has "Databricks notebook source" but isn't exactly "${header}". Databricks CLI versions before ${NOTEBOOK_MARKER_RULE_CLI_VERSION} need it exact, so an invisible byte order mark or other text on that line makes it a plain file. Make the first line exactly "${header}", or update the Databricks CLI.`
      : header
      ? `Add "${header}" as its first line, or run it from a task that takes a file.`
      : /\.ipynb$/i.test(path)
        ? "It is not a valid Jupyter notebook: it needs cells and metadata, at nbformat 4 or later."
        : "Notebooks need a .py, .r, .scala, .sql or .ipynb extension.",
  };
}

/**
 * `%run` and `dbutils.notebook.run` targets that aren't a notebook the bundle deploys
 * (#233): `bundle validate` passes and the run fails. See runTargets.ts for the rule.
 * A notebook that exists but isn't uploaded gets the usual `excluded_from_sync`.
 */
function runTargetIssues(
  graph: BundleGraph,
  task: BundleGraphNode,
  taskData: TaskNodeData,
  syncExclusionOf: (file: string) => SyncExclusion | undefined,
  bundleRoot: string,
): InspectorIssue[] {
  const issues: InspectorIssue[] = [];
  for (const ref of taskData.fileReferences) {
    if (ref.referenceType !== "notebook" || ref.source === "GIT" || !ref.exists) continue;
    const fileNode = graph.nodes.find((node) => node.id === `file:${ref.resolvedPath ?? ref.path}`);
    const runs = (fileNode?.data.runTargets as RunTarget[] | undefined) ?? [];
    for (const run of runs) {
      // Only the task's own notebook: how a notebook reached with %run resolves its
      // own %run paths wasn't tested.
      if (ref.resolvedPath && path.resolve(run.file) !== path.resolve(ref.resolvedPath)) continue;
      const check = checkRunTarget(run.file, run.target, graph.notebookRule);
      const how = run.kind === "run" ? "%run" : "dbutils.notebook.run";
      const shown = run.target === null ? "" : unquote(run.target);
      const base = {
        id: `run-target:${task.id}:${run.file}:${run.line}`,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        ...issueLocation(run.file, run.line),
      };
      if (check.status === "notebook") {
        const exclusion = syncExclusionOf(check.file);
        if (exclusion) issues.push({ ...base, severity: "warning", ...syncExclusionIssue(shown, exclusion, bundleRoot) });
        continue;
      }
      if (check.status === "unchecked") continue;
      const fix =
        "Point it at a notebook in the bundle: a relative path (./name or ../folder/name), with or without the file extension.";
      if (check.status === "missing") {
        issues.push({
          ...base,
          severity: "error",
          kind: "run_target_not_found",
          title: `${how} target "${shown}" may not exist.${check.suggestion ? ` Did you mean "${check.suggestion}"?` : ""}`,
          fixHint: `No notebook is at that path next to this one, so the run fails with "Notebook not found". ${fix}`,
        });
      } else if (check.status === "file") {
        issues.push({
          ...base,
          severity: "error",
          kind: "run_target_not_found",
          title: `${how} target "${shown}" may be a file, not a notebook.`,
          fixHint: `${path.basename(check.file)} has no Databricks notebook header, so it deploys as a plain file and ${how} can't run it. Add the header as its first line, or import it as Python code instead.`,
        });
      } else {
        issues.push({
          ...base,
          severity: "error",
          kind: "run_target_not_found",
          title: `${how} target "${shown}" may be a folder, not a notebook.`,
          fixHint: `${how} runs one notebook. ${fix}`,
        });
      }
    }
  }
  return issues;
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
      const ownLanguages = own(usage.defaultLanguages, read.name);
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
 * A SQL file task's file reads a `:name` parameter that neither the task's
 * `sql_task.parameters` nor the job's parameters pass. Deploy succeeds and the run fails
 * with UNBOUND_SQL_PARAMETER; job parameters do reach SQL file tasks (both tested on a
 * serverless SQL warehouse, CLI v1.24.0, issue 234). A parameter passed but not read is
 * fine, so nothing is said about it.
 */
function sqlParameterIssues(
  graph: BundleGraph,
  task: BundleGraphNode,
  taskData: TaskNodeData,
  jobParameterNames: ReadonlySet<string>,
): InspectorIssue[] {
  const issues: InspectorIssue[] = [];
  for (const ref of taskData.fileReferences) {
    if (ref.referenceType !== "sql" || ref.source === "GIT" || !ref.exists) continue;
    const fileNode = graph.nodes.find((node) => node.id === `file:${ref.resolvedPath ?? ref.path}`);
    const markers = (fileNode?.data.sqlParameterMarkers as Array<{ name: string; line: number }> | undefined) ?? [];
    const textParameters = (fileNode?.data.sqlTextParameters as SqlTextParameter[] | undefined) ?? [];
    const passed = new Set([...taskData.taskParameterReferences.map((p) => p.name), ...jobParameterNames]);
    const read = new Set([...markers.map((marker) => marker.name), ...textParameters.map((use) => use.name)]);
    const unread = [...passed].filter((name) => !read.has(name));
    const reported = new Set<string>();
    for (const marker of markers) {
      if (passed.has(marker.name) || reported.has(marker.name)) continue;
      reported.add(marker.name);
      const suggestion = closestName(marker.name, unread);
      issues.push({
        id: `sql-parameter-not-passed:${task.id}:${ref.resolvedPath}:${marker.name}`,
        severity: "warning",
        kind: "sql_parameter_not_set",
        title: suggestion
          ? `Pass "${marker.name}" to this task: the SQL file reads ":${marker.name}", so without it the run may fail. Did you mean "${suggestion}"?`
          : `Pass "${marker.name}" to this task: the SQL file reads ":${marker.name}", so without it the run may fail.`,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint: `Pass "${marker.name}" in the task's sql_task.parameters or the job's parameters.`,
        ...issueLocation(ref.resolvedPath, marker.line),
      });
    }

    // {{name}} text parameters (#484): the value is pasted in already quoted, and an
    // unpassed one stays as written. In quotes the query still runs, on that text.
    const reportedText = new Set<string>();
    for (const use of textParameters) {
      const where = { ...issueLocation(ref.resolvedPath, use.line, use.column), endColumn: use.endColumn };
      if (passed.has(use.name)) {
        if (!use.wholeString) continue;
        // The quotes are the problem, so they are highlighted too.
        where.column = use.column - 1;
        where.endColumn = use.endColumn + 1;
        issues.push({
          id: `sql-parameter-quoted:${task.id}:${ref.resolvedPath}:${use.line}:${use.column}`,
          severity: "warning",
          kind: "sql_parameter_quoted",
          title: `Remove the quotes around "{{${use.name}}}": Databricks already adds quotes, so the run may fail.`,
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: ref.yamlPath,
          fixHint: `Write {{${use.name}}} without quotes.`,
          ...where,
        });
        continue;
      }
      const key = `${use.name}:${use.inString}`;
      if (reportedText.has(key)) continue;
      reportedText.add(key);
      const suggestion = closestName(use.name, unread);
      const title = use.inString
        ? `Pass "${use.name}" to this task: without it, the query may succeed with wrong results.`
        : `Pass "${use.name}" to this task: without it, the run may fail.`;
      issues.push({
        id: `sql-text-parameter-not-passed:${task.id}:${ref.resolvedPath}:${use.name}:${use.inString ? "string" : "code"}`,
        severity: "warning",
        kind: "sql_parameter_not_set",
        title: suggestion ? `${title} Did you mean "${suggestion}"?` : title,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: ref.yamlPath,
        fixHint: `Pass "${use.name}" in the task's sql_task.parameters or the job's parameters.`,
        ...where,
      });
    }
  }
  return issues;
}

/**
 * The targets that deploy the bundle's schemas under another name. The CLI adds the
 * target's name prefix to every schema (`apply_presets.go`, v0.299.2 to v1.25.0): the
 * target's `presets.name_prefix`, else the bundle's, and in development mode
 * `[dev <user>] ` when there is none, shown as `dev_<user>_`. Not when
 * `experimental.skip_name_prefix_for_schema` is set, which targets can't change.
 */
function targetsRenamingSchemas(parsedBundle: ParsedBundleConfig): Array<{ name: string; development: boolean; prefix: string }> {
  const root = parsedBundle as unknown as {
    presets?: { name_prefix?: unknown };
    experimental?: { skip_name_prefix_for_schema?: unknown };
    targets?: Record<string, { mode?: unknown; presets?: { name_prefix?: unknown } } | null>;
  };
  if (root.experimental?.skip_name_prefix_for_schema === true) return [];
  const renaming: Array<{ name: string; development: boolean; prefix: string }> = [];
  for (const [name, target] of Object.entries(root.targets ?? {})) {
    const own = target?.presets?.name_prefix;
    const prefix = typeof own === "string" ? own : typeof root.presets?.name_prefix === "string" ? root.presets.name_prefix : "";
    const development = target?.mode === "development";
    // The CLI keeps letters and numbers of the prefix; one with neither adds nothing.
    if ((development && prefix === "") || /[\p{L}\p{N}]/u.test(prefix)) renaming.push({ name, development: development && prefix === "", prefix });
  }
  return renaming;
}

/**
 * Code or task parameters that write the name of a schema this bundle defines, when a
 * target deploys that schema under a prefixed name: deploy succeeds and the run fails
 * with SCHEMA_NOT_FOUND, because only `${resources.schemas.<key>.name}` follows the rename
 * (tested on a serverless workspace, CLI v1.24.0, issue 235). Checked on the structural
 * preview, where names are still as written.
 */
function schemaRenameIssues(graph: BundleGraph, parsedBundle: ParsedBundleConfig, tasks: BundleGraphNode[]): InspectorIssue[] {
  const renaming = targetsRenamingSchemas(parsedBundle);
  if (renaming.length === 0) return [];
  const schemas = Object.entries((parsedBundle.resources?.schemas ?? {}) as Record<string, { name?: unknown } | null>)
    .map(([key, schema]) => ({ key, name: typeof schema?.name === "string" ? schema.name : "" }))
    .filter((schema) => schema.name !== "" && !schema.name.includes("${"));
  if (schemas.length === 0) return [];

  const quote = (names: string[]) => names.map((n) => `"${n}"`).join(", ");
  /** One short line: what the target does to the schema, and both ways a written name goes wrong. */
  const renamed = (schema: { name: string }) => {
    const dev = renaming.filter((t) => t.development).map((t) => t.name);
    const other = renaming.filter((t) => !t.development).map((t) => t.name);
    const what =
      dev.length === 1 && other.length === 0
        ? `is renamed to "dev_<you>_${schema.name}" in target "${dev[0]}"`
        : renaming.length === 1
          ? `gets target "${renaming[0]!.name}"'s name prefix`
          : `gets a name prefix in targets ${quote(renaming.map((t) => t.name))}`;
    return `schema "${schema.name}" ${what}; this name may not exist there, or may be a different schema.`;
  };
  const matching = (text: string) => {
    const parts = text.split(".").map((part) => part.replace(/`/g, "").toLowerCase());
    return schemas.find((schema) => parts.includes(schema.name.toLowerCase()));
  };
  const issues: InspectorIssue[] = [];
  const add = (issue: InspectorIssue) => {
    if (!issues.some((existing) => existing.id === issue.id)) issues.push(issue);
  };

  for (const task of tasks) {
    const taskData = task.taskData;
    if (!taskData || parentJobHasGitSource(graph, task)) continue;
    for (const data of taskData.nestedTask ? [taskData, taskData.nestedTask] : [taskData]) {
      for (const ref of data.fileReferences) {
        if (ref.source === "GIT" || !ref.exists) continue;
        const fileNode = graph.nodes.find((node) => node.id === `file:${ref.resolvedPath ?? ref.path}`);
        const names = (fileNode?.data.qualifiedNames as Array<{ parts: string[]; line: number }> | undefined) ?? [];
        for (const written of names) {
          const schema = matching(written.parts.join("."));
          if (!schema) continue;
          add({
            id: `schema-renamed:${task.id}:${ref.resolvedPath}:${schema.key}`,
            severity: "warning",
            kind: "schema_renamed_in_target",
            title: `S${renamed(schema).slice(1)}`,
            taskId: task.id,
            taskName: task.displayName,
            yamlPath: ref.yamlPath,
            fixHint: `Pass \${resources.schemas.${schema.key}.name} to the task as a parameter and read it in the code, instead of writing the name.`,
            ...issueLocation(ref.resolvedPath, written.line),
          });
        }
      }
      for (const parameter of data.taskParameterReferences) {
        const schema = parameter.value ? matching(parameter.value) : undefined;
        if (!schema) continue;
        add({
          id: `schema-renamed-parameter:${task.id}:${parameter.yamlPath}`,
          severity: "warning",
          kind: "schema_renamed_in_target",
          title: `Parameter "${parameter.name}": ${renamed(schema)}`,
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: parameter.yamlPath,
          fixHint: `Use \${resources.schemas.${schema.key}.name} instead of the written name.`,
          ...issueLocation(sourceFileForTask(task), parameter.sourceLine || undefined, parameter.sourceColumn),
        });
      }
    }
    for (const parameter of taskData.jobParameterReferences) {
      const schema = parameter.default ? matching(parameter.default) : undefined;
      if (!schema) continue;
      add({
        id: `schema-renamed-job-parameter:${taskData.parentJobId}:${parameter.name}`,
        severity: "warning",
        kind: "schema_renamed_in_target",
        title: `Job parameter "${parameter.name}": ${renamed(schema)}`,
        resourceId: taskData.parentJobId,
        fixHint: `Use \${resources.schemas.${schema.key}.name} as the default instead of the written name.`,
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
  // Action first, then why, then what it means at run time (#514). One line: the second
  // way to fix it goes in the fix hint. Not "this task": pipelines and %run get it too.
  const missing = "so it may be missing at run time";
  if (exclusion.rule === "gitignore") {
    const gitignore = path
      .relative(bundleRoot, exclusion.gitignoreFile)
      .split(path.sep)
      .join("/");
    return {
      kind: "excluded_from_sync",
      title: `Add "${filePath}" to sync.include: ${gitignore} stops it from being deployed, ${missing}.`,
      fixHint: `Add the file to sync.include in databricks.yml, or remove the rule that matches it from ${gitignore}.`,
    };
  }
  if (exclusion.rule === "symlink") {
    const link = path.relative(bundleRoot, exclusion.link).split(path.sep).join("/");
    return {
      kind: "excluded_from_sync",
      title: exclusion.folder
        ? `Replace the link "${link}" with the real folder: links aren't deployed, so "${filePath}" may be missing at run time.`
        : `Replace the link "${filePath}" with the real file: links aren't deployed, ${missing}.`,
      fixHint: "bundle deploy skips symbolic links, files and folders alike. Point the path at the real file, or replace the link with a copy.",
    };
  }
  if (exclusion.rule === "sync_exclude") {
    return {
      kind: "excluded_from_sync",
      title: `Change the sync.exclude pattern that matches "${filePath}": it stops the file from being deployed, ${missing}.`,
      fixHint: "Remove the pattern from sync.exclude in databricks.yml, or change it so it no longer matches this file.",
    };
  }
  const folder = filePath.split(/[\\/]/).includes(".git") ? ".git" : ".databricks";
  return {
    kind: "excluded_from_sync",
    title: `Move "${filePath}" out of ${folder}: files there aren't deployed, ${missing}.`,
    fixHint: "Move the file out of .databricks or .git.",
  };
}

/** Most files read from one glob folder: past it, no finding rather than a slow check. */
const MAX_GLOB_FOLDER_FILES = 2000;

/**
 * Every file under a pipeline glob's folder, hidden files included, or undefined past
 * {@link MAX_GLOB_FOLDER_FILES}, so a huge folder can't slow the check.
 */
function globFolderFiles(folder: string): string[] | undefined {
  const files: string[] = [];
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(full)) return false;
      } else {
        files.push(full);
        if (files.length > MAX_GLOB_FOLDER_FILES) return false;
      }
    }
    return true;
  };
  return walk(folder) ? files : undefined;
}

/**
 * The file types a pipeline glob takes or skips (live, CLI v1.27.0, #531, twice each next
 * to a valid .sql file): `.py` and `.sql` are its sources; `.md`, `.txt`, `.csv`, `.json`
 * and `.ipynb` were skipped. Every other type tested failed the update with
 * "[UNSUPPORTED_LIBRARY_FILE_TYPE] ... does not have .py or .sql suffix": no extension
 * (`.gitkeep`, `.DS_Store`, `.env`, `Makefile`), `.yml`, `.yaml`, `.toml`, `.cfg`, `.ini`,
 * `.lock`, `.whl`, `.png`, `.html`, `.sh`, `.java`, `.r`, `.R` and `.scala`. So any type not
 * listed here may fail, which the finding says with "may".
 */
const PIPELINE_GLOB_ACCEPTS = new Set([".py", ".sql", ".md", ".txt", ".csv", ".json", ".ipynb"]);

export function failsPipelineGlob(file: string): boolean {
  // `.gitkeep` has no extension to Node either: path.extname gives "".
  return !PIPELINE_GLOB_ACCEPTS.has(path.extname(path.basename(file)).toLowerCase());
}

/** The deployed files under a glob's folder that fail the pipeline update (#531). */
function unsupportedPipelineFiles(folder: string, exclusionOf: (file: string) => SyncExclusion | undefined): string[] {
  return (globFolderFiles(folder) ?? []).filter((file) => !exclusionOf(file) && failsPipelineGlob(file));
}

/**
 * The rule that leaves out every file under a pipeline glob's folder (`folder/**`), when
 * each one is left out. Hidden files count: deploy uploads them, and the pipeline reads
 * them (a `.gitignore` in the folder failed the update as UNSUPPORTED_LIBRARY_FILE_TYPE,
 * live, CLI 1.27.0). Undefined when any file is deployed, or when the folder holds more
 * than {@link MAX_GLOB_FOLDER_FILES}.
 */
function everyFileExcluded(
  folder: string,
  exclusionOf: (file: string) => SyncExclusion | undefined,
): SyncExclusion | undefined {
  const files = globFolderFiles(folder);
  if (!files || files.length === 0) return undefined;
  const exclusions = files.map(exclusionOf);
  if (exclusions.some((exclusion) => exclusion === undefined)) return undefined;
  // One rule named only when it is the same for every file.
  const [first] = exclusions;
  const same = exclusions.every((exclusion) =>
    exclusion!.rule === first!.rule &&
    (exclusion!.rule !== "gitignore" || first!.rule !== "gitignore" || exclusion!.gitignoreFile === first!.gitignoreFile),
  );
  return same ? first : { rule: "always" };
}

/** The title and fix for a pipeline glob none of whose files is deployed (#526). */
function globExclusionIssue(
  written: string,
  folder: string,
  exclusion: SyncExclusion,
  bundleRoot: string,
): Pick<InspectorIssue, "kind" | "title" | "fixHint"> {
  const missing = "so the pipeline may find no source files at run time";
  // sync.include is read from the bundle root, not from the YAML file's folder.
  const include = `${path.relative(bundleRoot, folder).split(path.sep).join("/") || "."}/**`;
  if (exclusion.rule === "gitignore") {
    const gitignore = path.relative(bundleRoot, exclusion.gitignoreFile).split(path.sep).join("/");
    return {
      kind: "excluded_from_sync",
      title: `Add "${include}" to sync.include: ${gitignore} stops every file in "${written}" from being deployed, ${missing}.`,
      fixHint: `Add the files to sync.include in databricks.yml, or remove the rule that matches them from ${gitignore}.`,
    };
  }
  if (exclusion.rule === "sync_exclude") {
    return {
      kind: "excluded_from_sync",
      title: `Change the sync.exclude pattern that matches the files in "${written}": none of them are deployed, ${missing}.`,
      fixHint: "Remove the pattern from sync.exclude in databricks.yml, or change it so it no longer matches these files.",
    };
  }
  return {
    kind: "excluded_from_sync",
    title: `No file in "${written}" is deployed, ${missing}.`,
    fixHint: "Each file is left out by .gitignore, sync.exclude, a symbolic link or the .databricks folder. Add them to sync.include, or change the rules that leave them out.",
  };
}

/**
 * Why deploy refuses a pipeline glob, if it does (live, CLI v1.27.0, #530). The only
 * wildcard Databricks takes in `glob.include` is a trailing `/**`: a single `*` gets
 * "Single asterisk glob pattern is not supported ... Use a double asterisk '**'", and `*`
 * or `?` anywhere else "Special characters *?\\ are reserved". The suggestion swaps a
 * wildcard in the last part of the path, such as `dlt/*` or `dlt/*.sql`, for `dlt/**`.
 */
export function unsupportedGlob(include: string): { title: string; fixHint: string; suggestion?: string } | undefined {
  const rest = include.endsWith("/**") ? include.slice(0, -3) : include;
  if (!/[*?]/.test(rest)) return undefined;
  const slash = rest.lastIndexOf("/");
  const folder = rest.slice(0, slash);
  const last = rest.slice(slash + 1);
  const suggestion = slash > 0 && !/[*?]/.test(folder) && !include.endsWith("/**") ? `${folder}/**` : undefined;
  const single = /(^|[^*])\*([^*]|$)/.test(rest);
  return {
    title:
      single && last.includes("*")
        ? "Pipeline glob uses a single *, which Databricks doesn't accept, so deploy may fail."
        : "Pipeline glob uses * or ? where Databricks doesn't accept them, so deploy may fail.",
    fixHint:
      "Use a folder ending in /** (every file below it), or one library entry per file. Deploy fails with \"Single asterisk glob pattern is not supported\" or \"Special characters *?\\ are reserved\".",
    ...(suggestion ? { suggestion } : {}),
  };
}

/** The quick fix to the suggested glob, while the YAML still holds the glob as written there. */
function globFix(
  written: string,
  suggestion: string | undefined,
  file: string | undefined,
  line: number | undefined,
  column: number | undefined,
): Pick<InspectorIssue, "fix"> {
  if (!suggestion || !file || !line || !column) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  return writtenValueAt(text.split(/\r?\n/)[line - 1] ?? "", column) === written ? { fix: replacementFix(written, suggestion) } : {};
}

/**
 * The 0-based columns an editor highlights for an issue on its line: from its column to
 * `endColumn` when it has one (a `{{name}}` placeholder, #484), else to the end of the line.
 */
export function issueHighlight(issue: Pick<InspectorIssue, "column" | "endColumn">): { start: number; end: number } {
  const start = Math.max(0, (issue.column ?? 1) - 1);
  const end = issue.endColumn && issue.endColumn - 1 > start ? issue.endColumn - 1 : Number.MAX_SAFE_INTEGER;
  return { start, end };
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
  // With sync.paths outside the bundle the CLI syncs from a different root, which is not
  // modelled. The default ["."], which the CLI fills in for a real target, is the bundle root.
  // Decided once: every check that uses the sync rules asks this.
  const syncRulesApply = syncsFromBundleRoot(bundleRoot, parsedBundle.sync);
  const syncExclusionOf = syncRulesApply ? createSyncExclusion(bundleRoot, parsedBundle.sync) : () => undefined;
  // The bundle's files, read once.
  let bundleFileList: FileList | undefined;
  const bundleFiles = () => (bundleFileList ??= filesUnder(bundleRoot));
  const excludedFromSync = (file: string) => syncExclusionOf(file) !== undefined;

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
        issues.push(...sqlParameterIssues(graph, task, data, jobParameterNames));
        issues.push(...runTargetIssues(graph, task, data, syncExclusionOf, bundleRoot));
      }
    }

    for (const ref of checkedTaskData.flatMap((data) => data.fileReferences)) {
      // Deploy refuses it (live, CLI 1.27.0): "source is set to GIT but no git_source settings
      // are provided" for a notebook, "Invalid use of git source" for a Python file (#521).
      // The path itself is checked as a local file below, as the CLI reads it.
      if (ref.strayGitSource) {
        issues.push({
          id: `git-source:${task.id}:${ref.yamlPath}:${ref.path}`,
          severity: "error",
          kind: "git_source_not_recommended",
          title: "Task has source: GIT, but its job has no git_source, so deploy may fail.",
          detail: ref.path,
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: ref.yamlPath,
          fixHint: "Remove source: GIT to use the bundle's file, or add git_source to the job.",
          ...issueLocation(
            ref.sourceFile || sourceFileForTask(task),
            ref.sourceLine || undefined,
            ref.sourceColumn,
          ),
        });
      }

      // The CLI rewrites no task path in a job with a git_source, so a relative WORKSPACE path
      // reaches the Jobs API as written, and deploy refuses it (live, CLI 1.27.0, #524):
      // "Only absolute paths are currently supported" (notebook, SQL file), "Relative paths
      // are only supported when source is set to GIT" (Python file). A variable may resolve
      // to an absolute path, and a cloud URI is not relative, so both are left alone.
      if (
        ref.source === "WORKSPACE" &&
        parentJobHasGitSource(graph, task) &&
        !ref.path.startsWith("/") &&
        !ref.path.includes("${") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(ref.path)
      ) {
        issues.push({
          id: `git-source-relative:${task.id}:${ref.yamlPath}:${ref.path}`,
          severity: "error",
          kind: "git_source_not_recommended",
          title: "Task has source: WORKSPACE with a relative path in a job with git_source, so deploy may fail.",
          detail: ref.path,
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: ref.yamlPath,
          fixHint: "Use a path from /Workspace, or remove source: WORKSPACE to read the path from the job's Git repository.",
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

      // A job with a git_source reads its task paths from the repo, which the CLI doesn't check
      // locally, and sets source: GIT on tasks that leave it out (CLI apply_default_task_source.go).
      if (!isMissingLocalPath(ref) || parentJobHasGitSource(graph, task)) continue;
      issues.push({
        id: `missing-file:${task.id}:${ref.yamlPath}:${ref.path}`,
        severity: "error",
        kind: "missing_file",
        title: "File not found",
        ...missingPathSuggestion(
          ref.path,
          ref.resolvedPath,
          ref.sourceFile || sourceFileForTask(task),
          ref.sourceLine || undefined,
          ref.sourceColumn,
          expectedFileFor(ref),
          bundleFiles,
          excludedFromSync,
          graph.notebookRule,
        ),
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
      // Deploy builds artifacts before it checks library files (CLI phases/build.go), so a
      // wheel the build writes isn't there yet on a fresh checkout (#525).
      if (ref.resolvedPath && mayBeBuilt(ref.resolvedPath, graph.buildOutputs)) continue;
      issues.push({
        id: `missing-library:${task.id}:${ref.yamlPath}:${ref.identifier}`,
        severity: "error",
        kind: "missing_library",
        title: ref.notAFile ? "Local library path must name a file" : "Missing local library",
        // A glob needs matches, and every match must be a file the CLI can upload.
        detail: ref.notAFile ? `${ref.identifier} (contains a path that is not a regular file)` :
          hasGlobCharacters(ref.identifier) ? `${ref.identifier} (no file matches)` : ref.identifier,
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
      // Deploy refuses `*` and `?` anywhere but a trailing `/**`, whatever the files (#530).
      const unsupported = ref.kind === "glob" ? unsupportedGlob(ref.path) : undefined;
      if (unsupported) {
        issues.push({
          id: `pipeline-glob:${pipeline.id}:${ref.yamlPath}`,
          severity: "error",
          kind: "missing_pipeline_source",
          title: unsupported.title,
          detail: unsupported.suggestion ? `${ref.path}. Did you mean "${unsupported.suggestion}"?` : ref.path,
          ...globFix(ref.path, unsupported.suggestion, ref.sourceFile, ref.sourceLine || undefined, ref.sourceColumn),
          resourceId: pipeline.id,
          yamlPath: `${pipeline.id}.${ref.yamlPath}`,
          fixHint: unsupported.fixHint,
          ...issueLocation(ref.sourceFile, ref.sourceLine || undefined, ref.sourceColumn),
        });
        continue;
      }
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
      // A glob whose every file is left out of the upload: the folder isn't in the workspace,
      // and the update fails with LIBRARY_FILE_NOT_FOUND (live, CLI 1.27.0, #526). One file
      // deployed is enough: with some files ignored, the update completed.
      // Only `folder/**`: deploy refuses a `folder/*` glob whatever its files ("Single
      // asterisk glob pattern is not supported", live, CLI 1.27.0).
      const globExclusion =
        ref.checked && ref.exists && ref.kind === "glob" && ref.resolvedPath && ref.path.endsWith("/**")
          ? everyFileExcluded(ref.resolvedPath, syncExclusionOf)
          : undefined;
      if (globExclusion) {
        issues.push({
          id: `excluded-from-sync:${pipeline.id}:${ref.yamlPath}`,
          severity: "warning",
          ...globExclusionIssue(ref.path, ref.resolvedPath!, globExclusion, bundleRoot),
          resourceId: pipeline.id,
          yamlPath: `${pipeline.id}.${ref.yamlPath}`,
          ...issueLocation(ref.sourceFile, ref.sourceLine || undefined, ref.sourceColumn),
        });
        continue;
      }
      // Deployed files the pipeline refuses, next to its sources (#531).
      const refusedFiles =
        ref.checked && ref.exists && ref.kind === "glob" && ref.resolvedPath && ref.path.endsWith("/**")
          ? unsupportedPipelineFiles(ref.resolvedPath, syncExclusionOf)
          : [];
      if (refusedFiles.length > 0) {
        const shown = refusedFiles.map((file) => path.relative(bundleRoot, file).split(path.sep).join("/")).sort();
        const others = shown.length > 1 ? ` and ${shown.length - 1} other file${shown.length > 2 ? "s" : ""}` : "";
        issues.push({
          id: `unsupported-pipeline-file:${pipeline.id}:${ref.yamlPath}`,
          severity: "error",
          kind: "unsupported_pipeline_file",
          title: `Add "${shown[0]}"${others} to sync.exclude: deployed under "${ref.path}", it may fail the pipeline, which only takes .py and .sql files.`,
          detail: shown.join(", "),
          resourceId: pipeline.id,
          yamlPath: `${pipeline.id}.${ref.yamlPath}`,
          fixHint:
            'The pipeline update fails with "UNSUPPORTED_LIBRARY_FILE_TYPE ... does not have .py or .sql suffix". Add the file to sync.exclude or .gitignore, or move it out of the folder.',
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
            : "Pipeline source file not found",
        ...(ref.kind === "glob"
          ? { detail: ref.path }
          : missingPathSuggestion(
              ref.path,
              ref.resolvedPath,
              ref.sourceFile,
              ref.sourceLine || undefined,
              ref.sourceColumn,
              ref.kind,
              bundleFiles,
              excludedFromSync,
              graph.notebookRule,
            )),
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
  issues.push(...pipelineSelectionIssues(graph));
  issues.push(...taskValueIssues(graph));
  issues.push(...includeIssues(parsedBundle, bundleRoot));
  issues.push(...jobStructureIssues(graph));
  issues.push(...runtimeSupportIssues(graph));
  // Neither the preview nor a real target's validate reports it; deploy does (#511).
  issues.push(...resourceKeyIssues(graph, bundleRoot));
  // The files deploy uploads are the same with or without a target.
  if (syncRulesApply) {
    issues.push(...workspacePathClashIssues(bundleRoot, bundleFiles().files, (file) => !excludedFromSync(file), graph.notebookRule));
  }
  // With a target the CLI reports it itself.
  if (!targetName) issues.push(...missingBundleNameIssues(parsedBundle, bundleRoot));
  // With a target the CLI has already replaced ${bundle.name}.
  if (!targetName) issues.push(...emptyBundleNameInRootPathIssues(parsedBundle, bundleRoot));
  // With a target the CLI reports its own "cycle detected" error.
  if (!targetName) issues.push(...variableLoopIssues(parsedBundle, graph.variableSources ?? {}));
  // With a target the CLI has already renamed the schemas, so the written names are gone.
  if (!targetName) issues.push(...schemaRenameIssues(graph, parsedBundle, tasks));
  // With a target the CLI runs these checks itself and reports its own errors (#389).
  if (!targetName) issues.push(...targetCheckIssues(graph, bundleRoot));

  return issues;
}

/**
 * Files deploy can't both upload, as they get the same workspace path (#370). See
 * workspacePathClashes.ts for the CLI's rule and the cases checked on a workspace.
 */
export function workspacePathClashIssues(
  bundleRoot: string,
  files: readonly string[],
  uploaded: (file: string) => boolean,
  rule: NotebookHeaderRule = "contains",
): InspectorIssue[] {
  const quoted = (name: string) => `"${name}"`;
  return findWorkspacePathClashes(bundleRoot, files, uploaded, rule).map((clash) =>
    clash.kind === "files"
      ? {
          id: `workspace-path:${clash.workspacePath}`,
          severity: "error",
          kind: "same_workspace_path",
          title: `${clash.files.map(quoted).join(" and ")} both deploy to ${quoted(clash.workspacePath)}, so bundle deploy may fail.`,
          fixHint:
            'Notebooks lose their file extension when deployed, so these files get one workspace path, and the Databricks CLI stops with "point to the same remote file location". Rename or remove one of them, or leave one out with sync.exclude.',
          ...issueLocation(path.join(bundleRoot, clash.files[0]!), 1),
        }
      : {
          id: `workspace-path:${clash.workspacePath}`,
          severity: "error",
          kind: "same_workspace_path",
          title: `Notebook ${quoted(clash.notebook)} deploys to ${quoted(clash.workspacePath)}, which is also a folder, so bundle deploy may fail.`,
          fixHint:
            'Notebooks lose their file extension when deployed, so this notebook would take the folder\'s place, and the upload fails with "type mismatch". Rename the notebook or the folder.',
          ...issueLocation(path.join(bundleRoot, clash.notebook), 1),
        },
  );
}

/** Task graph, duplicate key (#135), environment (#418) and job setting (#237) mistakes in jobs. */
/** The checks the CLI skips in the structural preview because no target is picked (#389). See targetChecks.ts. */
function targetCheckIssues(graph: BundleGraph, bundleRoot: string): InspectorIssue[] {
  const findings = graph.targetCheckFindings ?? [];
  // A key reached through a YAML merge has no line: the finding goes on databricks.yml.
  const bundleFile = findings.some((finding) => !finding.location)
    ? path.join(bundleRoot, readIncludeEntries(bundleRoot).file ?? "databricks.yml")
    : undefined;
  return findings.map((finding) => {
    const { file = bundleFile, line, column } = finding.location ?? {};
    return {
      id: `target-check:${finding.kind}:${finding.yamlPath}:${finding.title}`,
      severity: finding.severity,
      kind: finding.kind,
      title: finding.title,
      fixHint: finding.fixHint,
      yamlPath: finding.yamlPath,
      ...(finding.resourceId ? { resourceId: finding.resourceId } : {}),
      ...issueLocation(file, line, column),
    };
  });
}

/** Resource keys with a dot, which deploy doesn't accept (#511). */
function resourceKeyIssues(graph: BundleGraph, bundleRoot: string): InspectorIssue[] {
  const findings = graph.resourceKeyFindings ?? [];
  // A key reached through a YAML merge has no line: the finding goes on databricks.yml.
  const bundleFile = findings.some((finding) => !finding.location)
    ? path.join(bundleRoot, readIncludeEntries(bundleRoot).file ?? "databricks.yml")
    : undefined;
  return findings.map((finding) => {
    const { file = bundleFile, line, column } = finding.location ?? {};
    const resourceId = `resources.${finding.group}.${finding.key}`;
    return {
      id: `resource-key:${resourceId}`,
      severity: "error",
      kind: "resource_key_has_dot",
      title: finding.title,
      fixHint: finding.fixHint,
      yamlPath: resourceId,
      resourceId,
      ...issueLocation(file, line, column),
    };
  });
}

/** Clusters on a Databricks Runtime near or past end of support (issue 485). */
function runtimeSupportIssues(graph: BundleGraph): InspectorIssue[] {
  return (graph.runtimeSupportFindings ?? []).map((finding) => {
    const { file, line, column } = finding.location ?? {};
    return {
      id: `runtime-support:${finding.resourceId}:${finding.subject}`,
      severity: finding.severity,
      kind: "runtime_end_of_support",
      title: finding.title,
      ...(finding.taskKey
        ? { taskId: `${finding.resourceId}.tasks.${finding.taskKey}`, taskName: finding.taskKey }
        : { resourceId: finding.resourceId }),
      fixHint: finding.fixHint,
      ...issueLocation(file, line, column),
    };
  });
}

function jobStructureIssues(graph: BundleGraph): InspectorIssue[] {
  return (graph.jobStructureFindings ?? []).map((finding) => {
    const jobId = `resources.jobs.${finding.jobKey}`;
    const { file, line, column } = finding.location ?? {};
    return {
      id: `job-structure:${finding.kind}:${jobId}:${finding.taskKey ?? ""}:${finding.subject}:${file ?? ""}:${line ?? ""}:${column ?? ""}`,
      // Deploy rejects these, or the run fails; duplicates deploy, merged into one.
      severity:
        finding.kind === "duplicate_task_key" || finding.kind === "duplicate_job_parameter" ? "warning" : "error",
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
        title: `"${file}" defines resources, but no include entry loads it, so they won't be deployed.`,
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

const setText = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Reports targets that `bundle deploy` rejects for having no bundle name (#340). The CLI
 * needs the name for a target's default deploy folder, `.bundle/<name>/<target>`, and stops
 * with "bundle name not defined" when neither is set. With `workspace.root_path` it only
 * warns and deploys. The structural preview shows neither, so the inspector says it here.
 * A target can set its own `bundle.name` and `workspace.root_path`. With no targets the CLI
 * adds one called `default`, so the bundle's own settings decide.
 */
export function missingBundleNameIssues(parsedBundle: ParsedBundleConfig, bundleRoot: string): InspectorIssue[] {
  const ownRootPath = (parsedBundle.workspace as { root_path?: unknown } | undefined)?.root_path;
  const targets = Object.entries(parsedBundle.targets ?? {});
  const candidates: ReadonlyArray<readonly [string, TargetConfig | null]> = targets.length ? targets : [["default", {}]];
  const failing = candidates
    .filter(([, target]) => {
      // The preview preserves an empty YAML target as null. An explicit empty
      // name overrides the base name; an omitted name inherits it.
      const bundle = target?.bundle as { name?: unknown } | undefined;
      const workspace = target?.workspace as { root_path?: unknown } | undefined;
      return !setText(bundle?.name ?? parsedBundle.bundle.name) && !setText(workspace?.root_path ?? ownRootPath);
    })
    .map(([name]) => name);
  if (failing.length === 0) return [];

  const { file: bundleFile, text } = readIncludeEntries(bundleRoot);
  const bundleLine = (text ?? "").split("\n").findIndex((line) => /^bundle\s*:/.test(line));
  const named = failing.map((name) => `"${name}"`).join(", ");
  const every = targets.length === 0 || failing.length === targets.length;
  return [
    {
      id: `bundle:missing-name:${failing.join(",")}`,
      severity: "error",
      kind: "missing_bundle_name",
      title: every
        ? 'The bundle has no name, so "databricks bundle deploy" fails. The Databricks CLI needs bundle: name: to make the deploy folder.'
        : `The bundle has no name, so "databricks bundle deploy" fails for ${failing.length === 1 ? "target" : "targets"} ${named}. The Databricks CLI needs bundle: name: to make the deploy folder.`,
      fixHint: "Add a name under bundle: in databricks.yml, for example bundle: name: my_bundle.",
      file: path.join(bundleRoot, bundleFile ?? "databricks.yml"),
      ...(bundleLine >= 0 ? { line: bundleLine + 1 } : {}),
    },
  ];
}

/**
 * Variable values that refer to each other in a loop (#228). The structural preview never
 * resolves variables, so without this the loop shows only once a target is picked. One
 * finding per variable in the loop, at the line its value comes from, as task loops have.
 * See variableLoops.ts for what the CLI does with each kind of loop.
 */
export function variableLoopIssues(
  parsedBundle: ParsedBundleConfig,
  sources: Record<string, VariableSources>,
): InspectorIssue[] {
  return findVariableLoops(parsedBundle).flatMap((loop) => {
    const chain = loop.path.join(" → ");
    const named = loop.targets.map((name) => `"${name}"`).join(", ");
    const where = loop.everyTarget
      ? "every target"
      : `${loop.targets.length === 1 ? "target" : "targets"} ${named}`;
    const title = loop.complex
      ? `Variables refer to each other in a loop through a complex value: ${chain}.`
      : `Variables refer to each other in a loop: ${chain}.`;
    const fixHint = loop.complex
      ? `The Databricks CLI stops resolving them after 11 rounds and warns "Variables references are too deep", so \${var...} text may stay in the deployed values, on ${where}. Give one of them a value that doesn't refer back.`
      : `The Databricks CLI can't resolve them, so validate and deploy fail on ${where} with "cycle detected in field resolution". Give one of them a value that doesn't refer back. A BUNDLE_VAR_ environment variable or --var could also set one, which the inspector doesn't see.`;
    return loop.variables.map((name) => {
      const override = loop.overrideTarget[name];
      const location = override ? own(own(sources, name)?.targets, override) : own(sources, name)?.definition;
      return {
        id: `variable-loop:${chain}:${JSON.stringify(loop.overrideTarget)}:${name}`,
        severity: loop.complex ? ("warning" as const) : ("error" as const),
        kind: "variable_reference_loop" as const,
        title,
        detail: name,
        yamlPath: override ? `targets.${override}.variables.${name}` : `variables.${name}`,
        fixHint,
        ...issueLocation(location?.file, location?.line, location?.column),
      };
    });
  });
}

/**
 * Warns where `workspace.root_path` uses `${bundle.name}` and the bundle has no name (#341).
 * The CLI makes that part empty, `.bundle//dev`, which the workspace stores as `.bundle/dev`,
 * so every nameless bundle with the same root_path deploys to one folder. A second deploy
 * there deleted the first bundle's job and exited 0. With `name: ""` the CLI prints nothing.
 */
export function emptyBundleNameInRootPathIssues(
  parsedBundle: ParsedBundleConfig,
  bundleRoot: string,
): InspectorIssue[] {
  const ownRootPath = (parsedBundle.workspace as { root_path?: unknown } | undefined)?.root_path;
  const targets = Object.entries(parsedBundle.targets ?? {});
  const folders = new Map<string, string>();
  for (const [targetName, target] of targets.length ? targets : [["default", {}] as const]) {
    const bundle = (target as { bundle?: { name?: unknown } } | null)?.bundle;
    const workspace = (target as { workspace?: { root_path?: unknown } } | null)?.workspace;
    const rootPath = workspace?.root_path ?? ownRootPath;
    if (setText(bundle?.name ?? parsedBundle.bundle.name) || typeof rootPath !== "string" || !rootPath.includes("${bundle.name}")) continue;
    const parts = rootPath.replaceAll("${bundle.name}", "").replaceAll("${bundle.target}", targetName).split("/");
    const empty = parts.findIndex((part, index) => index > 1 && part === "");
    const folder = empty > 0 ? parts.slice(empty - 1).join("/") : parts.join("/");
    folders.set(folder, targetName);
  }
  if (folders.size === 0) return [];

  const { file: bundleFile, text } = readIncludeEntries(bundleRoot);
  const rootPathLine = (text ?? "")
    .split("\n")
    .findIndex((line) => /^\s*root_path\s*:.*\$\{bundle\.name\}/.test(line));
  return [...folders].map(([folder, targetName]) => ({
    id: `bundle:empty-name-root-path:${targetName}`,
    severity: "warning" as const,
    kind: "empty_bundle_name_in_root_path" as const,
    title:
      `root_path uses \${bundle.name}, but the bundle has no name, so it deploys to "${folder}". ` +
      "Another bundle with no name and the same root_path deploys to the same folder and can delete this bundle's resources.",
    fixHint: "Add a name under bundle: in databricks.yml.",
    file: path.join(bundleRoot, bundleFile ?? "databricks.yml"),
    ...(rootPathLine >= 0 ? { line: rootPathLine + 1 } : {}),
  }));
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
    // An app's `resources` secret entry draws a line on the overview (#446); it is not checked here yet.
    if (edge.data?.appResource) continue;

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
    const firstLine = typeof edge.data?.line === "number" ? edge.data.line : undefined;
    const firstColumn = typeof edge.data?.column === "number" ? edge.data.column : undefined;
    // A file's link holds every line that names the scope: one finding each (#463).
    const lines = Array.isArray(edge.data?.lines)
      ? edge.data.lines.filter((value): value is number => typeof value === "number")
      : [];
    for (const line of lines.length ? lines : [firstLine]) {
      const column = line === firstLine ? firstColumn : undefined;
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
  }

  // A scope the code reads from a parameter, by that parameter's value in the bundle (issue 535).
  const scopes = bundleSecretScopes(graph.nodes);
  for (const task of graph.nodes) {
    if (task.nodeType !== "task") continue;
    for (const read of taskRuntimeSecrets(graph, task.id, undefined, nodeById)) {
      if (!read.scope || scopes.some((scope) => scope.name === read.scope)) continue;
      const byKey = scopes.find((scope) => scope.resourceKey === read.scope);
      if (!byKey) continue;
      const id = `secret-scope-name:parameter:${task.id}:${read.file ?? ""}:${read.line}`;
      issues.set(id, {
        id,
        severity: "warning",
        kind: "secret_scope_name_mismatch",
        title: `Secret scope "${read.scope}" may not exist. Did you mean "${byKey.name}"?`,
        taskId: task.id,
        taskName: task.displayName,
        fixHint: `The ${read.parameter} parameter gives "${read.scope}", the resource key of the bundle's secret scope named "${byKey.name}". Unless a scope called "${read.scope}" exists outside this bundle, set the parameter to "${byKey.name}".`,
        ...issueLocation(read.file, read.line, undefined),
      });
    }
  }
  return [...issues.values()];
}

const SELECTION_PIPELINE = /^\$\{resources\.pipelines\.([^.}]+)\.id\}$/;

/**
 * Warns where a pipeline task selects a table or flow its pipeline doesn't create (issue 539).
 * `bundle validate` and `bundle deploy` accept any name; the run fails with
 * INVALID_REFRESH_SELECTION, and letter case counts (live, CLI v1.27.0, 2026-11-24). Only
 * checked when the pipeline's data flow lists every name: all its sources are local SQL the
 * inspector read, and no name was left unread.
 */
function pipelineSelectionIssues(graph: BundleGraph): InspectorIssue[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const issues: InspectorIssue[] = [];
  const text = (value: unknown) => (typeof value === "string" && value && !value.includes("${") ? value : undefined);

  for (const task of graph.nodes) {
    if (task.nodeType !== "task" || !task.taskData) continue;
    const raw = task.data as Record<string, unknown>;
    const inner = (raw.for_each_task as { task?: Record<string, unknown> } | undefined)?.task;
    for (const [data, pipelineTask] of [
      [task.taskData, raw.pipeline_task],
      [task.taskData.nestedTask, inner?.pipeline_task],
    ] as const) {
      const selections = data?.pipelineSelections;
      const pipelineId = (pipelineTask as { pipeline_id?: unknown } | undefined)?.pipeline_id;
      const key = typeof pipelineId === "string" ? SELECTION_PIPELINE.exec(pipelineId.trim())?.[1] : undefined;
      if (!selections?.length || !key) continue;
      const pipeline = nodeById.get(`resources.pipelines.${key}`);
      const flow = pipeline?.pipelineDataFlow;
      const complete =
        flow &&
        flow.sqlFiles > 0 &&
        flow.notRead.length === 0 &&
        flow.unread.length === 0 &&
        !flow.incomplete &&
        (pipeline.pipelineLibraries ?? []).every((library) => library.checked && library.exists);
      if (!pipeline || !complete) continue;

      const datasets = flow.nodes.filter((node) => node.kind !== "outside" && node.kind !== "files").map((node) => node.name);
      // A table's own flow has its name; CREATE FLOW and AUTO CDC name theirs.
      const flows = [...new Set([...datasets, ...flow.edges.flatMap((edge) => (edge.flow ? [edge.flow] : []))])];
      const catalog = text(pipeline.data.catalog);
      const schema = text(pipeline.data.schema ?? pipeline.data.target);
      const full = (name: string): string[] | undefined => {
        const parts = splitName(name);
        if (parts.length === 3) return parts;
        if (parts.length === 2) return catalog ? [catalog, ...parts] : undefined;
        return catalog && schema ? [catalog, schema, ...parts] : undefined;
      };

      for (const selection of selections) {
        if (selection.name.includes("${") || selection.name.includes("{{")) continue;
        const candidates = selection.field === "refresh_flow_selection" ? flows : datasets;
        const parts = splitName(selection.name);
        // Compared as written, or as Unity Catalog stores it (lower case); a qualified name
        // needs the pipeline's catalog and schema to compare.
        const forms = (name: string) => {
          if (parts.length === 1) return [splitName(name).at(-1)!];
          const whole = full(name);
          return whole ? [whole.join(".")] : [];
        };
        // After a USE, a table may live in another schema than the pipeline's, which the
        // data flow doesn't keep: a full name can't be compared then.
        const afterUse = flow.nodes.some((node) => node.afterUse);
        const wanted = parts.length === 1 ? selection.name : afterUse ? undefined : full(selection.name)?.join(".");
        if (wanted === undefined) continue;
        const known = candidates.flatMap(forms);
        if (known.some((name) => name === wanted || name.toLowerCase() === wanted)) continue;
        if (known.length === 0) continue;
        const suggestion = closestName(wanted, known.map((name) => name.toLowerCase()));
        const what = selection.field === "refresh_flow_selection" ? "flow" : "table";
        issues.push({
          id: `pipeline-selection:${task.id}:${selection.yamlPath}`,
          severity: "warning",
          kind: "pipeline_selection_not_found",
          title: suggestion
            ? `Rename "${selection.name}" in ${selection.field}: pipeline "${key}" may not have this ${what}, so the run may fail. Did you mean "${suggestion}"?`
            : `Remove "${selection.name}" from ${selection.field}: pipeline "${key}" may not have this ${what}, so the run may fail.`,
          taskId: task.id,
          taskName: task.displayName,
          yamlPath: selection.yamlPath,
          fixHint:
            what === "flow"
              ? `Use the name of a flow pipeline "${key}" defines, written as in its SQL.`
              : `Use the name of a table or view pipeline "${key}" creates, written as in its SQL.`,
          ...issueLocation(task.taskData.sourceFile || undefined, selection.sourceLine || undefined, selection.sourceColumn),
        });
      }
    }
  }
  return issues;
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
      const reads: Array<{
        taskKey: string;
        key: string | null;
        hasDefault?: boolean;
        file?: string;
        line?: number;
        yamlPath?: string;
      }> = [];
      const readerRefs = reader.taskData
        ? [reader.taskData, ...(reader.taskData.nestedTask ? [reader.taskData.nestedTask] : [])].flatMap((d) => d.fileReferences)
        : [];
      for (const ref of readerRefs) {
        const usage = nodeById.get(`file:${ref.resolvedPath ?? ref.path}`)?.data.taskValueUsage as TaskValueUsage | undefined;
        for (const get of usage?.gets ?? []) {
          if (!get.taskKey) continue;
          reads.push({
            taskKey: get.taskKey,
            key: get.key,
            line: get.line,
            hasDefault: get.hasDefault,
            ...(ref.resolvedPath ? { file: ref.resolvedPath } : {}),
          });
        }
      }
      const settings = JSON.stringify(reader.data ?? {});
      for (const match of settings.matchAll(TASK_VALUE_REFERENCE)) {
        reads.push({ taskKey: match[1]!, key: match[2]!, yamlPath: `tasks.${readerKey}` });
      }

      const reported = new Set<string>();
      // Each key is reported once: check reads without a default first, so a later
      // read that can fail still gets its warning (#586).
      reads.sort((a, b) => Number(Boolean(a.hasDefault)) - Number(Boolean(b.hasDefault)));
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
            // "Upstream" is graph jargon; the surprise is that reading a value doesn't wait (#516).
            title: read.key
              ? `Add "${read.taskKey}" to this task's depends_on: reading its value "${read.key}" doesn't make this task wait, so the value may not be set yet.`
              : `Add "${read.taskKey}" to this task's depends_on: reading its values doesn't make this task wait, so they may not be set yet.`,
            fixHint: `Add "${read.taskKey}" to this task's depends_on, directly or through another dependency, so it runs first.`,
          });
          continue;
        }
        const keys = read.key ? keysSetBy(tasks.get(read.taskKey)!) : undefined;
        // A read with a default gets that default when the key isn't set, and the run goes on (#586).
        if (keys && read.key && !read.hasDefault && !keys.has(read.key)) {
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

