/**
 * What the pipeline view shows: from the bundle's YAML, the pipeline's settings, its
 * `libraries`, the jobs in this bundle that run it and its problems; from its SQL sources,
 * its data flow (issue 398), read without running anything and never guessed.
 */

import type { PipelineDataFlow } from "../../bundle/pipelineDataFlow.js";
import { orderBySeverity, severityMeta } from "./issueSeverity.js";
import { escapeMarkdown } from "../../bundle/markdownText.js";
import { reportLocation } from "../../bundle/reportLocation.js";

interface GraphNode {
  id: string;
  kind?: string | undefined;
  nodeType?: string | undefined;
  displayName?: string | undefined;
  resourceGroup?: string | undefined;
  resourceKey?: string | undefined;
  data?: Record<string, unknown> | undefined;
  pipelineLibraries?: Array<{
    kind: "notebook" | "file" | "glob";
    path: string;
    resolvedPath?: string | undefined;
    exists: boolean;
    checked: boolean;
    notebookProblem?: { kind?: string } | undefined;
    sourceFile: string;
    sourceLine: number;
    sourceColumn?: number | undefined;
  }> | undefined;
  sourceFile?: string | undefined;
  sourceLine?: number | undefined;
  pipelineDataFlow?: PipelineDataFlow | undefined;
}

interface GraphEdge {
  source: string;
  target: string;
  kind?: string | undefined;
  data?: { file?: string | undefined; line?: number | undefined; key?: string } | undefined;
}

interface Issue {
  id: string;
  severity: "error" | "warning" | "info";
  kind: string;
  title: string;
  detail?: string | undefined;
  taskId?: string | undefined;
  resourceId?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
}

export type SourceStatus = "found" | "missing" | "no_files" | "not_a_notebook" | "is_a_notebook" | "not_checked";

export interface PipelineSource {
  kind: "notebook" | "file" | "glob";
  path: string;
  status: SourceStatus;
  /** The local file to open, when there is one. */
  resolvedPath?: string;
  /** Where `libraries` names it. */
  file: string;
  line: number;
  column?: number;
}

export interface PipelineRunner {
  jobKey: string;
  jobName: string;
  taskKey: string;
}

export interface PipelineSecret {
  scope: string;
  file?: string;
  line?: number;
}

export interface PipelineViewModel {
  key: string;
  id: string;
  name: string;
  file?: string;
  line?: number;
  catalog?: string;
  schema?: string;
  /** Databricks runs a pipeline triggered unless `continuous` is true. */
  mode: "Continuous" | "Triggered";
  serverless: boolean;
  development: boolean;
  sources: PipelineSource[];
  runBy: PipelineRunner[];
  secrets: PipelineSecret[];
  issues: Issue[];
  /** From the pipeline's SQL sources (issue 398); absent when it has no local sources. */
  dataFlow?: PipelineDataFlow;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** The pipelines in the bundle, in the order the CLI lists them. */
export function pipelineKeysOf(parsedBundle: unknown): string[] {
  return Object.keys(asRecord(asRecord(asRecord(parsedBundle).resources).pipelines));
}

/** The pipeline a `pipeline_task.pipeline_id` names, when it is one of this bundle's. */
export function referencedPipelineKey(pipelineId: unknown): string | undefined {
  if (typeof pipelineId !== "string") return undefined;
  return /^\$\{resources\.pipelines\.([^.}]+)\.id\}$/.exec(pipelineId.trim())?.[1];
}

/** The pipeline a task runs, directly or as a `for_each_task`'s inner task. */
export function taskPipelineKey(task: unknown): string | undefined {
  const record = asRecord(task);
  const pipelineTask = asRecord(record.pipeline_task ?? asRecord(asRecord(record.for_each_task).task).pipeline_task);
  return referencedPipelineKey(pipelineTask.pipeline_id);
}

/** The tasks in this bundle's jobs that run each pipeline, by pipeline key. */
export function pipelineRunners(parsedBundle: unknown): Map<string, PipelineRunner[]> {
  const runners = new Map<string, PipelineRunner[]>();
  const jobs = asRecord(asRecord(asRecord(parsedBundle).resources).jobs);
  for (const [jobKey, job] of Object.entries(jobs)) {
    const tasks = asRecord(job).tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const pipelineKey = taskPipelineKey(task);
      const taskKey = asString(asRecord(task).task_key);
      if (!pipelineKey || !taskKey) continue;
      const list = runners.get(pipelineKey) ?? [];
      list.push({ jobKey, jobName: asString(asRecord(job).name) ?? jobKey, taskKey });
      runners.set(pipelineKey, list);
    }
  }
  return runners;
}

function sourceStatus(ref: NonNullable<GraphNode["pipelineLibraries"]>[number]): SourceStatus {
  if (!ref.checked) return "not_checked";
  if (!ref.exists) return ref.kind === "glob" ? "no_files" : "missing";
  // A `file` library that points at a notebook is the opposite problem of a notebook that isn't one.
  if (ref.notebookProblem?.kind === "is_a_notebook") return "is_a_notebook";
  if (ref.notebookProblem) return "not_a_notebook";
  return "found";
}

export function buildPipelineView(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  parsedBundle: unknown,
  pipelineKey: string,
  inspectorIssues: Issue[] = [],
): PipelineViewModel | undefined {
  const id = `resources.pipelines.${pipelineKey}`;
  const node = graph.nodes.find((n) => n.id === id);
  const pipelines = asRecord(asRecord(asRecord(parsedBundle).resources).pipelines);
  if (!node && !Object.hasOwn(pipelines, pipelineKey)) return undefined;
  const pipeline = asRecord(pipelines[pipelineKey]);

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const secrets = new Map<string, PipelineSecret>();
  for (const edge of graph.edges) {
    if (edge.source !== id) continue;
    const target = nodeById.get(edge.target);
    if (target?.nodeType !== "secret_scope") continue;
    const scope = asString(asRecord(target.data).scope) ?? target.displayName ?? edge.target;
    // One row per scope, at its first use.
    if (!secrets.has(scope)) {
      secrets.set(scope, {
        scope,
        ...(edge.data?.file ? { file: edge.data.file } : {}),
        ...(edge.data?.line ? { line: edge.data.line } : {}),
      });
    }
  }

  const catalog = asString(pipeline.catalog);
  // `target` is the older name for the schema.
  const schema = asString(pipeline.schema ?? pipeline.target);
  return {
    key: pipelineKey,
    id,
    name: asString(pipeline.name) ?? pipelineKey,
    ...(node?.sourceFile ? { file: node.sourceFile } : {}),
    ...(node?.sourceLine ? { line: node.sourceLine } : {}),
    ...(catalog ? { catalog } : {}),
    ...(schema ? { schema } : {}),
    mode: pipeline.continuous === true ? "Continuous" : "Triggered",
    serverless: pipeline.serverless === true,
    development: pipeline.development === true,
    sources: (node?.pipelineLibraries ?? []).map((ref) => ({
      kind: ref.kind,
      path: ref.path,
      status: sourceStatus(ref),
      ...(ref.kind !== "glob" && ref.exists && ref.resolvedPath ? { resolvedPath: ref.resolvedPath } : {}),
      file: ref.sourceFile,
      line: ref.sourceLine,
      ...(ref.sourceColumn ? { column: ref.sourceColumn } : {}),
    })),
    runBy: pipelineRunners(parsedBundle).get(pipelineKey) ?? [],
    secrets: [...secrets.values()],
    issues: inspectorIssues.filter((issue) => issue.resourceId === id && !issue.taskId),
    ...(node?.pipelineDataFlow ? { dataFlow: node.pipelineDataFlow } : {}),
  };
}

const STATUS_WORDS: Record<SourceStatus, string> = {
  found: "found",
  missing: "missing",
  no_files: "match no files",
  not_a_notebook: "not a notebook",
  is_a_notebook: "a notebook listed as a file",
  not_checked: "not checked",
};

/**
 * The "Copy review" text for one pipeline: only its own issues, runners and sources. Text from the
 * bundle is escaped, so a pasted summary never shows a link, an image, HTML or a mention (#486).
 */
export function pipelineReviewSummary(
  view: PipelineViewModel,
  { bundleName, targetLabel, bundleRoot, resolveName = (value) => value }: {
    bundleName: string;
    targetLabel: string;
    bundleRoot?: string;
    resolveName?: (value: string) => string;
  },
): string {
  const lines = [
    "## Databricks Bundle Review",
    "",
    `Bundle: ${escapeMarkdown(bundleName)}`,
    `Target: ${escapeMarkdown(targetLabel)}`,
    `Pipeline: ${escapeMarkdown(resolveName(view.name))}`,
    "",
    "### Issues",
  ];
  if (view.issues.length === 0) lines.push("- No issues detected in this pipeline.");
  for (const issue of orderBySeverity(view.issues).slice(0, 12)) {
    const location = reportLocation(issue.file, issue.line, bundleRoot);
    lines.push(`- **${severityMeta(issue.severity).label}** · ${escapeMarkdown(issue.title)}${location ? ` (${escapeMarkdown(location)})` : ""}`);
  }
  if (view.issues.length > 12) lines.push(`- ...and ${view.issues.length - 12} more.`);

  lines.push("", "### Run by");
  if (view.runBy.length === 0) lines.push("- No job in this bundle runs this pipeline.");
  for (const runner of view.runBy) lines.push(`- ${escapeMarkdown(resolveName(runner.jobName))} (task ${escapeMarkdown(runner.taskKey)})`);

  lines.push("", "### Sources", `- ${view.sources.length} source${view.sources.length === 1 ? "" : "s"} in libraries`);
  const counts = new Map<SourceStatus, number>();
  for (const source of view.sources) counts.set(source.status, (counts.get(source.status) ?? 0) + 1);
  for (const [status, count] of counts) lines.push(`- ${count} ${STATUS_WORDS[status]}`);
  return lines.join("\n");
}

/** A pipeline has a data flow page when it has SQL sources to read (issue 436). */
export function hasDataFlowPage(view: Pick<PipelineViewModel, "dataFlow"> | undefined): boolean {
  return (view?.dataFlow?.sqlFiles ?? 0) > 0;
}

export interface PipelineSourceRow extends PipelineSource {
  /** The problems found on the `libraries` line that lists this source. */
  issues: Issue[];
}

/** What the bundle overview's side panel shows for a pipeline (issue 436). */
export interface PipelinePanel {
  /** The `name` as written, when it differs from the key. */
  name?: string;
  /** "Serverless · Triggered · Development mode". */
  settings: string;
  /** The default catalog and schema, or undefined when neither is set. */
  writesTo?: string;
  sources: PipelineSourceRow[];
  /** The pipeline's problems that are not on one of its sources' lines. */
  otherIssues: Issue[];
  /**
   * The data flow line: a summary and a link when it has SQL sources, else why there is none.
   * Absent when the pipeline lists no local sources at all.
   */
  dataFlow?: { summary: string; opens: boolean };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function dataFlowLine(flow: PipelineDataFlow): PipelinePanel["dataFlow"] {
  if (flow.sqlFiles === 0) {
    const allPython = flow.notRead.length > 0 && flow.notRead.every((file) => file.reason === "Python");
    return { summary: allPython ? "From SQL sources only. This pipeline's are Python." : "From SQL sources only. This pipeline has none.", opens: false };
  }
  const created = flow.nodes.filter((node) => node.kind !== "outside" && node.kind !== "files").length;
  const outside = flow.nodes.length - created;
  if (created === 0 && outside === 0) return { summary: "No tables or views found in this pipeline's SQL.", opens: true };
  const parts = [`Creates ${plural(created, "table or view", "tables and views")}`];
  if (outside > 0) parts.push(`reads ${outside} from outside`);
  return { summary: `${parts.join(", ")}.`, opens: true };
}

export function pipelinePanel(view: PipelineViewModel, resolveName: (value: string) => string = (value) => value): PipelinePanel {
  const sameLine = (issue: Issue, source: PipelineSource) => issue.file === source.file && issue.line === source.line;
  const sources = view.sources.map((source) => ({ ...source, issues: view.issues.filter((issue) => sameLine(issue, source)) }));
  const name = resolveName(view.name);
  const writesTo = [view.catalog, view.schema].filter(Boolean).map((part) => resolveName(part!)).join(".");
  const dataFlow = view.dataFlow ? dataFlowLine(view.dataFlow) : undefined;
  return {
    ...(name !== view.key ? { name } : {}),
    // "Serverless" only when the bundle says so: without it, the workspace may still pick
    // serverless, so "classic" would be a guess.
    settings: [...(view.serverless ? ["Serverless"] : []), view.mode, ...(view.development ? ["Development mode"] : [])].join(" · "),
    ...(writesTo ? { writesTo } : {}),
    sources,
    otherIssues: view.issues.filter((issue) => !view.sources.some((source) => sameLine(issue, source))),
    ...(dataFlow ? { dataFlow } : {}),
  };
}
