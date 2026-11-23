/**
 * The task boxes the job graph draws: each box from the job's flow, with whether it is
 * selected and how it is focused (#500).
 *
 * The graph library redraws only boxes whose object changed. So each box's unselected
 * versions are built once per flow ({@link buildDisplayVariants}), and every click picks from
 * them: a box whose state did not change gets the same object as before, and only the
 * selected box is new. A click in a 1,000-task job then redraws two boxes, not all of them.
 */

export type FocusState = "normal" | "selected" | "related" | "dimmed";

export interface FlowNode {
  id: string;
  data: Record<string, unknown>;
}

export type DisplayNode<N extends FlowNode> = N & {
  selected: boolean;
  data: N["data"] & { focusState: FocusState };
};

export interface DisplayFocus {
  selectedNodeId: string | null;
  /** The tasks a Uses chip or the Issues mode points at, or null when nothing is focused. */
  focusedTaskIds: ReadonlySet<string> | null;
  graphMode: string;
  issueTaskIds: ReadonlySet<string>;
}

type UnselectedState = Exclude<FocusState, "selected">;

/** Each flow node's unselected boxes, built once per flow. */
export type DisplayVariants<N extends FlowNode> = ReadonlyArray<Readonly<Record<UnselectedState, DisplayNode<N>>>>;

function displayNode<N extends FlowNode>(node: N, selected: boolean, focusState: FocusState): DisplayNode<N> {
  return { ...node, selected, data: { ...node.data, focusState } } as DisplayNode<N>;
}

export function buildDisplayVariants<N extends FlowNode>(flowNodes: readonly N[]): DisplayVariants<N> {
  return flowNodes.map((node) => ({
    normal: displayNode(node, false, "normal"),
    related: displayNode(node, false, "related"),
    dimmed: displayNode(node, false, "dimmed"),
  }));
}

export function focusStateOf(nodeId: string, focus: DisplayFocus): FocusState {
  if (!focus.focusedTaskIds) return "normal";
  if (nodeId === focus.selectedNodeId) return "selected";
  if (focus.graphMode === "issues" && focus.issueTaskIds.has(nodeId)) return "related";
  return focus.focusedTaskIds.has(nodeId) ? "related" : "dimmed";
}

/** `variants` must come from {@link buildDisplayVariants} for these same `flowNodes`. */
export function buildDisplayNodes<N extends FlowNode>(
  flowNodes: readonly N[],
  variants: DisplayVariants<N>,
  focus: DisplayFocus,
): DisplayNode<N>[] {
  return flowNodes.map((node, index) => {
    const focusState = focusStateOf(node.id, focus);
    const kept = variants[index];
    if (node.id === focus.selectedNodeId || focusState === "selected" || !kept) {
      return displayNode(node, node.id === focus.selectedNodeId, focusState);
    }
    return kept[focusState];
  });
}
