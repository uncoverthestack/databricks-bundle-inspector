import path from "node:path";
import type { BundleDiagnostic } from "./parseBundleDiagnostics.js";
import type { ParsedBundleConfig } from "./graph/bundleGraph.js";
import type { BundleGraph, BundleGraphNode } from "./graph/bundleGraph.js";
import type { ValidationIssue } from "./validateBundle.js";
import { isVariableResolvedForTarget } from "./targetResolution.js";

export type InspectorIssueSeverity = "error" | "warning" | "info";

export type InspectorIssueKind =
  | "missing_file"
  | "missing_library"
  | "unresolved_variable"
  | "validation_diagnostic"
  | "unknown_or_deprecated_field"
  | "unknown_task_type"
  | "git_source_not_recommended";

export interface InspectorIssue {
  id: string;
  severity: InspectorIssueSeverity;
  kind: InspectorIssueKind;
  title: string;
  detail?: string;
  taskId?: string;
  taskName?: string;
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

  for (const task of tasks) {
    const taskData = task.taskData;
    if (!taskData) continue;

    if (taskData.taskType === "unknown") {
      issues.push({
        id: `unknown-task:${task.id}`,
        severity: "warning",
        kind: "unknown_task_type",
        title: "Unknown or deprecated task type",
        detail: task.displayName,
        taskId: task.id,
        taskName: task.displayName,
        yamlPath: `tasks.${taskData.taskKey}`,
        fixHint: "Check whether this task type is supported by the inspector.",
        ...issueLocation(sourceFileForTask(task)),
      });
    }

    for (const ref of taskData.fileReferences) {
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

    for (const ref of taskData.libraryReferences) {
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

    for (const ref of taskData.variableReferences) {
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

  for (const [issueIndex, issue] of validationIssues.entries()) {
    if (issue.code === "AUTH_NOT_CONFIGURED") continue;
    for (const [diagnosticIndex, diagnostic] of (
      issue.diagnostics ?? []
    ).entries()) {
      const normalized = validationDiagnosticIssue(issue, diagnostic);
      issues.push({
        id: `validation:${issueIndex}:${diagnosticIndex}`,
        severity: diagnostic.severity ?? "warning",
        ...normalized,
        ...issueLocation(
          validationFile(bundleRoot, diagnostic),
          diagnostic.line,
          diagnostic.column,
        ),
      });
    }
  }

  return issues;
}
