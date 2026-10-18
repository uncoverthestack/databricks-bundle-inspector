/**
 * How the last check of one bundle ended. `pending` is a bundle that was found but not
 * checked yet: a folder with many bundles only gets its first few checked on open.
 */
export type BundleCheckState = "checked" | "cli_missing" | "failed" | "pending";

export interface StatusBarView {
  text: string;
  tooltip: string;
  /** Highlighted when the extension cannot do its job at all. */
  warning: boolean;
}

/** `CLI_NOT_FOUND` and `CLI_NOT_EXECUTABLE` both mean no check could run. */
export function checkStateOf(
  result: { ok: true } | { ok: false; error: { errorCode?: string } },
): BundleCheckState {
  if (result.ok) return "checked";
  const code = result.error.errorCode;
  return code === "CLI_NOT_FOUND" || code === "CLI_NOT_EXECUTABLE" ? "cli_missing" : "failed";
}

export interface BundleCount {
  /** Errors and warnings. */
  problems: number;
  /** Information-level entries: suggestions, not faults. */
  notes: number;
  /** How many of those have no file to point at, so they show in the graph only. */
  graphOnly?: number;
}

const plural = (count: number, word: string) => (count === 1 ? `1 ${word}` : `${count} ${word}s`);

/**
 * One bundle's result in a few words, as the item and the bundle list show it.
 * A check that failed but still reported errors shows those errors.
 */
export function bundleSummary(state: BundleCheckState | undefined, count: BundleCount): string {
  if (!state || state === "pending") return "not checked yet";
  if (state === "cli_missing") return "Databricks CLI not found";
  if (count.problems > 0) return plural(count.problems, "problem");
  if (state === "failed") return "not checked";
  if (count.notes > 0) return plural(count.notes, "note");
  return "no problems";
}

/**
 * What the status bar item says about one bundle, or `undefined` to hide it when the
 * open folders hold none. With several bundles it is about the one in view, so the
 * count on the item and the issues in the graph are the same.
 *
 * @param state The last check of that bundle.
 * @param count What that check found.
 * @param bundleName The bundle's folder name.
 * @param otherBundles How many more bundles the open folders hold.
 */
export function statusBarView(
  state: BundleCheckState | undefined,
  count: BundleCount,
  bundleName: string,
  otherBundles: number,
): StatusBarView | undefined {
  if (!state) return undefined;
  const summary = bundleSummary(state, count);
  const click =
    otherBundles === 0
      ? "Click to open the graph."
      : `Click to open the graph, or pick one of the ${plural(otherBundles, "other bundle")} in this folder.`;

  if (state === "pending") {
    return {
      text: `$(circle-large-outline) Bundle: ${summary}`,
      tooltip: `Databricks Bundle Inspector has not checked "${bundleName}" yet. In a folder with many bundles only the first few are checked when it opens. Saving one of its files checks it, and so does opening its graph. ${click}`,
      warning: false,
    };
  }

  if (state === "cli_missing") {
    return {
      text: `$(warning) ${summary}`,
      tooltip:
        "Databricks Bundle Inspector needs the Databricks CLI to check this bundle, and could not find it. Nothing is being checked. Click to install it or locate it.",
      warning: true,
    };
  }

  if (count.problems === 0 && state === "failed") {
    return {
      text: `$(warning) Bundle: ${summary}`,
      tooltip: `Databricks Bundle Inspector could not check "${bundleName}". Click to see why.`,
      warning: false,
    };
  }

  if (count.problems === 0 && count.notes === 0) {
    return {
      text: `$(pass) Bundle: ${summary}`,
      tooltip: `Databricks Bundle Inspector checked "${bundleName}" and found no problems. ${click}`,
      warning: false,
    };
  }

  const total = count.problems + count.notes;
  const graphOnly = count.graphOnly ?? 0;
  const where =
    graphOnly === 0
      ? "They are listed in the Problems panel."
      : graphOnly >= total
        ? "They have no file to point at, so they show only in the graph."
        : `${graphOnly} of them ${graphOnly === 1 ? "has" : "have"} no file to point at and ${graphOnly === 1 ? "shows" : "show"} only in the graph. The rest are listed in the Problems panel.`;

  // Notes are suggestions, not faults, but "no problems" would hide that there is something to read.
  if (count.problems === 0) {
    return {
      text: `$(info) Bundle: ${summary}`,
      tooltip: `Databricks Bundle Inspector found no errors or warnings in "${bundleName}", and has ${plural(count.notes, "note")} on it. ${where} ${click}`,
      warning: false,
    };
  }
  const andNotes = count.notes === 0 ? "" : ` and has ${plural(count.notes, "note")} on it`;
  const unfinished = state === "failed" ? " The check could not finish, so there may be more." : "";
  return {
    text: `$(warning) Bundle: ${summary}`,
    tooltip: `Databricks Bundle Inspector found ${plural(count.problems, "problem")} in "${bundleName}"${andNotes}.${unfinished} ${where} ${click}`,
    warning: false,
  };
}

/** The bundles to choose from when the folder holds several: the one in view first. */
export function orderForPicking(
  bundleRoots: readonly string[],
  current: string | undefined,
): string[] {
  return current && bundleRoots.includes(current)
    ? [current, ...bundleRoots.filter((root) => root !== current)]
    : [...bundleRoots];
}

/** The bundle that holds a file, the deepest when bundles are nested. */
export function bundleForFile(
  bundleRoots: readonly string[],
  filePath: string | undefined,
  separator: string,
): string | undefined {
  return bundleRoots
    .filter((root) => filePath === root || filePath?.startsWith(root + separator))
    .sort((a, b) => b.length - a.length)[0];
}
