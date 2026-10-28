/** What the graph shows: one job's tasks, or one pipeline. */
export interface GraphSelection {
  group: "jobs" | "pipelines";
  key: string;
}

/**
 * What the graph shows: the user's pick, else what the extension asked for (the resource
 * under the cursor), else the first job, else the first pipeline. Each only while the
 * bundle still has it. `undefined` when the bundle has neither jobs nor pipelines.
 */
export function resolveSelection(
  jobKeys: string[],
  pipelineKeys: string[],
  userSelection?: GraphSelection,
  initialSelection?: GraphSelection,
): GraphSelection | undefined {
  const exists = (selection?: GraphSelection) =>
    selection !== undefined &&
    (selection.group === "jobs" ? jobKeys : pipelineKeys).includes(selection.key);
  if (exists(userSelection)) return userSelection;
  if (exists(initialSelection)) return initialSelection;
  if (jobKeys.length > 0) return { group: "jobs", key: jobKeys[0]! };
  if (pipelineKeys.length > 0) return { group: "pipelines", key: pipelineKeys[0]! };
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
