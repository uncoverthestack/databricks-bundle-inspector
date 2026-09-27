import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  detectSecretInNotebook,
  detectTaskValuesInFile,
  detectWidgetUsageInFile,
  detectWidgetsInFile,
} from "../taskFileDetections.js";
import { matchSecretScope } from "../resources/secretScope.js";
import { bundleSecretScopes, type BundleGraph, type BundleGraphNode } from "./bundleGraph.js";
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

  const bundleScopes = bundleSecretScopes(graph.nodes);

  /** Adds (or reuses) the node for the scope a secret call names, matched on the scope's real name. */
  function secretScopeNode(scope: string): string {
    const match = matchSecretScope(scope, bundleScopes);
    addNode({
      id: match.nodeId,
      kind: "secret_scope",
      nodeType: "secret_scope",
      displayName: scope,
      data: {
        scope,
        ...(match.resourceKeyMisuse ? { resourceKeyMisuse: match.resourceKeyMisuse } : {}),
      },
    });
    return match.nodeId;
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

      const referenceType = fileNode.data.referenceType;
      const [secrets, widgets, widgetUsage, taskValueUsage] = await Promise.all([
        detectSecretInNotebook(resolvedPath, fileTypeHint).catch(() => []),
        detectWidgetsInFile(resolvedPath, fileTypeHint).catch(() => []),
        // Notebook tasks pass their parameters as widgets, so compare them later.
        fileNode.data.referenceType === "notebook"
          ? detectWidgetUsageInFile(resolvedPath, fileTypeHint).catch(() => undefined)
          : undefined,
        // Notebooks and Python files set and read task values.
        referenceType === "notebook" || referenceType === "python_script"
          ? detectTaskValuesInFile(resolvedPath, fileTypeHint).catch(() => undefined)
          : undefined,
      ]);
      if (widgetUsage || taskValueUsage) {
        nodeMap.set(fileNode.id, {
          ...fileNode,
          data: {
            ...fileNode.data,
            ...(widgetUsage ? { widgetUsage } : {}),
            ...(taskValueUsage ? { taskValueUsage } : {}),
          },
        });
      }

      for (const detection of secrets) {
        if (!detection.scope) continue;
        const nodeId = secretScopeNode(detection.scope);
        addEdge({
          id: `${fileNode.id}->references->${nodeId}`,
          source: fileNode.id,
          target: nodeId,
          kind: "references",
          data: { line: detection.line, key: detection.key ?? undefined, file: resolvedPath },
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

  // Pipeline sources are not file nodes, so scan them here and link secrets to the pipeline.
  await Promise.all(
    graph.nodes
      .filter((node) => node.pipelineLibraries?.length)
      .flatMap((pipeline) =>
        pipelineSourceFiles(pipeline).map(async (filePath) => {
          const secrets = await detectSecretInNotebook(filePath).catch(() => []);
          for (const detection of secrets) {
            if (!detection.scope) continue;
            const nodeId = secretScopeNode(detection.scope);
            addEdge({
              id: `${pipeline.id}->secret->${nodeId}@${filePath}:${detection.line}`,
              source: pipeline.id,
              target: nodeId,
              kind: "references",
              data: { line: detection.line, key: detection.key ?? undefined, file: filePath },
            });
          }
        }),
      ),
  );

  return {
    nodes: [...nodeMap.values()],
    edges: [...graph.edges, ...newEdges],
  };
}

const SCANNED_SOURCE_EXTENSIONS = new Set([".py", ".sql", ".ipynb"]);
/** Upper bound on files read from one pipeline's glob folders, so a huge folder can't stall inspection. */
const MAX_GLOB_FILES = 200;

/** Local source files of a pipeline: its notebook/file sources and the files its globs cover. */
function pipelineSourceFiles(pipeline: BundleGraphNode): string[] {
  const files: string[] = [];
  let globFiles = 0;

  function walk(dir: string, recursive: boolean): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (globFiles >= MAX_GLOB_FILES || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full, true);
      } else if (SCANNED_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(full);
        globFiles += 1;
      }
    }
  }

  for (const ref of pipeline.pipelineLibraries ?? []) {
    if (!ref.checked || !ref.exists || !ref.resolvedPath) continue;
    if (ref.kind === "glob" && /\/\*\*?$/.test(ref.path)) walk(ref.resolvedPath, ref.path.endsWith("**"));
    else files.push(ref.resolvedPath);
  }
  return [...new Set(files)];
}
