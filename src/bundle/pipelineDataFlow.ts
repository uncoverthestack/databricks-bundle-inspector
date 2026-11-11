/**
 * One pipeline's data flow, joined from what readPipelineSql found in each of its SQL files
 * (issue 398): the datasets it creates, what each one reads, and what could not be read.
 * Shared by the panel and, later, the CLI (issue 392). Nothing here guesses: a name that may
 * or may not be one of the pipeline's own datasets says "may be".
 */
import type { PipelineDatasetKind, PipelineSqlResult } from "./pipelineSql.js";

export type DataFlowNodeKind = PipelineDatasetKind | "flow_target" | "outside" | "files";

export interface DataFlowNode {
  id: string;
  /** As written: `orders`, `main.sales.orders`, or a path for files. */
  name: string;
  kind: DataFlowNodeKind;
  /** Where it is created (datasets) or first read (outside tables and files). */
  file: string;
  line: number;
  /** PRIVATE or TEMPORARY: only inside this pipeline. */
  pipelineOnly?: true;
  /** Created more than once in this pipeline's SQL. */
  definedAgain?: { file: string; line: number };
  /** An outside name whose last part matches one of this pipeline's datasets. */
  maybeSameAs?: string;
}

export interface DataFlowEdge {
  from: string;
  to: string;
  streaming: boolean;
  /** Through a flow (CREATE FLOW, AUTO CDC, APPLY CHANGES): its name. */
  flow?: string;
  file: string;
  line: number;
}

export interface DataFlowUnread {
  file: string;
  line: number;
  reason: string;
  /** The dataset node it would feed, for a read that could not be read. */
  target?: string;
}

export interface PipelineDataFlow {
  nodes: DataFlowNode[];
  edges: DataFlowEdge[];
  unread: DataFlowUnread[];
  /** Source files the data flow does not read yet (Python, notebooks), with why. */
  notRead: { file: string; reason: string }[];
  sqlFiles: number;
}

export interface DataFlowFile {
  file: string;
  result: PipelineSqlResult;
}

const key = (name: string) => name.toLowerCase();
const isPlaceholder = (value: string | null | undefined) => !value || value.includes("${");

/** A name's parts, split at dots outside backticks: `` `a.b`.c `` is ["a.b", "c"]. */
export function splitName(name: string): string[] {
  const parts: string[] = [""];
  let quoted = false;
  for (const c of name) {
    if (c === "`") { quoted = !quoted; continue; }
    if (c === "." && !quoted) { parts.push(""); continue; }
    parts[parts.length - 1] += c;
  }
  return parts;
}

type Namespace = { catalog?: string | null; schema?: string | null } | undefined;

/**
 * Where a name points: its full catalog.schema.table when every part is known, from what is
 * written, the file's USE statements and the pipeline's defaults. Otherwise only the name as
 * written in its context, which matches the same name written in the same context and
 * nothing else.
 */
function resolveName(name: string, namespace: Namespace, defaults: { catalog?: string; schema?: string }): { key: string; last: string } {
  const parts = splitName(name).map(key);
  const last = parts[parts.length - 1]!;
  const known = (value: string | null | undefined) => (value === null || isPlaceholder(value) ? undefined : key(value!));
  const catalogOf = () => (namespace && "catalog" in namespace ? known(namespace.catalog) : known(defaults.catalog));
  const schemaOf = () => (namespace && "schema" in namespace ? known(namespace.schema) : known(defaults.schema));
  const full =
    parts.length >= 3 ? parts :
    parts.length === 2 ? [catalogOf(), ...parts] :
    [catalogOf(), schemaOf(), ...parts];
  if (full.every((part) => part !== undefined)) return { key: `full:${full.join("\u0001")}`, last };
  return { key: `as-written:${JSON.stringify(namespace ?? null)}:${parts.join("\u0001")}`, last };
}

/**
 * @param defaults The pipeline's catalog and schema, resolved when the bundle gives them. A
 *   read is this pipeline's dataset only when both point at the same catalog.schema.table,
 *   or, when those cannot be known, are written the same way in the same USE context.
 *   Otherwise it is outside, with a "may be the same as" note when its last part matches.
 */
export function buildPipelineDataFlow(
  files: DataFlowFile[],
  notRead: { file: string; reason: string }[],
  defaults: { catalog?: string | undefined; schema?: string | undefined } = {},
): PipelineDataFlow {
  const nodes = new Map<string, DataFlowNode>();
  const edges: DataFlowEdge[] = [];
  const edgeKeys = new Set<string>();
  const unread: DataFlowUnread[] = [];
  const known = { ...(defaults.catalog ? { catalog: defaults.catalog } : {}), ...(defaults.schema ? { schema: defaults.schema } : {}) };
  /** Each of this pipeline's datasets by where its name points. */
  const byKey = new Map<string, DataFlowNode>();
  const byLast = new Map<string, DataFlowNode>();
  const outsideByKey = new Map<string, DataFlowNode>();
  const datasetFor = (name: string, namespace: Namespace) => byKey.get(resolveName(name, namespace, known).key);
  const nodeId = (prefix: string, name: string) => {
    // The id is the name as written; two different tables written alike get distinct ids.
    let id = `${prefix}:${key(name)}`;
    for (let n = 2; nodes.has(id); n++) id = `${prefix}:${key(name)}#${n}`;
    return id;
  };

  // The datasets first, from every file: a read in one file may name a table made in another.
  for (const { file, result } of files) {
    for (const dataset of result.datasets) {
      const resolved = resolveName(dataset.name, dataset.namespace, known);
      const existing = byKey.get(resolved.key);
      if (existing) {
        if (existing.kind === "flow_target") Object.assign(existing, { kind: dataset.kind, file, line: dataset.line });
        else existing.definedAgain ??= { file, line: dataset.line };
        continue;
      }
      const node: DataFlowNode = {
        id: nodeId("dataset", dataset.name),
        name: dataset.name,
        kind: dataset.kind,
        file,
        line: dataset.line,
        ...(dataset.pipelineOnly ? { pipelineOnly: true as const } : {}),
      };
      nodes.set(node.id, node);
      byKey.set(resolved.key, node);
      if (!byLast.has(resolved.last)) byLast.set(resolved.last, node);
    }
  }
  for (const { file, result } of files) {
    for (const target of result.flowTargets) {
      const resolved = resolveName(target.name, target.namespace, known);
      if (byKey.has(resolved.key)) continue;
      const line = result.reads.find((read) => key(read.target) === key(target.name))?.line ?? 0;
      const node: DataFlowNode = { id: nodeId("dataset", target.name), name: target.name, kind: "flow_target", file, line };
      nodes.set(node.id, node);
      byKey.set(resolved.key, node);
      if (!byLast.has(resolved.last)) byLast.set(resolved.last, node);
    }
  }

  for (const { file, result } of files) {
    for (const read of result.reads) {
      const target = datasetFor(read.target, read.namespace);
      if (!target) continue;
      let source: DataFlowNode | undefined;
      if (read.source.startsWith("files:")) {
        const path = read.source.slice("files:".length);
        const id = `files:${path}`;
        source = nodes.get(id) ?? { id, name: path, kind: "files", file, line: read.line };
        nodes.set(id, source);
      } else {
        source = datasetFor(read.source, read.namespace);
        if (!source) {
          const resolved = resolveName(read.source, read.namespace, known);
          source = outsideByKey.get(resolved.key);
          if (!source) {
            const maybe = byLast.get(resolved.last);
            source = {
              id: nodeId("outside", read.source),
              name: read.source,
              kind: "outside",
              file,
              line: read.line,
              ...(maybe ? { maybeSameAs: maybe.name } : {}),
            };
            nodes.set(source.id, source);
            outsideByKey.set(resolved.key, source);
          }
        }
      }
      if (source.id === target.id) continue;
      const edgeKey = `${source.id}->${target.id}:${read.flow ?? ""}`;
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      edges.push({
        from: source.id,
        to: target.id,
        streaming: read.streaming,
        ...(read.flow ? { flow: read.flow } : {}),
        file,
        line: read.line,
      });
    }
    for (const item of result.unread) {
      const target = item.target
        ? [...byKey.values()].find((node) => key(node.name) === key(item.target!))?.id
        : undefined;
      unread.push({ file, line: item.line, reason: item.reason, ...(target ? { target } : {}) });
    }
  }

  return { nodes: [...nodes.values()], edges, unread, notRead, sqlFiles: files.length };
}

/**
 * Columns for drawing, left to right. Each dataset sits one column after the furthest thing
 * it reads; each outside table or file source sits just before the first dataset it feeds,
 * so no line runs behind a box in a column it skips. Within a column, boxes follow the
 * order of what they read, so lines stay as straight as they can. A loop (a reads b reads a)
 * keeps its first column instead of growing forever.
 */
export function dataFlowColumns(flow: PipelineDataFlow): DataFlowNode[][] {
  const column = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of flow.edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to)!.push(edge.from);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const isSource = (node: DataFlowNode) => node.kind === "outside" || node.kind === "files";
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  // Longest path from the sources, without recursion, so a chain of thousands of datasets
  // cannot overflow the call stack (Kahn's order over the datasets).
  const datasets = flow.nodes.filter((n) => !isSource(n));
  const waiting = new Map<string, number>();
  for (const node of datasets) {
    waiting.set(node.id, (incoming.get(node.id) ?? []).filter((id) => byId.get(id) && !isSource(byId.get(id)!)).length);
  }
  const ready = datasets.filter((node) => waiting.get(node.id) === 0).map((node) => node.id);
  for (const id of ready) column.set(id, 1);
  for (let next = 0; next < ready.length; next++) {
    const id = ready[next]!;
    for (const to of outgoing.get(id) ?? []) {
      if (!waiting.has(to)) continue;
      column.set(to, Math.max(column.get(to) ?? 1, column.get(id)! + 1));
      const left = waiting.get(to)! - 1;
      waiting.set(to, left);
      if (left === 0) ready.push(to);
    }
  }
  // Datasets in a loop (a reads b reads a) never become ready: they sit one column after
  // the furthest placed dataset they read, or in column 1.
  for (const node of datasets) {
    if (column.has(node.id)) continue;
    const placed = (incoming.get(node.id) ?? []).map((id) => column.get(id)).filter((c): c is number => c !== undefined);
    column.set(node.id, placed.length ? Math.max(...placed) + 1 : 1);
  }
  for (const node of flow.nodes.filter(isSource)) {
    const targets = (outgoing.get(node.id) ?? []).map((id) => column.get(id) ?? 1);
    column.set(node.id, Math.max(0, Math.min(...(targets.length ? targets : [1])) - 1));
  }
  const columns: DataFlowNode[][] = [];
  for (const node of flow.nodes) (columns[column.get(node.id) ?? 1] ??= []).push(node);
  const filled = columns.filter((nodes) => nodes && nodes.length > 0);
  // Order each column by the rows of what its boxes read (or, for sources, what they feed);
  // boxes linked to nothing go last.
  const row = new Map<string, number>();
  filled.forEach((nodes, index) => {
    const score = (node: DataFlowNode) => {
      const linked = [...(incoming.get(node.id) ?? []), ...(index === 0 ? outgoing.get(node.id) ?? [] : [])]
        .map((id) => row.get(id))
        .filter((r): r is number => r !== undefined);
      if (linked.length) return linked.reduce((sum, r) => sum + r, 0) / linked.length;
      return (incoming.get(node.id)?.length ?? 0) + (outgoing.get(node.id)?.length ?? 0) > 0 ? 1e6 : 2e6;
    };
    const order = nodes.map((node, i) => ({ node, i, s: score(node) })).sort((a, b) => a.s - b.s || a.i - b.i);
    nodes.splice(0, nodes.length, ...order.map((entry) => entry.node));
    nodes.forEach((node, i) => row.set(node.id, i));
  });
  return filled;
}
