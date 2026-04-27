import type { BundleGraph, BundleGraphNode, BundleNodeType } from "./bundleGraph.js";
import type { BundleEdge, EdgeKind } from "./edges.js";

/** All edges leaving `nodeId`. */
export function getEdgesFrom(graph: BundleGraph, nodeId: string): BundleEdge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

/** All edges arriving at `nodeId`. */
export function getEdgesTo(graph: BundleGraph, nodeId: string): BundleEdge[] {
  return graph.edges.filter((e) => e.target === nodeId);
}

/** Direct neighbours of `nodeId` in one direction, optionally filtered by edge kind. */
export function getNeighbors(
  graph: BundleGraph,
  nodeId: string,
  direction: "out" | "in" | "both",
  edgeKinds?: EdgeKind[],
): BundleGraphNode[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const outgoing = direction !== "in" ? getEdgesFrom(graph, nodeId) : [];
  const incoming = direction !== "out" ? getEdgesTo(graph, nodeId) : [];
  const relevant = [...outgoing, ...incoming].filter(
    (e) => !edgeKinds || edgeKinds.includes(e.kind),
  );

  const neighbourIds = new Set(
    relevant.map((e) => (e.source === nodeId ? e.target : e.source)),
  );

  return [...neighbourIds].flatMap((id) => {
    const node = nodeById.get(id);
    return node ? [node] : [];
  });
}

/**
 * Everything `nodeId` transitively depends on — follows edges outward.
 * Returns nodes reachable via `references`, `uses`, `contains`, `depends_on`.
 */
export function getTransitiveDependencies(
  graph: BundleGraph,
  nodeId: string,
  edgeKinds: EdgeKind[] = ["references", "uses", "contains", "depends_on"],
): BundleGraphNode[] {
  return bfs(graph, nodeId, "out", edgeKinds);
}

/**
 * Everything that transitively depends on `nodeId` — follows edges inward.
 * Answers: "if this file/variable/resource changes, what is affected?"
 */
export function getTransitiveDependents(
  graph: BundleGraph,
  nodeId: string,
  edgeKinds: EdgeKind[] = ["references", "uses", "contains", "depends_on"],
): BundleGraphNode[] {
  return bfs(graph, nodeId, "in", edgeKinds);
}

/**
 * Nodes of the given kinds that have no incoming `references` or `uses` edges.
 * Answers: "what is defined in the bundle but never used?"
 */
export function findUnreferenced(
  graph: BundleGraph,
  nodeTypes: BundleNodeType[],
): BundleGraphNode[] {
  const referencedIds = new Set(
    graph.edges
      .filter((e) => e.kind === "references" || e.kind === "uses")
      .map((e) => e.target),
  );

  return graph.nodes.filter(
    (n) => nodeTypes.includes(n.nodeType) && !referencedIds.has(n.id),
  );
}

/**
 * All files, variables, and libraries a node directly uses or references —
 * one hop, no recursion. Useful for a "what does this task need?" panel.
 */
export function getDirectDependencies(
  graph: BundleGraph,
  nodeId: string,
): { files: BundleGraphNode[]; variables: BundleGraphNode[]; libraries: BundleGraphNode[] } {
  const outEdges = getEdgesFrom(graph, nodeId).filter(
    (e) => e.kind === "references" || e.kind === "uses",
  );
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const files: BundleGraphNode[] = [];
  const variables: BundleGraphNode[] = [];
  const libraries: BundleGraphNode[] = [];

  for (const edge of outEdges) {
    const target = nodeById.get(edge.target);
    if (!target) continue;
    if (target.nodeType === "file") files.push(target);
    else if (target.nodeType === "variable") variables.push(target);
    else if (target.nodeType === "library") libraries.push(target);
  }

  return { files, variables, libraries };
}

// --- internal ---

function bfs(
  graph: BundleGraph,
  startId: string,
  direction: "out" | "in",
  edgeKinds: EdgeKind[],
): BundleGraphNode[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([startId]);
  const queue = [startId];
  const result: BundleGraphNode[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const edges =
      direction === "out" ? getEdgesFrom(graph, current) : getEdgesTo(graph, current);

    for (const edge of edges) {
      if (!edgeKinds.includes(edge.kind)) continue;
      const nextId = direction === "out" ? edge.target : edge.source;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      queue.push(nextId);
      const node = nodeById.get(nextId);
      if (node) result.push(node);
    }
  }

  return result;
}
