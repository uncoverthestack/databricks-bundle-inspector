/** How the last check of one bundle ended. */
export type BundleCheckState = "checked" | "cli_missing" | "failed";

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

/**
 * What the status bar item says for the bundles in the open folders, or `undefined`
 * to hide it when none was found.
 *
 * @param states The last check of each bundle.
 * @param problemCount Errors and warnings the checks put in the Problems panel.
 */
export function statusBarView(
  states: readonly BundleCheckState[],
  problemCount: number,
): StatusBarView | undefined {
  if (states.length === 0) return undefined;

  if (states.includes("checked")) {
    const bundles = states.length === 1 ? "this bundle" : `${states.length} bundles`;
    if (problemCount === 0) {
      return {
        text: "$(pass) Bundle: no problems",
        tooltip: `Databricks Bundle Inspector checked ${bundles} and found no problems. Click to open the graph.`,
        warning: false,
      };
    }
    const problems = problemCount === 1 ? "1 problem" : `${problemCount} problems`;
    return {
      text: `$(warning) Bundle: ${problems}`,
      tooltip: `Databricks Bundle Inspector found ${problems} in ${bundles}. They are listed in the Problems panel. Click to open the graph with the issues.`,
      warning: false,
    };
  }

  if (states.includes("cli_missing")) {
    return {
      text: "$(warning) Databricks CLI not found",
      tooltip:
        "Databricks Bundle Inspector needs the Databricks CLI to check this bundle, and could not find it. Nothing is being checked. Click for the install steps.",
      warning: true,
    };
  }

  return {
    text: "$(warning) Bundle: not checked",
    tooltip: "Databricks Bundle Inspector could not check this bundle. Click to see why.",
    warning: false,
  };
}

/**
 * The bundle a click on the item is about: the one holding the open file, the deepest
 * when bundles are nested, otherwise the first one found.
 */
export function bundleForFile(
  bundleRoots: readonly string[],
  filePath: string | undefined,
  separator: string,
): string | undefined {
  const holding = bundleRoots
    .filter((root) => filePath === root || filePath?.startsWith(root + separator))
    .sort((a, b) => b.length - a.length);
  return holding[0] ?? bundleRoots[0];
}
