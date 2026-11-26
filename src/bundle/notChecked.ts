/**
 * What the checks could not look at, and why (#647), so "No issues" never stays silent about
 * code the inspector didn't read. Worked out from the checked graph: each task's files and what
 * reading them found.
 *
 * Anything a finding already says is left out: a path set by a variable (`path_not_checked`)
 * and a file that failed to read (`file_scan_failed`).
 *
 * Shared by the copied reviews (in the webview, so no Node modules here), the full report and
 * the command-line tool.
 */

import type { BundleGraph, BundleGraphNode } from "./graph/bundleGraph.js";
import type { PipelineDataFlow } from "./pipelineDataFlow.js";
import { hasTemplate, isRemotePath } from "./fileStatus.js";
import type { FileReference, TaskNodeData } from "./resources/task.js";

export type NotCheckedReason =
  /** A task's file in the workspace, a volume, DBFS or cloud storage. */
  | "code_in_workspace"
  /** A task's file in the job's Git repository (`source: GIT`). */
  | "code_in_git"
  /** A wheel, JAR, `spark_submit` or dbt project: the code inside isn't read. */
  | "packaged_code"
  /** R and Scala are read for `dbutils` calls only. */
  | "language_partly_read"
  /** A `%run` the widget check couldn't follow. */
  | "run_not_followed"
  /** Widgets read by names only known at run time. */
  | "dynamic_widget_names"
  /** Pipeline sources or statements the data flow doesn't read. */
  | "data_flow_not_read"
  /** Jobs and pipelines returned by the bundle's Python (`python.resources`), which is never run. */
  | "python_resources";

export interface NotChecked {
  reason: NotCheckedReason;
  /** One short line, as the reviews and the CLI show it. Paths as written in the bundle. */
  text: string;
  /** The file it is about, absolute when local. */
  file?: string;
  line?: number;
  /** The task it belongs to (its graph id), for a job's review. */
  taskId?: string;
  /** The pipeline it belongs to (its graph id). */
  resourceId?: string;
}

const PACKAGED: Partial<Record<TaskNodeData["taskType"], string>> = {
  python_wheel: "Python wheel",
  spark_jar: "JAR",
  spark_submit: "spark-submit",
  dbt: "dbt project",
};

const PARTLY_READ_EXTENSIONS: Record<string, string> = { ".r": "R", ".scala": "Scala" };

/** The last part of a path, with `/` or `\\`. */
const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file;
const extension = (file: string): string => /\.[^.\\/]*$/.exec(file)?.[0].toLowerCase() ?? "";

function fileNodeOf(graph: BundleGraph, ref: FileReference): BundleGraphNode | undefined {
  const id = `file:${ref.resolvedPath ?? ref.path}`;
  return graph.nodes.find((node) => node.id === id);
}

function forTask(graph: BundleGraph, task: BundleGraphNode, data: TaskNodeData, key: string): NotChecked[] {
  const items: NotChecked[] = [];
  const at = { taskId: task.id };
  const packaged = PACKAGED[data.taskType];
  if (packaged) items.push({ reason: "packaged_code", text: `${packaged} code isn't read (task ${key}).`, ...at });

  for (const ref of data.fileReferences) {
    // Said by `path_not_checked` already.
    if (hasTemplate(ref.path)) continue;
    if (ref.source === "GIT") {
      items.push({ reason: "code_in_git", text: `Code from the job's Git repository isn't read: ${ref.path} (task ${key}).`, ...at });
      continue;
    }
    if (isRemotePath(ref.path)) {
      items.push({ reason: "code_in_workspace", text: `Code outside the bundle isn't read: ${ref.path} (task ${key}).`, ...at });
      continue;
    }
    if (!ref.exists || !ref.resolvedPath) continue;
    if (!packaged && (ref.referenceType === "python_wheel" || ref.referenceType === "jar" || ref.referenceType === "dbt_project")) {
      items.push({ reason: "packaged_code", text: `Code inside ${ref.path} isn't read (task ${key}).`, file: ref.resolvedPath, ...at });
      continue;
    }
    const language = PARTLY_READ_EXTENSIONS[extension(ref.resolvedPath)];
    if (language) {
      items.push({ reason: "language_partly_read", text: `${language} code is read for dbutils calls only: ${ref.path} (task ${key}).`, file: ref.resolvedPath, ...at });
    }
    const usage = fileNodeOf(graph, ref)?.codeFacts?.widgetUsage;
    if (usage?.hasUnresolvedRuns) {
      items.push({ reason: "run_not_followed", text: `A notebook it runs with %run couldn't be followed: ${ref.path} (task ${key}).`, file: ref.resolvedPath, ...at });
    }
    if (usage?.hasDynamicReads) {
      items.push({ reason: "dynamic_widget_names", text: `Widgets read by names set at run time aren't checked: ${ref.path} (task ${key}).`, file: ref.resolvedPath, ...at });
    }
  }
  return items;
}

/** What a pipeline's data flow doesn't read: whole sources (Python), and statements in SQL it couldn't follow. */
export function dataFlowNotChecked(flow: PipelineDataFlow, name: string, resourceId?: string): NotChecked[] {
  const at = resourceId ? { resourceId } : {};
  return [
    ...flow.notRead.map((source): NotChecked => ({
      reason: "data_flow_not_read",
      text: `Not in the data flow (${source.reason}): ${baseName(source.file)} (pipeline ${name}).`,
      file: source.file,
      ...at,
    })),
    ...flow.unread.map((statement): NotChecked => ({
      reason: "data_flow_not_read",
      text: `Not followed by the data flow: ${baseName(statement.file)}:${statement.line} (pipeline ${name}), ${statement.reason}.`,
      file: statement.file,
      line: statement.line,
      ...at,
    })),
  ];
}

/**
 * Everything the checks couldn't look at in a checked graph, in graph order, each line once. A
 * pipeline's data flow is a picture, not a check, so what it didn't read is only in the
 * pipeline's own review ({@link dataFlowNotChecked}).
 */
export function notCheckedIn(graph: BundleGraph): NotChecked[] {
  const items: NotChecked[] = [];
  for (const node of graph.nodes) {
    if (node.nodeType === "task" && node.taskData) {
      const key = node.taskKey ?? node.displayName;
      items.push(...forTask(graph, node, node.taskData, key));
      // A for_each task's inner task: its files belong to the loop's task.
      if (node.taskData.nestedTask) items.push(...forTask(graph, node, node.taskData.nestedTask, key));
    }
  }
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.text) && Boolean(seen.add(item.text)));
}

/** The items for one job's tasks. */
export function notCheckedForTasks(items: readonly NotChecked[], taskIds: ReadonlySet<string>): NotChecked[] {
  return items.filter((item) => item.taskId !== undefined && taskIds.has(item.taskId));
}

/** The items for one pipeline. */
export function notCheckedForResource(items: readonly NotChecked[], resourceId: string): NotChecked[] {
  return items.filter((item) => item.resourceId === resourceId);
}

/** How many "not checked" lines a copied summary lists before "...and N more." */
export const NOT_CHECKED_SUMMARY_LIMIT = 8;

/** A Markdown "Not checked" section, or no lines when everything was read. */
export function notCheckedMarkdown(items: readonly NotChecked[], escape: (text: string) => string, limit = NOT_CHECKED_SUMMARY_LIMIT): string[] {
  if (items.length === 0) return [];
  const lines = ["", "### Not checked", ...items.slice(0, limit).map((item) => `- ${escape(item.text)}`)];
  if (items.length > limit) lines.push(`- ...and ${items.length - limit} more.`);
  return lines;
}
