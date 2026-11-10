/** One job's tasks, or one pipeline. */
export interface GraphSelection {
  group: "jobs" | "pipelines";
  key: string;
}

/** Where the panel is: the bundle overview, or inside one job or pipeline. */
export type PanelPlace = GraphSelection | { group: "overview" };

/** The picker's value for the bundle overview. */
export const OVERVIEW_VALUE = "overview";

/**
 * The job or pipeline the panel is inside, or `undefined` for the bundle overview.
 * The user's pick comes first, else what the extension asked for (the resource under
 * the cursor), each only while the bundle still has it. Otherwise the panel shows the
 * overview: every bundle opens there.
 */
export function resolveSelection(
  jobKeys: string[],
  pipelineKeys: string[],
  userSelection?: PanelPlace,
  initialSelection?: GraphSelection,
): GraphSelection | undefined {
  const exists = (selection?: PanelPlace): selection is GraphSelection =>
    selection !== undefined &&
    selection.group !== "overview" &&
    (selection.group === "jobs" ? jobKeys : pipelineKeys).includes(selection.key);
  if (userSelection?.group === "overview") return undefined;
  if (exists(userSelection)) return userSelection;
  if (exists(initialSelection)) return initialSelection;
  return undefined;
}

/** A picker option's value. The group comes first, so a key with a `:` in it still reads back. */
export function selectionValue(selection: GraphSelection): string {
  return `${selection.group}:${selection.key}`;
}

export function parseSelectionValue(value: string): GraphSelection | undefined {
  const at = value.indexOf(":");
  const group = value.slice(0, at);
  if (at < 0 || (group !== "jobs" && group !== "pipelines")) return undefined;
  return { group, key: value.slice(at + 1) };
}
