/**
 * What a task's details and boxes say about its files and problems: a file's status chip,
 * a task's problem list and counts, and small helpers over a job's tasks. Moved from
 * App.jsx with no change (#392).
 */
import { fileStatusKey, type FileStatusKey } from "../../bundle/fileStatus.js";
import { issueKindLabel } from "../../bundle/issueLabels.js";
import type { ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { isVariableResolvedForTarget } from "../../bundle/targetResolution.js";
import { UI_COLOR } from "./vscodeTheme.js";

type Bundle = ParsedBundleConfig | null | undefined;
type Target = string | null | undefined;

export interface FileReference {
  path?: string;
  resolvedPath?: string;
  exists?: boolean;
  yamlPath?: string;
  referenceType?: string;
  sourceLine?: number;
  sourceColumn?: number;
}

export interface LibraryReference {
  isLocal?: boolean;
  exists?: boolean;
  yamlPath?: string;
  identifier?: string;
  sourceLine?: number;
  sourceColumn?: number;
}

export interface VariableReference {
  variableName: string;
  expression?: string;
  yamlPath?: string;
  sourceLine?: number;
  sourceColumn?: number;
}

export interface TaskData {
  fileReferences?: FileReference[];
  variableReferences?: VariableReference[];
  libraryReferences?: LibraryReference[];
  nestedTask?: TaskData;
  sourceFile?: string;
  taskType?: string;
}

export interface TaskNode {
  id: string;
  nodeType?: string;
  displayName: string;
  parentId?: string;
  kind?: string;
  subtitle?: string;
  taskTypeLabel?: string;
  taskData?: TaskData;
}

export interface GraphLike {
  nodes: Array<TaskNode & { [key: string]: unknown }>;
  edges: Array<{ id?: string; source: string; target: string; kind: string; data?: Record<string, unknown> }>;
}

export interface TaskIssue {
  id: string;
  kind?: string;
  severity?: string;
  title?: string;
  detail?: string;
  fixHint?: string;
  taskId?: string;
  taskName?: string;
  resourceId?: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface FileStatus {
  key: FileStatusKey;
  label: string;
  color: string;
  title?: string;
}

/** The last part of a path. */
export function basename(value: unknown): string {
  if (!value || typeof value !== "string") return "";
  return value.split("/").filter(Boolean).pop() ?? value;
}

/** A file's status chip: its words and colour. */
export function getFileStatus(ref: FileReference): FileStatus {
  switch (fileStatusKey(ref)) {
    case "template":
      return {
        key: "template",
        label: "TEMPLATE",
        color: UI_COLOR.warning,
        title: "Not checked: this path uses a variable, so the file is only known once a target is resolved. Pick a target to check it.",
      };
    case "remote":
      return { key: "remote", label: "REMOTE", color: UI_COLOR.link };
    case "missing":
      return { key: "missing", label: "MISSING", color: UI_COLOR.error };
    case "found":
      return { key: "found", label: "FOUND", color: UI_COLOR.ok };
    default:
      return { key: "unknown", label: "UNKNOWN", color: UI_COLOR.muted };
  }
}

export function getDefinedVariableNames(parsedBundle: Bundle): Set<string> {
  return new Set(Object.keys(parsedBundle?.variables ?? {}));
}

/**
 * A task's own recount of missing files, missing local libraries and unresolved variables,
 * for when there is no problem list from the inspector (an old or partial result).
 */
export function getTaskIssueCounts(taskNode: TaskNode, parsedBundle: Bundle, targetName: Target) {
  // Include a for_each task's inner task, as buildInspectorIssues does.
  const checked = [taskNode.taskData, taskNode.taskData?.nestedTask].filter((data): data is TaskData => Boolean(data));
  const fileReferences = checked.flatMap((data) => data.fileReferences ?? []);
  const variableReferences = checked.flatMap((data) => data.variableReferences ?? []);
  const libraryReferences = checked.flatMap((data) => data.libraryReferences ?? []);

  const missingFiles = fileReferences.filter((ref) => getFileStatus(ref).key === "missing").length;
  const missingLibraries = libraryReferences.filter((ref) => ref.isLocal && ref.exists === false).length;
  const unresolvedVariables = new Set(
    variableReferences
      .map((ref) => ref.variableName)
      .filter((name) => !isVariableResolvedForTarget(parsedBundle, name, targetName)),
  ).size;

  return {
    missingFiles,
    missingLibraries,
    unresolvedVariables,
    total: missingFiles + missingLibraries + unresolvedVariables,
  };
}

/** `file.yml:12`, or just the file name when there is no line. */
export function formatSourceLocation(file: string | undefined, line: number | undefined): string | null {
  if (!file) return null;
  const fileLabel = basename(file) || file;
  return typeof line === "number" && line > 0 ? `${fileLabel}:${line}` : fileLabel;
}

const FILE_REFERENCE_LABELS: Record<string, string> = {
  notebook: "Missing notebook file",
  sql: "Missing SQL file",
  python_script: "Missing Python file",
  dbt_project: "Missing dbt project",
  directory: "Missing directory",
  python_wheel: "Missing wheel",
  jar: "Missing JAR",
};

export function fileReferenceIssueLabel(ref: FileReference | undefined): string {
  const type = ref?.referenceType;
  return (type !== undefined && Object.hasOwn(FILE_REFERENCE_LABELS, type) ? FILE_REFERENCE_LABELS[type] : undefined) ?? "Missing file";
}

export interface TaskIssueSummary {
  id: string;
  title: string | undefined;
  detail: string | undefined;
  fixHint?: string | undefined;
  file: string | undefined;
  line: number | undefined;
  column: number | undefined;
  location: string | null;
  severity: string | undefined;
}

/**
 * A task's problems for its details panel: the inspector's list when it has any for the
 * task, else the task's own recount of missing files, libraries and variables.
 */
export function summarizeTaskIssues(
  taskNode: TaskNode,
  parsedBundle: Bundle,
  targetName: Target,
  inspectorIssues: readonly TaskIssue[] = [],
): TaskIssueSummary[] {
  const taskInspectorIssues = inspectorIssues.filter((issue) => issue.taskId === taskNode.id);
  if (taskInspectorIssues.length > 0) {
    return taskInspectorIssues.map((issue) => ({
      id: issue.id,
      title: issue.detail ?? issue.title ?? issueKindLabel(issue.kind),
      detail: issue.detail && issue.title && issue.detail !== issue.title ? issue.title : undefined,
      fixHint: issue.fixHint,
      file: issue.file,
      line: issue.line,
      column: issue.column,
      location: formatSourceLocation(issue.file, issue.line),
      severity: issue.severity,
    }));
  }

  const sourceFile = taskNode.taskData?.sourceFile;
  const items: TaskIssueSummary[] = [];
  for (const ref of taskNode.taskData?.fileReferences ?? []) {
    const status = getFileStatus(ref);
    if (status.key !== "missing") continue;
    items.push({
      id: `missing-file:${ref.yamlPath}:${ref.path}`,
      title: fileReferenceIssueLabel(ref),
      detail: ref.path,
      file: sourceFile,
      line: ref.sourceLine,
      column: ref.sourceColumn,
      location: formatSourceLocation(sourceFile, ref.sourceLine),
      severity: "error",
    });
  }

  for (const ref of taskNode.taskData?.libraryReferences ?? []) {
    if (!ref.isLocal || ref.exists !== false) continue;
    items.push({
      id: `missing-library:${ref.yamlPath}:${ref.identifier}`,
      title: "Missing local library",
      detail: ref.identifier,
      file: sourceFile,
      line: ref.sourceLine,
      column: ref.sourceColumn,
      location: formatSourceLocation(sourceFile, ref.sourceLine),
      severity: "error",
    });
  }

  const unresolvedVariables = new Map<string, VariableReference>();
  for (const ref of taskNode.taskData?.variableReferences ?? []) {
    if (isVariableResolvedForTarget(parsedBundle, ref.variableName, targetName)) continue;
    if (unresolvedVariables.has(ref.variableName)) continue;
    unresolvedVariables.set(ref.variableName, ref);
    items.push({
      id: `unresolved-var:${ref.yamlPath}:${ref.variableName}`,
      title: `Unresolved variable ${ref.variableName}`,
      detail: ref.expression,
      file: sourceFile,
      line: ref.sourceLine,
      column: ref.sourceColumn,
      location: formatSourceLocation(sourceFile, ref.sourceLine),
      severity: "error",
    });
  }

  return items;
}

/** The breadcrumb for a task: its job's name, then its own. */
export function getTaskPath(taskNode: TaskNode, parentJob: { displayName?: string } | null | undefined): string[] {
  return [parentJob?.displayName, taskNode.displayName].filter((name): name is string => Boolean(name));
}

/** The job's tasks, in graph order. */
export function getCurrentJobTaskNodes(graph: GraphLike | null | undefined, jobNode: { id: string } | null | undefined): TaskNode[] {
  if (!graph || !jobNode) return [];
  return graph.nodes.filter((node) => node.nodeType === "task" && node.parentId === jobNode.id);
}

/** Each task's upstream and downstream tasks, from `depends_on` edges between the given tasks. */
export function buildTaskAdjacency(edges: GraphLike["edges"], taskIds: Set<string>) {
  const upstream = new Map<string, Set<string>>();
  const downstream = new Map<string, Set<string>>();
  for (const id of taskIds) {
    upstream.set(id, new Set());
    downstream.set(id, new Set());
  }
  for (const edge of edges) {
    if (edge.kind !== "depends_on") continue;
    if (!taskIds.has(edge.source) || !taskIds.has(edge.target)) continue;
    upstream.get(edge.target)?.add(edge.source);
    downstream.get(edge.source)?.add(edge.target);
  }
  return { upstream, downstream };
}

/** Every task reachable from `startId`, not counting itself unless a loop leads back to it. */
export function collectReachable(startId: string, adjacency: Map<string, Set<string>>): Set<string> {
  const result = new Set<string>();
  const stack = [...(adjacency.get(startId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || result.has(id)) continue;
    result.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  return result;
}
