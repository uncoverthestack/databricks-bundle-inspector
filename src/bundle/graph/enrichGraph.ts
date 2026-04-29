import { detectSecretInNotebook, detectWidgetsInFile } from "../taskFileDetections.js";
import type { BundleGraph, BundleGraphNode } from "./bundleGraph.js";
import type { BundleEdge } from "./edges.js";

/**
 * Enriches a bundle graph with secret scope and widget nodes found by scanning
 * the contents of local files already in the graph.
 *
 * Reads each `file` node whose `location` is `"local"` and whose `data.exists`
 * is true, runs secret and widget detection, and adds the results as new nodes
 * connected back to the file node via `references` / `uses` edges.
 *
 * Safe to call in parallel — file reads that fail are silently skipped.
 */
export async function enrichGraphWithFileContent(graph: BundleGraph): Promise<BundleGraph> {
  const nodeMap = new Map<string, BundleGraphNode>(graph.nodes.map((n) => [n.id, n]));
  const edgeIds = new Set<string>(graph.edges.map((e) => e.id));
  const newNodes: BundleGraphNode[] = [];
  const newEdges: BundleEdge[] = [];

  function addNode(node: BundleGraphNode): void {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
      newNodes.push(node);
    }
  }

  function addEdge(edge: BundleEdge): void {
    if (!edgeIds.has(edge.id)) {
      edgeIds.add(edge.id);
      newEdges.push(edge);
    }
  }

  function secretScopeNodeId(scope: string): string {
    const resourceNode = [...nodeMap.values()].find(
      (node) =>
        node.nodeType === "secret_scope" &&
        node.resourceGroup === "secret_scopes" &&
        node.resourceKey === scope,
    );
    return resourceNode?.id ?? `secret:${scope}`;
  }

  const localFileNodes = graph.nodes.filter(
    (n) => n.nodeType === "file" && n.location === "local" && n.data.exists === true,
  );

  await Promise.all(
    localFileNodes.map(async (fileNode) => {
      const resolvedPath = fileNode.data.resolvedPath;
      if (typeof resolvedPath !== "string") return;
      const fileTypeHint =
        fileNode.data.referenceType === "sql"
          ? "sql"
          : undefined;

      const [secrets, widgets] = await Promise.all([
        detectSecretInNotebook(resolvedPath, fileTypeHint).catch(() => []),
        detectWidgetsInFile(resolvedPath, fileTypeHint).catch(() => []),
      ]);

      for (const detection of secrets) {
        if (!detection.scope) continue;
        const nodeId = secretScopeNodeId(detection.scope);
        addNode({
          id: nodeId,
          kind: "secret_scope",
          nodeType: "secret_scope",
          displayName: detection.scope,
          data: { scope: detection.scope, key: detection.key ?? undefined },
        });
        addEdge({
          id: `${fileNode.id}->references->${nodeId}`,
          source: fileNode.id,
          target: nodeId,
          kind: "references",
          data: { line: detection.line, key: detection.key ?? undefined },
        });
      }

      for (const detection of widgets) {
        if (!detection.name) continue;
        const nodeId = `widget:${detection.name}`;
        addNode({
          id: nodeId,
          kind: "widget",
          nodeType: "widget",
          displayName: detection.name,
          data: { name: detection.name, method: detection.method },
        });
        addEdge({
          id: `${fileNode.id}->uses->${nodeId}`,
          source: fileNode.id,
          target: nodeId,
          kind: "uses",
          data: { line: detection.line },
        });
      }
    }),
  );

  return {
    nodes: [...nodeMap.values()],
    edges: [...graph.edges, ...newEdges],
  };
}
