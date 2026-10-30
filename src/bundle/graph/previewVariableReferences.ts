import type { BundleGraph, BundleGraphNode, ParsedBundleConfig } from "./bundleGraph.js";
import type { VariableReference } from "../resources/task.js";
import { resolveExpressionForTarget } from "../targetResolution.js";

/** What a target's task deployed, to keep only the preview's references it agrees with. */
export interface TargetCheck {
  /** The bundle as the CLI gave it for the target: values, no `${var...}`. */
  deployed: ParsedBundleConfig;
  /** The structural preview's bundle: the settings as written. */
  preview: ParsedBundleConfig;
  /** Variables and targets to resolve with, as the panel does. */
  resolution: ParsedBundleConfig;
  target: string;
}

/**
 * The target's graph with each task's variable references taken from the structural
 * preview (#230). With a target, the CLI replaces every `${var...}` by its value before the
 * inspector reads the bundle, so the target's graph finds no references, and the task
 * panel's and header's Variables lists come out empty. The preview keeps them.
 *
 * The preview doesn't apply a target's own overrides, so a reference is kept only when its
 * setting, resolved for the target, gives what the target deployed there (#332): when they
 * differ the target overrode it, and the reference would name the wrong variable and value.
 * One that can't be compared (a whole complex value, a variable only the CLI resolves, such
 * as a lookup) is kept. Tasks are matched by id (job and task keys, the same in both); a task
 * only one of them has keeps what it had. The variable nodes and "uses" edges the kept
 * references make come along. The graph passed in is not changed.
 */
export function withPreviewVariableReferences(target: BundleGraph, preview: BundleGraph, check: TargetCheck): BundleGraph {
  const previewTasks = new Map(preview.nodes.filter((node) => node.taskData).map((node) => [node.id, node]));
  const nodes = target.nodes.map((node): BundleGraphNode => {
    const from = previewTasks.get(node.id)?.taskData;
    if (!node.taskData || !from) return node;
    const agrees = (ref: VariableReference) => agreesWithTarget(ref, node.id, check);
    return {
      ...node,
      taskData: {
        ...node.taskData,
        variableReferences: from.variableReferences.filter(agrees),
        ...(node.taskData.nestedTask && from.nestedTask
          ? { nestedTask: { ...node.taskData.nestedTask, variableReferences: from.nestedTask.variableReferences.filter(agrees) } }
          : {}),
      },
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(target.edges.map((edge) => edge.id));
  const used = new Set(
    nodes.flatMap((node) =>
      [...(node.taskData?.variableReferences ?? []), ...(node.taskData?.nestedTask?.variableReferences ?? [])].map(
        (ref) => `${node.id}->uses->var:${ref.variableName}`,
      ),
    ),
  );
  const extraNodes: BundleGraphNode[] = [];
  const extraEdges = preview.edges.filter((edge) => {
    if (edge.kind !== "uses" || !edge.target.startsWith("var:") || !nodeIds.has(edge.source) || edgeIds.has(edge.id)) {
      return false;
    }
    if (!used.has(edge.id)) return false;
    const variable = preview.nodes.find((node) => node.id === edge.target);
    if (variable && !nodeIds.has(variable.id)) {
      extraNodes.push(variable);
      nodeIds.add(variable.id);
    }
    return true;
  });
  return { ...target, nodes: [...nodes, ...extraNodes], edges: [...target.edges, ...extraEdges] };
}

/** Whether the target deployed what this preview reference's setting resolves to. */
function agreesWithTarget(ref: VariableReference, taskId: string, check: TargetCheck): boolean {
  const ids = /^resources\.jobs\.([^.]+)\.tasks\.(.+)$/.exec(taskId);
  const prefix = ids ? `tasks.${ids[2]}.` : undefined;
  if (!ids || !prefix || !ref.yamlPath.startsWith(prefix)) return true;
  const steps = pathSteps(ref.yamlPath.slice(prefix.length));
  const written = valueAt(taskOf(check.preview, ids[1]!, ids[2]!), steps);
  // Nothing to compare with: kept, as before.
  if (typeof written !== "string") return true;
  const deployed = valueAt(taskOf(check.deployed, ids[1]!, ids[2]!), steps);
  if (deployed === undefined) return false;
  if (typeof deployed === "object") return true;
  const resolved = resolveExpressionForTarget(written, check.resolution, check.target);
  if (resolved.unresolvedVariables.length > 0) return true;
  return resolved.value === String(deployed);
}

function taskOf(bundle: ParsedBundleConfig, jobKey: string, taskKey: string): unknown {
  const tasks = (bundle.resources?.jobs?.[jobKey] as { tasks?: Array<{ task_key?: string }> } | undefined)?.tasks;
  return Array.isArray(tasks) ? tasks.find((task) => task?.task_key === taskKey) : undefined;
}

/** `notebook_task.base_parameters.x` and `parameters[0]` as keys and indexes. */
function pathSteps(path: string): Array<string | number> {
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
}

function valueAt(value: unknown, steps: Array<string | number>): unknown {
  let current = value;
  for (const step of steps) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}
