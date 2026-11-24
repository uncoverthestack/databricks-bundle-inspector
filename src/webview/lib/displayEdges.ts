/**
 * The lines the job graph draws, with how each one is shown (issue 554).
 *
 * At rest every line is grey: blue means focus or a link and green means ok across the panel
 * (#424), so a blue line looked clickable and a green True read as "good". Colour goes to
 * focus only:
 * - the selected task's own lines, in and out, turn blue (the focus colour), others stay grey;
 * - a Uses chip or the Issues filter lights the lines between the tasks it lights, and fades
 *   the rest, as before.
 *
 * A line whose look did not change keeps its object, so the graph redraws only lines that did
 * (#500): selecting a task in a 1,000-task job redraws that task's few lines.
 */
import { UI_COLOR } from "./vscodeTheme.js";

export interface FlowEdgeLike {
  source: string;
  target: string;
  style?: Record<string, unknown> | undefined;
  markerEnd?: Record<string, unknown> | string | undefined;
  animated?: boolean | undefined;
}

export interface EdgeFocus {
  selectedNodeId: string | null;
  /** Tasks lit by a Uses chip or the Issues filter, or null. */
  focusedTaskIds: ReadonlySet<string> | null;
  /** Set when the light comes from a Uses chip: tasks sharing a warehouse aren't linked by it. */
  usesTaskIds: ReadonlySet<string> | null;
}

function withLook<E extends FlowEdgeLike>(edge: E, look: { color?: string; opacity?: number; width?: number; animated?: boolean }): E {
  const marker = typeof edge.markerEnd === "object" ? edge.markerEnd : undefined;
  return {
    ...edge,
    animated: look.animated ?? false,
    style: {
      ...edge.style,
      ...(look.color ? { stroke: look.color } : {}),
      ...(look.width ? { strokeWidth: look.width } : {}),
      ...(look.opacity !== undefined ? { opacity: look.opacity } : {}),
    },
    ...(marker && look.color ? { markerEnd: { ...marker, color: look.color } } : {}),
  };
}

export function displayEdge<E extends FlowEdgeLike>(edge: E, focus: EdgeFocus): E {
  const { selectedNodeId, focusedTaskIds, usesTaskIds } = focus;
  // The selected task's own lines, in and out. Its dashes stay, so False still reads as False.
  if (selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId)) {
    return withLook(edge, { color: UI_COLOR.accent, width: 2.8 });
  }
  if (!focusedTaskIds) return edge;
  const lit = !usesTaskIds && focusedTaskIds.has(edge.source) && focusedTaskIds.has(edge.target);
  return lit ? withLook(edge, { color: UI_COLOR.accent, width: 2.8, animated: true }) : withLook(edge, { opacity: 0.18 });
}

export function buildDisplayEdges<E extends FlowEdgeLike>(flowEdges: readonly E[], focus: EdgeFocus): E[] {
  return flowEdges.map((edge) => displayEdge(edge, focus));
}
