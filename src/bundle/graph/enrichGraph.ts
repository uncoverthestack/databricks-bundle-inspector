import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  detectQualifiedNamesInFile,
  detectSecretInNotebook,
  detectSqlParameterMarkersInFile,
  detectSqlTextParametersInFile,
  detectTaskValuesInFile,
  detectRunTargetsInFile,
  detectWidgetUsageInFile,
  detectWidgetsInFile,
} from "../taskFileDetections.js";
import { matchSecretScope } from "../resources/secretScope.js";
import { bundleSecretScopes, type BundleGraph, type BundleGraphNode } from "./bundleGraph.js";
import { buildPipelineDataFlow, type DataFlowFile } from "../pipelineDataFlow.js";
import { readPipelineSql } from "../pipelineSql.js";
import type { BundleEdge } from "./edges.js";
import { createSyncExclusion, type SyncExclusion } from "../syncRules.js";

/**
 * Enriches a bundle graph with secret scope and widget nodes found by scanning
 * the contents of local files already in the graph.
 *
 * Reads each `file` node whose `location` is `"local"` and whose `data.exists`
 * is true, runs secret and widget detection, and adds the results as new nodes
 * connected back to the file node via `references` / `uses` edges.
 *
 * Safe to call in parallel. Failed scans are recorded so an unread file cannot look clean.
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

  const failures = new Map<string, Map<string, { checks: Set<string>; directory: boolean }>>();
  const failed = (nodeId: string, file: string, check: string, directory = false) => {
    const byFile = failures.get(nodeId) ?? new Map<string, { checks: Set<string>; directory: boolean }>();
    const entry = byFile.get(file) ?? { checks: new Set<string>(), directory };
    entry.checks.add(check);
    entry.directory ||= directory;
    byFile.set(file, entry);
    failures.set(nodeId, byFile);
  };

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
    (n) =>
      n.nodeType === "file" &&
      n.location === "local" &&
      n.data.exists === true &&
      typeof n.data.resolvedPath === "string" &&
      isRegularFile(n.data.resolvedPath),
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
      const [secrets, widgets, widgetUsage, taskValueUsage, runTargets, sqlParameterMarkers, sqlTextParameters, qualifiedNames] = await Promise.all([
        detectSecretInNotebook(resolvedPath, fileTypeHint).catch(() => { failed(fileNode.id, resolvedPath, "secrets"); return []; }),
        detectWidgetsInFile(resolvedPath, fileTypeHint).catch(() => { failed(fileNode.id, resolvedPath, "widget definitions"); return []; }),
        // Notebook tasks pass their parameters as widgets, so compare them later.
        fileNode.data.referenceType === "notebook"
          ? detectWidgetUsageInFile(resolvedPath, fileTypeHint, undefined, graph.notebookRule).catch(() => { failed(fileNode.id, resolvedPath, "widget reads"); return undefined; })
          : undefined,
        // Notebooks and Python files set and read task values.
        referenceType === "notebook" || referenceType === "python_script"
          ? detectTaskValuesInFile(resolvedPath, fileTypeHint).catch(() => { failed(fileNode.id, resolvedPath, "task values"); return undefined; })
          : undefined,
        // The notebooks a notebook runs with %run or dbutils.notebook.run (#233).
        referenceType === "notebook"
          ? detectRunTargetsInFile(resolvedPath, fileTypeHint).catch(() => { failed(fileNode.id, resolvedPath, "notebook calls"); return undefined; })
          : undefined,
        // SQL file tasks fill the file's :name markers from their parameters (#234).
        referenceType === "sql"
          ? detectSqlParameterMarkersInFile(resolvedPath).catch(() => { failed(fileNode.id, resolvedPath, "SQL parameters"); return undefined; })
          : undefined,
        // ...and its {{name}} text parameters, pasted in as quoted text (#484).
        referenceType === "sql"
          ? detectSqlTextParametersInFile(resolvedPath).catch(() => { failed(fileNode.id, resolvedPath, "SQL text parameters"); return undefined; })
          : undefined,
        // Dotted names in task code, to find schemas a target renames (#235).
        referenceType === "notebook" || referenceType === "python_script" || referenceType === "sql"
          ? detectQualifiedNamesInFile(resolvedPath, fileTypeHint).catch(() => { failed(fileNode.id, resolvedPath, "schema references"); return undefined; })
          : undefined,
      ]);
      // Secrets whose scope isn't written in the code: kept, so the task never looks like it
      // reads none, with the parameter the scope comes from when the code shows it (issue 535).
      const runtimeSecrets = secrets
        .filter((detection) => !detection.scope)
        .map((detection) => ({
          line: detection.line,
          ...(detection.key ? { key: detection.key } : {}),
          ...(detection.scopeParameter ? { parameter: detection.scopeParameter } : {}),
        }));
      if (widgetUsage || taskValueUsage || runTargets?.length || sqlParameterMarkers?.length || sqlTextParameters?.length || qualifiedNames?.length || runtimeSecrets.length) {
        nodeMap.set(fileNode.id, {
          ...fileNode,
          data: {
            ...fileNode.data,
            ...(widgetUsage ? { widgetUsage } : {}),
            ...(taskValueUsage ? { taskValueUsage } : {}),
            ...(runTargets?.length ? { runTargets } : {}),
            ...(sqlParameterMarkers?.length ? { sqlParameterMarkers } : {}),
            ...(sqlTextParameters?.length ? { sqlTextParameters } : {}),
            ...(qualifiedNames?.length ? { qualifiedNames } : {}),
            ...(runtimeSecrets.length ? { runtimeSecrets } : {}),
          },
        });
      }

      // One link per scope, so the graph shows it once, holding every line that names it,
      // so each line gets its own finding (#463).
      const scopeLinks = new Map<string, { line: number; key: string | undefined; lines: number[] }>();
      for (const detection of secrets) {
        if (!detection.scope) continue;
        const nodeId = secretScopeNode(detection.scope);
        const link = scopeLinks.get(nodeId);
        if (link) {
          if (!link.lines.includes(detection.line)) link.lines.push(detection.line);
          continue;
        }
        scopeLinks.set(nodeId, { line: detection.line, key: detection.key ?? undefined, lines: [detection.line] });
      }
      for (const [nodeId, link] of scopeLinks) {
        addEdge({
          id: `${fileNode.id}->references->${nodeId}`,
          source: fileNode.id,
          target: nodeId,
          kind: "references",
          data: { ...link, file: resolvedPath },
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

  // Enumerate each pipeline once. Secrets and lineage must use the same uploaded source set.
  const exclusionOf = graph.sourceUpload
    ? createSyncExclusion(graph.sourceUpload.root, graph.sourceUpload.sync) : () => undefined;
  const pipelineSources = new Map<string, PipelineSources>();
  for (const pipeline of graph.nodes.filter((node) => node.pipelineLibraries?.length)) {
    const sources = pipelineSourceFiles(pipeline, exclusionOf, !!graph.sourceUpload?.sync?.include?.length);
    pipelineSources.set(pipeline.id, sources);
    for (const failure of sources.failures) failed(pipeline.id, failure.file, "pipeline source discovery", !!failure.directory);
  }

  // Pipeline sources are not file nodes, so scan them here and link secrets to the pipeline.
  await Promise.all(
    graph.nodes
      .filter((node) => node.pipelineLibraries?.length)
      .flatMap((pipeline) =>
        pipelineSources.get(pipeline.id)!.files.map(async (filePath) => {
          const secrets = await detectSecretInNotebook(filePath).catch(() => { failed(pipeline.id, filePath, "secrets"); return []; });
          for (const detection of secrets) {
            if (!detection.scope) {
              // A pipeline has no notebook parameters, so its scope is only known at run time.
              const current = nodeMap.get(pipeline.id)!;
              const reads = (current.data.runtimeSecrets as Array<{ file: string; line: number }> | undefined) ?? [];
              nodeMap.set(pipeline.id, { ...current, data: { ...current.data, runtimeSecrets: [...reads, { file: filePath, line: detection.line }] } });
              continue;
            }
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

  // Each pipeline's data flow from its SQL sources, read without running anything (issue 398).
  await Promise.all(
    [...nodeMap.values()]
      .filter((node) => node.pipelineLibraries?.length)
      .map(async (pipeline) => {
        const flow = await pipelineDataFlowOf(pipeline, pipelineSources.get(pipeline.id)!, (file) => failed(pipeline.id, file, "SQL data flow"));
        if (flow) nodeMap.set(pipeline.id, { ...pipeline, pipelineDataFlow: flow });
      }),
  );

  return {
    ...graph,
    nodes: [...nodeMap.values()].map((node) => {
      const byFile = failures.get(node.id);
      return byFile ? { ...node, scanFailures: [...byFile].map(([file, entry]) => ({ file, checks: [...entry.checks], ...(entry.directory ? { directory: true as const } : {}) })) } : node;
    }),
    edges: [...graph.edges, ...newEdges],
  };
}

/** Text values of a pipeline's `configuration`, which its SQL reads as `${key}`. */
function pipelineConfiguration(pipeline: BundleGraphNode): Record<string, string> {
  const configuration = pipeline.data.configuration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) return {};
  return Object.fromEntries(
    Object.entries(configuration as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function pipelineDataFlowOf(pipeline: BundleGraphNode, sourceSet: PipelineSources, failed: (file: string) => void) {
  const { files: sources, truncated, failures } = sourceSet;
  if (sources.length === 0 && failures.length === 0) return undefined;
  let incomplete = truncated || failures.length > 0;
  const config = pipelineConfiguration(pipeline);
  const files: DataFlowFile[] = [];
  const notRead: { file: string; reason: string }[] = [];
  for (const file of sources) {
    if (extname(file).toLowerCase() !== ".sql") {
      notRead.push({ file, reason: extname(file).toLowerCase() === ".py" ? "Python" : "notebook" });
      continue;
    }
    const sql = await readFile(file, "utf8").catch(() => undefined);
    if (sql === undefined) {
      failed(file);
      incomplete = true;
      continue;
    }
    files.push({ file, result: readPipelineSql(sql, config) });
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const flow = buildPipelineDataFlow(files, notRead, {
    catalog: text(pipeline.data.catalog),
    // `target` is the older name for the schema.
    schema: text(pipeline.data.schema) ?? text(pipeline.data.target),
  });
  return incomplete ? { ...flow, incomplete: true as const } : flow;
}

/**
 * Whether a path is a regular file, through links. Only those are read: reading a named
 * pipe waits for data that never comes, so the inspection never finished (#508).
 */
function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const SCANNED_SOURCE_EXTENSIONS = new Set([".py", ".sql", ".ipynb"]);
/** Upper bound on files read from one pipeline's glob folders, so a huge folder can't stall inspection. */
const MAX_GLOB_FILES = 200;

interface PipelineSources {
  files: string[];
  truncated: boolean;
  failures: Array<{ file: string; directory?: true }>;
}

/** Uploaded pipeline sources; an unread folder makes the list incomplete, not empty. */
function pipelineSourceFiles(
  pipeline: BundleGraphNode,
  exclusionOf: (file: string, directory?: boolean) => SyncExclusion | undefined,
  hasSyncIncludes: boolean,
): PipelineSources {
  const files: string[] = [];
  const failures: PipelineSources["failures"] = [];
  let globFiles = 0;
  let truncated = false;

  function readableFile(file: string): boolean {
    if (exclusionOf(file)) return false;
    try { return statSync(file).isFile(); } catch {
      failures.push({ file });
      return false;
    }
  }

  function walk(dir: string, recursive: boolean): void {
    const exclusion = exclusionOf(dir, true);
    // A sync.include may restore a descendant of a gitignored folder. Walk it to
    // test files individually; sync.exclude, metadata folders and symlinks always win.
    if (exclusion && (exclusion.rule !== "gitignore" || !hasSyncIncludes)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      failures.push({ file: dir, directory: true });
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".databricks") continue;
        if (recursive) walk(full, true);
      } else if (SCANNED_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) && readableFile(full)) {
        if (globFiles >= MAX_GLOB_FILES) {
          truncated = true;
          return;
        }
        files.push(full);
        globFiles += 1;
      }
    }
  }

  for (const ref of pipeline.pipelineLibraries ?? []) {
    if (!ref.checked || !ref.resolvedPath) continue;
    // Even when the earlier existence check could not list a folder, try discovery
    // here so permission errors are reported instead of becoming a missing-table hint.
    if (ref.kind === "glob" && /\/\*\*?$/.test(ref.path)) {
      if (ref.exists || isDirectory(ref.resolvedPath)) walk(ref.resolvedPath, ref.path.endsWith("**"));
    } else if (ref.exists && readableFile(ref.resolvedPath)) files.push(ref.resolvedPath);
  }
  return { files: [...new Set(files)], truncated, failures };
}

/** A missing glob root already has a missing-source finding. Existing folders are scanned. */
function isDirectory(file: string): boolean {
  try { return statSync(file).isDirectory(); } catch { return false; }
}
