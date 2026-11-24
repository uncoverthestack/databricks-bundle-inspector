/**
 * Parameter flows: how a job or task parameter reaches the notebook widget or SQL parameter that
 * reads it, from the graph alone. Shared by the panel and the command-line tool (#348, #392).
 */

import { getCurrentJobTaskNodes } from "./jobTasks.js";

export interface FlowTaskParameterReference {
  name: string;
  value?: string | undefined;
  jobParameterDefault?: string | undefined;
  isOverriddenByJob?: boolean | undefined;
  jobParameterName?: string | undefined;
  ignoredByJob?: boolean | undefined;
  effectiveValue?: string | undefined;
  confidence?: string | undefined;
  sourceLine?: number | undefined;
  sourceColumn?: number | undefined;
}

export interface FlowJobParameterReference {
  name: string;
  default?: string | undefined;
  sourceLine?: number | undefined;
  sourceColumn?: number | undefined;
}

export interface FlowTaskData {
  sourceFile?: string | undefined;
  fileReferences?: Array<{ referenceType?: string | undefined }> | undefined;
  taskParameterReferences?: FlowTaskParameterReference[] | undefined;
  jobParameterReferences?: FlowJobParameterReference[] | undefined;
}

export interface FlowGraphNode {
  id: string;
  nodeType?: string | undefined;
  displayName: string;
  parentId?: string | undefined;
  data?: { resolvedPath?: string | null | undefined; [key: string]: unknown } | undefined;
  taskData?: FlowTaskData | undefined;
}

export interface FlowGraphEdge {
  source: string;
  target: string;
  kind: string;
  data?: { line?: number | null | undefined; [key: string]: unknown } | undefined;
}

export interface FlowGraph {
  nodes: readonly FlowGraphNode[];
  edges: readonly FlowGraphEdge[];
}

/** Where a parameter's value is set: on the task, on the job, or on the job over the task's value. */
export interface ParameterLinkage {
  kind: "task" | "job_override" | "job";
  /** A job parameter with the same name wins, so the task's own value is never used (issue 537). */
  ignoredByJob?: boolean | undefined;
  taskValue?: string | undefined;
  jobParameterDefault?: string | undefined;
  effectiveValue?: string | undefined;
  confidence?: string | undefined;
  sourceLine?: number | undefined;
  sourceColumn?: number | undefined;
  jobSourceLine?: number | undefined;
  jobSourceColumn?: number | undefined;
}

export type ParameterFlowLabel = "JOB" | "TASK" | "SQL" | "NOTEBOOK" | "FILE";

export interface ParameterFlowSegment {
  label: ParameterFlowLabel;
  name: string;
  file: string | null | undefined;
  line: number | null | undefined;
  column: number | null | undefined;
}

export interface ParameterFlow {
  id: string;
  name: string;
  taskName: string;
  segments: ParameterFlowSegment[];
}

export function buildParameterLinkageMaps(node: Pick<FlowGraphNode, "taskData">) {
  const taskParams = new Map(
    (node.taskData?.taskParameterReferences ?? []).map((ref) => [ref.name, ref]),
  );
  const jobParams = new Map(
    (node.taskData?.jobParameterReferences ?? []).map((ref) => [ref.name, ref]),
  );
  return { taskParams, jobParams };
}

export function parameterLinkageForName(
  name: string,
  taskParams: ReadonlyMap<string, FlowTaskParameterReference>,
  jobParams: ReadonlyMap<string, FlowJobParameterReference>,
): ParameterLinkage | null {
  const taskParam = taskParams.get(name);
  if (taskParam) {
    // The job parameter the value comes from: the same name, or the one the value names.
    const jobParam = jobParams.get(taskParam.jobParameterName ?? name);
    return {
      kind: taskParam.isOverriddenByJob ? "job_override" : "task",
      ...(taskParam.ignoredByJob ? { ignoredByJob: true } : {}),
      taskValue: taskParam.value,
      jobParameterDefault: taskParam.jobParameterDefault,
      effectiveValue: taskParam.effectiveValue,
      confidence: taskParam.confidence,
      sourceLine: taskParam.sourceLine,
      sourceColumn: taskParam.sourceColumn,
      jobSourceLine: jobParam?.sourceLine,
      jobSourceColumn: jobParam?.sourceColumn,
    };
  }
  const jobParam = jobParams.get(name);
  if (jobParam) {
    return {
      kind: "job",
      jobParameterDefault: jobParam.default,
      effectiveValue: jobParam.default,
      sourceLine: jobParam.sourceLine,
      sourceColumn: jobParam.sourceColumn,
    };
  }
  return null;
}

/** The file box the task's `references` edge points at: its notebook, script or SQL file. */
export function getPrimaryFileNode(
  graph: FlowGraph,
  nodeById: ReadonlyMap<string, FlowGraphNode>,
  taskId: string,
): FlowGraphNode | undefined {
  return graph.edges
    .filter((edge) => edge.source === taskId && edge.kind === "references")
    .map((edge) => nodeById.get(edge.target))
    .find((node) => node?.nodeType === "file");
}

function parameterFlowTargetLabel(fileReferenceType: string | undefined): ParameterFlowLabel {
  if (fileReferenceType === "sql") return "SQL";
  if (fileReferenceType === "notebook" || fileReferenceType === "python_script") {
    return "NOTEBOOK";
  }
  return "FILE";
}

function makeParameterFlowSegment(
  label: ParameterFlowLabel,
  name: string,
  file: string | null | undefined,
  line: number | null | undefined,
  column: number | null | undefined,
): ParameterFlowSegment {
  return { label, name, file, line, column };
}

/** Each widget or SQL parameter of the task's file that a job or task parameter sets. */
export function buildParameterFlowsForTask(
  graph: FlowGraph,
  nodeById: ReadonlyMap<string, FlowGraphNode>,
  taskNode: FlowGraphNode,
): ParameterFlow[] {
  const sourceFile = taskNode.taskData?.sourceFile;
  const primaryFileNode = getPrimaryFileNode(graph, nodeById, taskNode.id);
  if (!primaryFileNode) return [];

  const primaryFileRef = (taskNode.taskData?.fileReferences ?? [])[0];
  const { taskParams, jobParams } = buildParameterLinkageMaps(taskNode);
  const flows: ParameterFlow[] = [];

  for (const edge of graph.edges) {
    if (edge.source !== primaryFileNode.id || edge.kind !== "uses") continue;
    const widgetNode = nodeById.get(edge.target);
    if (!widgetNode || widgetNode.nodeType !== "widget") continue;

    const name = widgetNode.displayName;
    const linkage = parameterLinkageForName(name, taskParams, jobParams);
    if (!linkage) continue;

    const segments: ParameterFlowSegment[] = [];
    if (linkage.kind === "job_override" && linkage.ignoredByJob) {
      // The task's own value is never used: the job parameter goes straight to the file.
      segments.push(makeParameterFlowSegment("JOB", name, sourceFile, linkage.jobSourceLine, linkage.jobSourceColumn));
    } else if (linkage.kind === "job_override") {
      segments.push(makeParameterFlowSegment("JOB", name, sourceFile, linkage.jobSourceLine, linkage.jobSourceColumn));
      segments.push(makeParameterFlowSegment("TASK", name, sourceFile, linkage.sourceLine, linkage.sourceColumn));
    } else if (linkage.kind === "job") {
      segments.push(makeParameterFlowSegment("JOB", name, sourceFile, linkage.sourceLine, linkage.sourceColumn));
    } else if (linkage.kind === "task") {
      segments.push(makeParameterFlowSegment("TASK", name, sourceFile, linkage.sourceLine, linkage.sourceColumn));
    }

    segments.push(
      makeParameterFlowSegment(
        parameterFlowTargetLabel(primaryFileRef?.referenceType),
        name,
        primaryFileNode.data?.resolvedPath ?? null,
        edge.data?.line ?? null,
        null,
      ),
    );

    if (segments.length >= 2) {
      flows.push({
        id: `${taskNode.id}:${name}:${segments.map((segment) => segment.label).join(">")}`,
        name,
        taskName: taskNode.displayName,
        segments,
      });
    }
  }

  const seen = new Set<string>();
  return flows.filter((flow) => {
    const key = `${flow.name}:${flow.segments
      .map((segment) => `${segment.label}:${segment.line ?? ""}`)
      .join(">")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The parameter flows of every task in the job. */
export function buildParameterFlowsForJob(
  graph: FlowGraph | null | undefined,
  jobNode: FlowGraphNode | null | undefined,
): ParameterFlow[] {
  if (!graph || !jobNode) return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return getCurrentJobTaskNodes(graph, jobNode).flatMap((taskNode) =>
    buildParameterFlowsForTask(graph, nodeById, taskNode),
  );
}

/** A segment's words in the Copy review summary. */
export function parameterFlowMarkdownLabel(segment: Pick<ParameterFlowSegment, "label">): string {
  if (segment.label === "JOB") return "job parameter";
  if (segment.label === "TASK") return "task parameter";
  if (segment.label === "NOTEBOOK") return "notebook widget";
  if (segment.label === "SQL") return "SQL parameter";
  return "file usage";
}
