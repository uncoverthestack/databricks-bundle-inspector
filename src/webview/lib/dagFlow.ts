/**
 * The job graph's layout, left to right: one column per dependency level, each task in the
 * row nearest the tasks it depends on, with the lines between them. Moved from App.jsx with
 * no change (#392).
 */
// A type only: React Flow 13 ships as ES modules alone, which the unit tests (Jest) can't load.
import type { MarkerType } from "@xyflow/react";
import type { ParsedBundleConfig } from "../../bundle/graph/bundleGraph.js";
import { isDrawnDependency, taskLevels } from "./taskLevels.js";
import { taskProblemCounts, type TaskProblemIssue } from "./taskProblems.js";
import { taskBoxProblems, type GraphLike, type TaskNode } from "./taskIssues.js";
import { UI_COLOR } from "./vscodeTheme.js";

export const NODE_W = 260;
export const NODE_H = 48;
const LEVEL_GAP = 340;
const V_GAP = 76;
const START_X = 60;

type Bundle = ParsedBundleConfig | null | undefined;
type Target = string | null | undefined;
type GraphEdge = GraphLike["edges"][number];

/** A task name short enough for its box. */
export function compactTaskName(name: string): string {
  if (name.length <= 26) return name;
  return `${name.slice(0, 24)}...`;
}

/** The `outcome` of a condition task's branch, as its line's label: `True`, `False` or as written. */
export function dependencyOutcomeLabel(edge: { data?: Record<string, unknown> } | null | undefined): string | null {
  const outcome = edge?.data?.outcome;
  if (typeof outcome !== "string" || outcome.trim().length === 0) return null;
  const normalized = outcome.trim();
  if (normalized.toLowerCase() === "true") return "True";
  if (normalized.toLowerCase() === "false") return "False";
  return normalized;
}

/**
 * A line's colours: grey for every line (issue 554). Blue means focus or a link and green
 * means ok (#424), so neither marks a plain dependency or a True branch. True and False are
 * told apart by their labels, and False is also dashed, so no colour is needed.
 */
export function dependencyOutcomeTone(label: string | null | undefined) {
  const dashed = label?.toLowerCase() === "false";
  return {
    stroke: UI_COLOR.muted,
    labelColor: UI_COLOR.fg,
    labelBg: UI_COLOR.widget,
    labelBorder: UI_COLOR.muted,
    ...(dashed ? { dash: "5 4" } : {}),
  };
}

export function buildDagFlow(
  graph: GraphLike,
  selectedJobKey: string | null | undefined,
  parsedBundle: Bundle,
  targetName: Target,
  inspectorIssues: readonly TaskProblemIssue[] = [],
) {
  // Each box reads the problem list Issues uses, so the boxes add up to its count (issue 393).
  const problemsByTask = taskProblemCounts(inspectorIssues);
  const flowNodes: Array<Record<string, unknown> & { id: string }> = [];
  const flowEdges: Array<Record<string, unknown> & { id: string | undefined }> = [];
  const empty = { flowNodes, flowEdges, jobNode: null as GraphLike["nodes"][number] | null, taskCount: 0 };

  const jobNode = graph.nodes.find((n) => n.nodeType === "job" && (!selectedJobKey || n.resourceKey === selectedJobKey));
  if (!jobNode) return empty;

  const allTasks = graph.nodes.filter((n) => n.nodeType === "task" && n.parentId === jobNode.id);
  if (allTasks.length === 0) return { ...empty, jobNode };

  const depEdges = graph.edges.filter((e) => e.kind === "depends_on" && allTasks.some((t) => t.id === e.target));

  // Topological level = max distance from any root
  const levelCache = taskLevels(
    allTasks.map((t) => t.id),
    depEdges,
  );

  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const taskIds = new Set(allTasks.map((task) => task.id));
  const incomingByTask = new Map<string, string[]>(allTasks.map((task) => [task.id, []]));
  const branchOutcomesByTask = new Map<string, string[]>(allTasks.map((task) => [task.id, []]));
  for (const edge of depEdges) {
    if (!taskIds.has(edge.source) || !taskIds.has(edge.target)) continue;
    incomingByTask.get(edge.target)?.push(edge.source);
    const outcomeLabel = dependencyOutcomeLabel(edge);
    if (outcomeLabel) branchOutcomesByTask.get(edge.source)?.push(outcomeLabel);
  }

  // Group by level, sort within level alphabetically.
  const byLevel = new Map<number, TaskNode[]>();
  allTasks.forEach((t) => {
    const lv = levelCache.get(t.id) ?? 0;
    const arr = byLevel.get(lv) ?? [];
    arr.push(t);
    byLevel.set(lv, arr);
  });
  byLevel.forEach((arr) => arr.sort((a, b) => a.displayName.localeCompare(b.displayName)));

  const rowByTask = new Map<string, number>();
  const occupiedRowsByLevel = new Map<number, Set<number>>();

  function isRowAvailable(levelIndex: number, row: number): boolean {
    return !(occupiedRowsByLevel.get(levelIndex) ?? new Set()).has(row);
  }

  function claimNearestRow(levelIndex: number, preferredRow: number): number {
    const occupied = occupiedRowsByLevel.get(levelIndex) ?? new Set<number>();
    let offset = 0;
    for (;;) {
      const candidates = offset === 0 ? [preferredRow] : [preferredRow + offset, preferredRow - offset];
      for (const candidate of candidates) {
        if (candidate < 0) continue;
        if (!occupied.has(candidate)) {
          occupied.add(candidate);
          occupiedRowsByLevel.set(levelIndex, occupied);
          return candidate;
        }
      }
      offset += 1;
    }
  }

  const levelIndexes = [...byLevel.keys()].sort((a, b) => a - b);
  let nextRootRow = 0;
  for (const levelIndex of levelIndexes) {
    for (const task of byLevel.get(levelIndex) ?? []) {
      const incomingRows = (incomingByTask.get(task.id) ?? [])
        .map((id) => rowByTask.get(id))
        .filter((row): row is number => typeof row === "number")
        .sort((a, b) => a - b);

      let preferredRow: number | undefined;
      if (incomingRows.length === 1) {
        preferredRow = incomingRows[0];
      } else if (incomingRows.length > 1) {
        preferredRow = incomingRows[Math.floor(incomingRows.length / 2)];
      } else {
        while (!isRowAvailable(levelIndex, nextRootRow)) nextRootRow += 1;
        preferredRow = nextRootRow;
        nextRootRow += 1;
      }

      rowByTask.set(task.id, claimNearestRow(levelIndex, preferredRow ?? 0));
    }
  }

  const maxRow = Math.max(...rowByTask.values(), 0);
  const canvasH = (maxRow + 1) * V_GAP;

  byLevel.forEach((tasks, lv) => {
    const x = START_X + lv * LEVEL_GAP;

    tasks.forEach((task) => {
      const row = rowByTask.get(task.id) ?? 0;
      flowNodes.push({
        id: task.id,
        type: "task",
        position: { x, y: (canvasH - NODE_H) / 2 + (row - maxRow / 2) * V_GAP },
        width: NODE_W,
        height: NODE_H,
        initialWidth: NODE_W,
        initialHeight: NODE_H,
        data: {
          name: compactTaskName(task.displayName),
          fullName: task.displayName,
          kind: task.kind,
          typeLabel: task.taskTypeLabel,
          subtitle: task.subtitle,
          branchOutcomes: [...new Set(branchOutcomesByTask.get(task.id) ?? [])],
          ...taskBoxProblems(task, parsedBundle, targetName, inspectorIssues, problemsByTask),
        },
      });
    });
  });

  depEdges.forEach((e: GraphEdge) => {
    if (!taskById.has(e.source) || !isDrawnDependency(e, levelCache)) return;
    const outcomeLabel = dependencyOutcomeLabel(e);
    const outcomeTone = dependencyOutcomeTone(outcomeLabel);
    flowEdges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "straight",
      ...(outcomeLabel
        ? {
            label: outcomeLabel,
            labelStyle: { fill: outcomeTone.labelColor, fontSize: 11, fontWeight: 700 },
            labelBgStyle: { fill: outcomeTone.labelBg, stroke: outcomeTone.labelBorder, strokeWidth: 1 },
            labelBgPadding: [6, 4],
            labelBgBorderRadius: 4,
          }
        : {}),
      style: { stroke: outcomeTone.stroke, strokeWidth: 2, ...(outcomeTone.dash ? { strokeDasharray: outcomeTone.dash } : {}) },
      markerEnd: { type: "arrowclosed" as MarkerType.ArrowClosed, width: 14, height: 14, color: outcomeTone.stroke },
    });
  });

  return { flowNodes, flowEdges, jobNode, taskCount: allTasks.length };
}
