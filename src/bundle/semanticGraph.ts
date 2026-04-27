import { decideDocumentationGeneration } from "./documentationPolicy.js";
import type { BundleGraph, BundleGraphNode, ParsedBundleConfig } from "./graph/bundleGraph.js";
import type { InspectorIssue } from "./issues.js";

export type SemanticFileStatus =
  | "found"
  | "missing"
  | "remote"
  | "template"
  | "unknown";

export interface SemanticFileReference {
  path: string;
  status: SemanticFileStatus;
}

export interface SemanticTask {
  key: string;
  type: string;
  source?: string;
  dependsOn: string[];
  dependents: string[];
  compute: string[];
  files: SemanticFileReference[];
  variables: string[];
  libraries: string[];
}

export interface SemanticJobDocumentationState {
  canGenerate: boolean;
  decision: "allow" | "warn" | "block";
  blockingIssueCount: number;
  warningIssueCount: number;
}

export interface SemanticJob {
  key: string;
  name: string;
  trigger?: string;
  runAs?: string;
  tasks: SemanticTask[];
  edges: Array<[string, string]>;
  documentation: SemanticJobDocumentationState;
}

export interface SemanticIssue {
  severity: InspectorIssue["severity"];
  kind: InspectorIssue["kind"];
  title: string;
  detail?: string;
  taskKey?: string;
}

export interface SemanticDetectedReferences {
  secretScopes: string[];
  widgets: string[];
}

export interface SemanticBundleGraph {
  bundle: string;
  jobs: SemanticJob[];
  issues: SemanticIssue[];
  detectedReferences: SemanticDetectedReferences;
}

function sortStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function taskKeyFromId(taskId: string): string {
  return taskId.split(".tasks.").at(-1) ?? taskId;
}

function isRemotePath(value: string): boolean {
  return (
    value.startsWith("/Workspace/") ||
    value.startsWith("dbfs:/") ||
    value.startsWith("s3://") ||
    value.startsWith("abfss://") ||
    value.startsWith("gs://")
  );
}

function hasTemplateExpression(value: string): boolean {
  return value.includes("${") || value.includes("{{");
}

function fileStatus(ref: {
  path: string;
  resolvedPath: string | undefined;
  exists: boolean | undefined;
}): SemanticFileStatus {
  if (hasTemplateExpression(ref.path)) return "template";
  if (isRemotePath(ref.path)) return "remote";
  if (ref.resolvedPath && ref.exists === false) return "missing";
  if (ref.exists === true) return "found";
  return "unknown";
}

function jobNodes(graph: BundleGraph): BundleGraphNode[] {
  return graph.nodes
    .filter((node) => node.nodeType === "job")
    .sort((a, b) => (a.resourceKey ?? a.id).localeCompare(b.resourceKey ?? b.id));
}

function taskNodesForJob(
  graph: BundleGraph,
  job: BundleGraphNode,
): BundleGraphNode[] {
  return graph.edges
    .filter((edge) => edge.kind === "contains" && edge.source === job.id)
    .map((edge) => graph.nodes.find((node) => node.id === edge.target))
    .filter((node): node is BundleGraphNode => node?.nodeType === "task")
    .sort((a, b) => (a.taskKey ?? a.id).localeCompare(b.taskKey ?? b.id));
}

function dependencyMaps(
  graph: BundleGraph,
  tasks: BundleGraphNode[],
): {
  dependsOn: Map<string, string[]>;
  dependents: Map<string, string[]>;
  edges: Array<[string, string]>;
} {
  const taskIds = new Set(tasks.map((task) => task.id));
  const dependsOn = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const edges: Array<[string, string]> = [];

  for (const task of tasks) {
    dependsOn.set(task.id, []);
    dependents.set(task.id, []);
  }

  for (const edge of graph.edges) {
    if (
      edge.kind !== "depends_on" ||
      !taskIds.has(edge.source) ||
      !taskIds.has(edge.target)
    ) {
      continue;
    }
    const source = taskKeyFromId(edge.source);
    const target = taskKeyFromId(edge.target);
    dependsOn.get(edge.target)?.push(source);
    dependents.get(edge.source)?.push(target);
    edges.push([source, target]);
  }

  return {
    dependsOn,
    dependents,
    edges: edges.sort(([aSource, aTarget], [bSource, bTarget]) =>
      `${aSource}->${aTarget}`.localeCompare(`${bSource}->${bTarget}`),
    ),
  };
}

function semanticTask(
  task: BundleGraphNode,
  dependsOn: string[],
  dependents: string[],
): SemanticTask {
  const files =
    task.taskData?.fileReferences
      .map((ref) => ({
        path: ref.path,
        status: fileStatus(ref),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)) ?? [];

  const source = files[0]?.path ?? task.subtitle;

  return {
    key: task.taskKey ?? task.displayName,
    type: task.taskTypeLabel ?? task.kind,
    ...(source ? { source } : {}),
    dependsOn: sortStrings(dependsOn),
    dependents: sortStrings(dependents),
    compute: sortStrings((task.compute ?? []).map((item) => item.label)),
    files,
    variables: sortStrings(
      (task.taskData?.variableReferences ?? []).map((ref) => ref.variableName),
    ),
    libraries: sortStrings(
      (task.taskData?.libraryReferences ?? []).map((ref) => ref.identifier),
    ),
  };
}

function semanticIssue(issue: InspectorIssue): SemanticIssue {
  return {
    severity: issue.severity,
    kind: issue.kind,
    title: issue.title,
    ...(issue.detail ? { detail: issue.detail } : {}),
    ...(issue.taskId ? { taskKey: taskKeyFromId(issue.taskId) } : {}),
  };
}

function jobIssues(
  issues: InspectorIssue[],
  tasks: BundleGraphNode[],
): InspectorIssue[] {
  const taskIds = new Set(tasks.map((task) => task.id));
  return issues.filter((issue) => !issue.taskId || taskIds.has(issue.taskId));
}

function semanticDocumentationState(
  issues: InspectorIssue[],
): SemanticJobDocumentationState {
  const decision = decideDocumentationGeneration(issues);
  return {
    canGenerate: decision.action !== "block",
    decision: decision.action,
    blockingIssueCount: decision.blockingIssues.length,
    warningIssueCount: decision.warningIssues.length,
  };
}

function detectedReferences(graph: BundleGraph): SemanticDetectedReferences {
  return {
    secretScopes: sortStrings(
      graph.nodes
        .filter((node) => node.nodeType === "secret_scope")
        .map((node) => node.displayName),
    ),
    widgets: sortStrings(
      graph.nodes
        .filter((node) => node.nodeType === "widget")
        .map((node) => node.displayName),
    ),
  };
}

export function exportSemanticGraph(
  parsedBundle: ParsedBundleConfig,
  graph: BundleGraph,
  issues: InspectorIssue[],
): SemanticBundleGraph {
  const jobs = jobNodes(graph).map((job): SemanticJob => {
    const tasks = taskNodesForJob(graph, job);
    const dependencies = dependencyMaps(graph, tasks);
    const scopedIssues = jobIssues(issues, tasks);

    return {
      key: job.resourceKey ?? job.displayName,
      name: job.displayName,
      ...(job.trigger ? { trigger: job.trigger } : {}),
      ...(job.runAs ? { runAs: job.runAs } : {}),
      tasks: tasks.map((task) =>
        semanticTask(
          task,
          dependencies.dependsOn.get(task.id) ?? [],
          dependencies.dependents.get(task.id) ?? [],
        ),
      ),
      edges: dependencies.edges,
      documentation: semanticDocumentationState(scopedIssues),
    };
  });

  return {
    bundle: parsedBundle.bundle.name,
    jobs,
    issues: issues
      .map(semanticIssue)
      .sort((a, b) =>
        `${a.severity}:${a.kind}:${a.taskKey ?? ""}:${a.detail ?? a.title}`.localeCompare(
          `${b.severity}:${b.kind}:${b.taskKey ?? ""}:${b.detail ?? b.title}`,
        ),
      ),
    detectedReferences: detectedReferences(graph),
  };
}
