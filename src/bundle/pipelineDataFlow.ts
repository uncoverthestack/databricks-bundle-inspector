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
const lastPart = (name: string) => key(name).split(".").pop() ?? key(name);
const isPlaceholder = (value: string | undefined) => !value || value.includes("${");

/**
 * @param defaults The pipeline's catalog and schema, resolved when the bundle gives them. A
 *   read named `catalog.schema.x` or `schema.x` is this pipeline's `x` only when its prefix
 *   matches; with unknown defaults it stays outside, with a "may be" note.
 */
export function buildPipelineDataFlow(
  files: DataFlowFile[],
  notRead: { file: string; reason: string }[],
  defaults: { catalog?: string | undefined; schema?: string | undefined } = {},
): PipelineDataFlow {
  const nodes = new Map<string, DataFlowNode>();
  const edges: DataFlowEdge[] = [];
  const unread: DataFlowUnread[] = [];

  // The datasets first, from every file: a read in one file may name a table made in another.
  for (const { file, result } of files) {
    for (const dataset of result.datasets) {
      const id = `dataset:${key(dataset.name)}`;
      const existing = nodes.get(id);
      if (existing) {
        if (existing.kind === "flow_target") Object.assign(existing, { kind: dataset.kind, file, line: dataset.line });
        else existing.definedAgain ??= { file, line: dataset.line };
        continue;
      }
      nodes.set(id, {
        id,
        name: dataset.name,
        kind: dataset.kind,
        file,
        line: dataset.line,
        ...(dataset.pipelineOnly ? { pipelineOnly: true as const } : {}),
      });
    }
  }
  for (const { file, result } of files) {
    for (const target of result.flowTargets) {
      const id = `dataset:${key(target)}`;
      if (!nodes.has(id)) {
        const line = result.reads.find((read) => key(read.target) === key(target))?.line ?? 0;
        nodes.set(id, { id, name: target, kind: "flow_target", file, line });
      }
    }
  }

  const own = new Map([...nodes.values()].map((node) => [lastPart(node.name), node]));
  const catalog = isPlaceholder(defaults.catalog) ? undefined : key(defaults.catalog!);
  const schema = isPlaceholder(defaults.schema) ? undefined : key(defaults.schema!);
  const sourceId = (name: string): { id: string; outside?: { maybeSameAs?: string } } => {
    if (name.startsWith("files:")) return { id: `files:${name.slice("files:".length)}`, outside: {} };
    const parts = key(name).split(".");
    const local = own.get(parts[parts.length - 1]!);
    if (parts.length === 1) return local ? { id: local.id } : { id: `outside:${key(name)}`, outside: {} };
    const prefixMatches =
      (parts.length === 2 && schema !== undefined && parts[0] === schema) ||
      (parts.length === 3 && catalog !== undefined && schema !== undefined && parts[0] === catalog && parts[1] === schema);
    if (local && prefixMatches) return { id: local.id };
    return { id: `outside:${key(name)}`, outside: local ? { maybeSameAs: local.name } : {} };
  };

  for (const { file, result } of files) {
    for (const read of result.reads) {
      const target = nodes.get(`dataset:${key(read.target)}`);
      if (!target) continue;
      const source = sourceId(read.source);
      if (source.outside && !nodes.has(source.id)) {
        const isFiles = read.source.startsWith("files:");
        nodes.set(source.id, {
          id: source.id,
          name: isFiles ? read.source.slice("files:".length) : read.source,
          kind: isFiles ? "files" : "outside",
          file,
          line: read.line,
          ...(source.outside.maybeSameAs ? { maybeSameAs: source.outside.maybeSameAs } : {}),
        });
      }
      if (source.id === target.id) continue;
      if (edges.some((edge) => edge.from === source.id && edge.to === target.id && edge.flow === read.flow)) continue;
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
      const target = item.target ? nodes.get(`dataset:${key(item.target)}`)?.id : undefined;
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
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const isSource = (node: DataFlowNode) => node.kind === "outside" || node.kind === "files";
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const visiting = new Set<string>();
  const place = (node: DataFlowNode): number => {
    const known = column.get(node.id);
    if (known !== undefined) return known;
    if (isSource(node)) return 0;
    if (visiting.has(node.id)) return 1;
    visiting.add(node.id);
    const from = (incoming.get(node.id) ?? []).map((id) => byId.get(id)).filter((n): n is DataFlowNode => Boolean(n));
    const datasets = from.filter((n) => !isSource(n));
    // A dataset that only reads outside sources sits in column 1, after them.
    const at = datasets.length === 0 ? 1 : Math.max(...datasets.map(place)) + 1;
    visiting.delete(node.id);
    column.set(node.id, at);
    return at;
  };
  flow.nodes.filter((n) => !isSource(n)).forEach(place);
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
