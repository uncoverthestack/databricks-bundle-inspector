import type { BundleGraph, BundleGraphNode } from "./bundleGraph.js";

/**
 * The target's graph with each task's variable references taken from the structural
 * preview (#230). With a target, the CLI replaces every `${var...}` by its value before the
 * inspector reads the bundle, so the target's graph finds no references, and the task
 * panel's and header's Variables lists come out empty. The preview keeps them. Tasks are
 * matched by id (job and task keys, the same in both); a task only one of them has keeps
 * what it had. The variable nodes and "uses" edges the references make come along. The
 * graph passed in is not changed.
 */
export function withPreviewVariableReferences(target: BundleGraph, preview: BundleGraph): BundleGraph {
  const previewTasks = new Map(preview.nodes.filter((node) => node.taskData).map((node) => [node.id, node]));
  const nodes = target.nodes.map((node): BundleGraphNode => {
    const from = previewTasks.get(node.id)?.taskData;
    if (!node.taskData || !from) return node;
    return {
      ...node,
      taskData: {
        ...node.taskData,
        variableReferences: from.variableReferences,
        ...(node.taskData.nestedTask && from.nestedTask
          ? { nestedTask: { ...node.taskData.nestedTask, variableReferences: from.nestedTask.variableReferences } }
          : {}),
      },
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(target.edges.map((edge) => edge.id));
  const extraNodes: BundleGraphNode[] = [];
  const extraEdges = preview.edges.filter((edge) => {
    if (edge.kind !== "uses" || !edge.target.startsWith("var:") || !nodeIds.has(edge.source) || edgeIds.has(edge.id)) {
      return false;
    }
    const variable = preview.nodes.find((node) => node.id === edge.target);
    if (variable && !nodeIds.has(variable.id)) {
      extraNodes.push(variable);
      nodeIds.add(variable.id);
    }
    return true;
  });
  return { ...target, nodes: [...nodes, ...extraNodes], edges: [...target.edges, ...extraEdges] };
}
