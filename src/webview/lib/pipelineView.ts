/**
 * What the pipeline view shows, from the bundle's YAML alone: the pipeline's settings, its
 * `libraries`, the jobs in this bundle that run it, and its problems. Nothing is read from
 * the pipeline's table code, so nothing here is a guess about tables.
 */

import { orderBySeverity, severityMeta } from "./issueSeverity.js";

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
  };
}

/** Errors and warnings per pipeline, for the other pipelines' buttons. */
export function pipelineIssueCounts(pipelineKeys: string[], inspectorIssues: Issue[] = []): Map<string, number> {
  const counts = new Map(pipelineKeys.map((key) => [key, 0]));
  for (const issue of inspectorIssues) {
    const key = issue.resourceId?.startsWith("resources.pipelines.") && !issue.taskId
      ? issue.resourceId.slice("resources.pipelines.".length)
      : undefined;
    if (key !== undefined && counts.has(key) && issue.severity !== "info") counts.set(key, counts.get(key)! + 1);
  }
  return counts;
}

const STATUS_WORDS: Record<SourceStatus, string> = {
  found: "found",
  missing: "missing",
  no_files: "match no files",
  not_a_notebook: "not a notebook",
  is_a_notebook: "a notebook listed as a file",
  not_checked: "not checked",
};

const locationOf = (file: string | undefined, line: number | undefined) => {
  const name = file?.split(/[\\/]/).pop();
  return name ? `${name}${line && line > 0 ? `:${line}` : ""}` : "";
};

/** The "Copy review" text for one pipeline: only its own issues, runners and sources. */
export function pipelineReviewSummary(
  view: PipelineViewModel,
  { bundleName, targetLabel, resolveName = (value) => value }: {
    bundleName: string;
    targetLabel: string;
    resolveName?: (value: string) => string;
  },
): string {
  const lines = [
    "## Databricks Bundle Review",
    "",
    `Bundle: ${bundleName}`,
    `Target: ${targetLabel}`,
    `Pipeline: ${resolveName(view.name)}`,
    "",
    "### Issues",
  ];
  if (view.issues.length === 0) lines.push("- No issues detected in this pipeline.");
  for (const issue of orderBySeverity(view.issues).slice(0, 12)) {
    const location = locationOf(issue.file, issue.line);
    lines.push(`- **${severityMeta(issue.severity).label}** · ${issue.title}${location ? ` (${location})` : ""}`);
  }
  if (view.issues.length > 12) lines.push(`- ...and ${view.issues.length - 12} more.`);

  lines.push("", "### Run by");
  if (view.runBy.length === 0) lines.push("- No job in this bundle runs this pipeline.");
  for (const runner of view.runBy) lines.push(`- ${resolveName(runner.jobName)} (task ${runner.taskKey})`);

  lines.push("", "### Sources", `- ${view.sources.length} source${view.sources.length === 1 ? "" : "s"} in libraries`);
  const counts = new Map<SourceStatus, number>();
  for (const source of view.sources) counts.set(source.status, (counts.get(source.status) ?? 0) + 1);
  for (const [status, count] of counts) lines.push(`- ${count} ${STATUS_WORDS[status]}`);
  return lines.join("\n");
}
