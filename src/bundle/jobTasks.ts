/**
 * A job's task boxes in the graph. Shared by the panel and the command-line tool (#348, #392).
 */

export interface JobTaskGraphNode {
  nodeType?: string | undefined;
  parentId?: string | undefined;
}

/** The task boxes whose parent is the given job, in graph order. */
export function getCurrentJobTaskNodes<N extends JobTaskGraphNode>(
  graph: { nodes: readonly N[] } | null | undefined,
  jobNode: { id: string } | null | undefined,
): N[] {
  if (!graph || !jobNode) return [];
  return graph.nodes.filter((node) => node.nodeType === "task" && node.parentId === jobNode.id);
}
