/**
 * What the job header lists: the count panels (tasks, files, pipelines, variables, secret
 * scopes, compute, issues) and the search box's items. Moved from App.jsx with no change (#392).
 */
import type { ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { resolveExpressionForTarget, resolveVariableForTarget } from "../../bundle/targetResolution.js";
import { buildIssueItems, type IssueItem, type ValidationIssue } from "./issueItems.js";
import { taskProblemCounts, type TaskProblemIssue, type TaskProblemTone } from "./taskProblems.js";
import {
  basename,
  getCurrentJobTaskNodes,
  getDefinedVariableNames,
  getFileStatus,
  taskBoxProblems,
  type FileStatus,
  type GraphLike,
  type TaskIssue,
  type TaskNode,
} from "./taskIssues.js";

type Bundle = ParsedBundleConfig | null | undefined;
type Target = string | null | undefined;

export function isPipelineTask(task: TaskNode): boolean {
  return task.kind === "pipeline" || task.taskData?.taskType === "pipeline";
}

/** The chip beside a variable: where its value comes from for the shown target. */
export function variableResolutionLabel(item: { unresolved?: boolean; resolutionSource?: string; source?: string }): string {
  if (item.unresolved) return "UNRESOLVED";
  const source = item.resolutionSource ?? item.source;
  if (source === "target_override") return "TARGET";
  if (source === "cli_resolved") return "RESOLVED";
  if (source === "global_default") return "DEFAULT";
  if (source === "lookup") return "LOOKUP";
  if (source === "no_default") return "NO DEFAULT";
  if (source === "outside_files") return "ENV / FILE";
  return "BUNDLE";
}

/** A value as the picked target resolves it; unchanged when no target is picked or it isn't text. */
export function displayResolvedValue<T>(value: T, parsedBundle: Bundle, targetName: Target): T | string {
  if (typeof value !== "string" || !targetName) return value;
  return resolveExpressionForTarget(value, parsedBundle, targetName).value;
}

export interface PanelItem {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  taskId: string | undefined;
  kind: string | undefined;
  severity: "error" | "warning" | undefined;
}

/** A task's problems as its box on the graph shows them, so search and the Tasks panel agree with it. */
function taskProblemsFor(tasks: readonly TaskNode[], parsedBundle: Bundle, targetName: Target, inspectorIssues: readonly TaskIssue[]) {
  const issues = inspectorIssues as readonly TaskProblemIssue[];
  const problemsByTask = taskProblemCounts(issues);
  return new Map(tasks.map((task) => [task.id, taskBoxProblems(task, parsedBundle, targetName, issues, problemsByTask)]));
}

const SEVERITY_OF_TONE: Record<TaskProblemTone, PanelItem["severity"]> = { error: "error", warning: "warning", none: undefined };

interface Collected {
  title: string;
  kind?: string | undefined;
  taskIds: Set<string>;
  detail?: string | undefined;
  status?: FileStatus;
  taskTypeLabel?: string | undefined;
  unresolved?: boolean;
  value?: unknown;
  resolutionSource?: string;
  computeType?: string;
  unusedInJob?: boolean;
}

export function buildStatPanelItems(
  graph: GraphLike,
  jobNode: { id: string } | null | undefined,
  parsedBundle: Bundle,
  targetName: Target,
  validationIssues: readonly ValidationIssue[] | null | undefined,
  inspectorIssues: readonly TaskIssue[] | undefined,
): Record<"tasks" | "files" | "pipelines" | "variables" | "secrets" | "compute", PanelItem[]> & { issues: IssueItem[] } {
  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  const problems = taskProblemsFor(tasks, parsedBundle, targetName, inspectorIssues ?? []);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const files = new Map<string | undefined, Collected>();
  const pipelines = new Map<string, Collected>();
  const variables = new Map<string, Collected>();
  const secrets = new Map<string, Collected>();
  const compute = new Map<string, Collected>();

  function addTaskToMap<K>(map: Map<K, Collected>, key: K, base: Omit<Collected, "taskIds">, taskId: string): Collected {
    const item = map.get(key) ?? { ...base, taskIds: new Set<string>() };
    item.taskIds.add(taskId);
    map.set(key, item);
    return item;
  }

  for (const task of tasks) {
    if (isPipelineTask(task)) {
      addTaskToMap(
        pipelines,
        task.subtitle ?? task.displayName,
        { title: task.subtitle ?? task.displayName, kind: "pipeline", taskTypeLabel: task.taskTypeLabel },
        task.id,
      );
    }

    for (const ref of task.taskData?.fileReferences ?? []) {
      const status = getFileStatus(ref);
      const key = ref.resolvedPath ?? ref.path;
      const existing = files.get(key);
      const statusToKeep = existing?.status?.key === "missing" ? existing.status : status;
      const item = addTaskToMap(
        files,
        key,
        { title: basename(ref.path) || (ref.path as string), detail: ref.path, kind: "file", status: statusToKeep },
        task.id,
      );
      item.status = statusToKeep;
    }

    for (const ref of task.taskData?.variableReferences ?? []) {
      const resolution = resolveVariableForTarget(parsedBundle, ref.variableName, targetName);
      const unresolved = resolution.status === "unresolved";
      const item = addTaskToMap(
        variables,
        ref.variableName,
        { title: ref.variableName, kind: "variable", unresolved, value: resolution.value, resolutionSource: resolution.source },
        task.id,
      );
      item.unresolved ||= unresolved;
      item.value ??= resolution.value;
      item.resolutionSource = resolution.source;
    }
  }

  const definedVariableNames = getDefinedVariableNames(parsedBundle);
  for (const variableName of definedVariableNames) {
    if (variables.has(variableName)) continue;
    const resolution = resolveVariableForTarget(parsedBundle, variableName, targetName);
    variables.set(variableName, {
      title: variableName,
      kind: "variable",
      taskIds: new Set(),
      unusedInJob: true,
      value: resolution.value,
      unresolved: resolution.status === "unresolved",
      resolutionSource: resolution.source,
    });
  }

  for (const edge of graph.edges) {
    if (!taskIds.has(edge.source)) continue;
    const task = taskById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!task || !target) continue;

    if (target.nodeType === "cluster" || target.nodeType === "warehouse") {
      const data = target.data as { expression?: unknown } | undefined;
      addTaskToMap(
        compute,
        target.id,
        {
          title: displayResolvedValue(data?.expression ?? target.displayName, parsedBundle, targetName) as string,
          kind: target.kind,
          computeType: target.nodeType,
        },
        task.id,
      );
    }

    // {{secrets/scope/key}} in the task's cluster config links the task to the scope directly.
    if (target.nodeType === "secret_scope") {
      addTaskToMap(secrets, target.id, { title: target.displayName, kind: "secret_scope", detail: "Cluster config" }, task.id);
    }

    if (target.nodeType === "file") {
      for (const fileEdge of graph.edges) {
        if (fileEdge.source !== target.id) continue;
        const fileTarget = nodeById.get(fileEdge.target);
        if (fileTarget?.nodeType !== "secret_scope") continue;
        addTaskToMap(
          secrets,
          fileTarget.id,
          { title: fileTarget.displayName, kind: "secret_scope", detail: target.displayName },
          task.id,
        );
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.nodeType !== "secret_scope" || node.resourceGroup !== "secret_scopes" || secrets.has(node.id)) continue;
    secrets.set(node.id, { title: node.displayName, kind: "secret_scope", taskIds: new Set(), unusedInJob: true });
  }

  function fromMap(map: Map<unknown, Collected>, group: string, subtitleFor: (item: Collected, taskCountLabel: string) => string): PanelItem[] {
    return [...map.values()]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((item) => {
        const taskList = [...item.taskIds];
        const taskCountLabel = `${taskList.length} ${taskList.length === 1 ? "task" : "tasks"}`;
        return {
          id: `${group}:${item.title}`,
          group: item.unusedInJob ? "Defined, Not Used By This Job" : group,
          title: item.title,
          subtitle: subtitleFor(item, taskCountLabel),
          taskId: item.unusedInJob ? undefined : taskList[0],
          kind: item.kind,
          severity: item.status?.key === "missing" || item.unresolved ? "error" : undefined,
        };
      });
  }

  return {
    tasks: tasks
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((task) => ({
        id: `task:${task.id}`,
        group: "Tasks",
        title: task.displayName,
        subtitle: task.taskTypeLabel ?? "Task",
        taskId: task.id,
        kind: task.kind,
        severity: SEVERITY_OF_TONE[problems.get(task.id)!.problemTone],
      })),
    files: fromMap(files, "Files", (item, taskCountLabel) => `${item.status?.label ?? "FILE"} · ${taskCountLabel}`),
    pipelines: fromMap(pipelines, "Pipelines", (item, taskCountLabel) => `${item.taskTypeLabel ?? "Pipeline"} · ${taskCountLabel}`),
    variables: fromMap(variables, "Variables", (item, taskCountLabel) =>
      item.unusedInJob ? "Not used by this job" : `${variableResolutionLabel(item)} · ${taskCountLabel}`,
    ),
    secrets: fromMap(secrets, "Secret Scopes", (item, taskCountLabel) => (item.unusedInJob ? "Defined resource" : taskCountLabel)),
    compute: fromMap(compute, "Compute", (item, taskCountLabel) => `${item.computeType ?? "compute"} · ${taskCountLabel}`),
    issues: buildIssueItems(graph, jobNode, parsedBundle, targetName, validationIssues, inspectorIssues),
  };
}

export interface SearchItem {
  id: string;
  label: string;
  subtitle: string;
  kind: string | undefined;
  taskId: string;
  issueCount: number;
  problemTone: TaskProblemTone;
}

/** The search box's items: the job's tasks, each with the problem count its box shows. */
export function buildSearchItems(
  graph: GraphLike | null | undefined,
  jobNode: { id: string } | null | undefined,
  parsedBundle: Bundle,
  targetName: Target,
  inspectorIssues: readonly TaskIssue[] = [],
): SearchItem[] {
  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  const problems = taskProblemsFor(tasks, parsedBundle, targetName, inspectorIssues);
  return tasks.map((task) => {
    const { issueCounts, problemTone } = problems.get(task.id)!;
    return {
      id: `task:${task.id}`,
      label: task.displayName,
      subtitle: task.taskTypeLabel ?? "Task",
      kind: task.kind,
      taskId: task.id,
      issueCount: issueCounts.total,
      problemTone,
    };
  });
}
