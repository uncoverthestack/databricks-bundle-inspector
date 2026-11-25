/**
 * The list under Issues for a job, or for the whole bundle when there is no job. Moved from
 * App.jsx with no change (#392).
 */
import { issueGroupName } from "../../bundle/issueLabels.js";
import type { ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { isVariableResolvedForTarget } from "../../bundle/targetResolution.js";
import { getCurrentJobTaskNodes, getFileStatus, type GraphLike, type TaskIssue } from "./taskIssues.js";

export interface ValidationIssue {
  message?: string;
  diagnostics?: Array<{ message?: string; path?: string; line?: number; severity?: string }>;
}

export interface IssueItem {
  id: string;
  group: string;
  title: string | undefined;
  subtitle: string | undefined;
  taskId?: string | undefined;
  severity: string | undefined;
  kind?: string;
  file?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  fixHint?: string | undefined;
}

export function buildIssueItems(
  graph: GraphLike,
  jobNode: { id: string } | null | undefined,
  parsedBundle: ParsedBundleConfig | null | undefined,
  targetName: string | null | undefined,
  validationIssues: readonly ValidationIssue[] | null | undefined,
  inspectorIssues: readonly TaskIssue[] = [],
): IssueItem[] {
  const jobTaskIds = new Set(getCurrentJobTaskNodes(graph, jobNode).map((task) => task.id));
  if (inspectorIssues.length > 0) {
    return (
      inspectorIssues
        // Same rule as issueBelongsToJob in src/bundle/issues.ts: the job's own tasks,
        // the job itself, or bundle-wide. Issues on another resource (e.g. a pipeline) are left out.
        // With no job (e.g. a pipeline-only bundle) this is the bundle-wide list, so keep everything.
        .filter((issue) =>
          !jobNode ? true : issue.taskId ? jobTaskIds.has(issue.taskId) : !issue.resourceId || issue.resourceId === jobNode.id,
        )
        .map((issue) => ({
          id: issue.id,
          group: issueGroupName(issue.kind),
          title: issue.detail ?? issue.title,
          // The note names its job in the title, so a second line would only repeat it.
          subtitle: issue.kind === "job_only_in_target" ? undefined : (issue.taskName ?? issue.title),
          taskId: issue.taskId,
          severity: issue.severity,
          kind: "file",
          file: issue.file,
          line: issue.line,
          column: issue.column,
          fixHint: issue.fixHint,
        }))
    );
  }

  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  const items: IssueItem[] = [];

  for (const task of tasks) {
    for (const ref of task.taskData?.fileReferences ?? []) {
      const status = getFileStatus(ref);
      if (status.key !== "missing") continue;
      items.push({
        id: `missing-file:${task.id}:${ref.yamlPath}:${ref.path}`,
        group: "Missing Files",
        title: ref.path,
        subtitle: task.displayName,
        taskId: task.id,
        severity: "error",
      });
    }

    for (const ref of task.taskData?.libraryReferences ?? []) {
      if (!ref.isLocal || ref.exists !== false) continue;
      items.push({
        id: `missing-library:${task.id}:${ref.yamlPath}:${ref.identifier}`,
        group: "Missing Libraries",
        title: ref.identifier,
        subtitle: task.displayName,
        taskId: task.id,
        severity: "error",
      });
    }

    for (const ref of task.taskData?.variableReferences ?? []) {
      if (isVariableResolvedForTarget(parsedBundle, ref.variableName, targetName)) continue;
      items.push({
        id: `unresolved-var:${task.id}:${ref.yamlPath}:${ref.variableName}`,
        group: "Unresolved Variables",
        title: ref.variableName,
        subtitle: task.displayName,
        taskId: task.id,
        severity: "error",
      });
    }
  }

  for (const [issueIndex, issue] of (validationIssues ?? []).entries()) {
    for (const [diagnosticIndex, diagnostic] of (issue.diagnostics ?? []).entries()) {
      items.push({
        id: `validation:${issueIndex}:${diagnosticIndex}`,
        group: "Validation Diagnostics",
        title: diagnostic.message ?? issue.message ?? "Validation diagnostic",
        subtitle: diagnostic.path ? `${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ""}` : issue.message,
        severity: diagnostic.severity ?? "warning",
      });
    }
  }

  return items;
}
