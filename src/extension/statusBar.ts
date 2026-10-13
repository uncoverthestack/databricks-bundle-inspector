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
 * What the status bar item says about one bundle, or `undefined` to hide it when the
 * open folders hold none. With several bundles it is about the one a click would open,
 * so the count on the item and the issues in the graph are the same.
 *
 * @param state The last check of that bundle.
 * @param problemCount Errors and warnings that check put in the Problems panel.
 * @param bundleName The bundle's folder name.
 * @param otherBundles How many more bundles the open folders hold.
 */
export function statusBarView(
  state: BundleCheckState | undefined,
  problemCount: number,
  bundleName: string,
  otherBundles: number,
): StatusBarView | undefined {
  if (!state) return undefined;
  const others =
    otherBundles === 0
      ? ""
      : ` This folder has ${otherBundles === 1 ? "1 more bundle" : `${otherBundles} more bundles`}. Open one of its files to see its count.`;

  if (state === "cli_missing") {
    return {
      text: "$(warning) Databricks CLI not found",
      tooltip:
        "Databricks Bundle Inspector needs the Databricks CLI to check this bundle, and could not find it. Nothing is being checked. Click for the install steps.",
      warning: true,
    };
  }

  if (state === "failed") {
    return {
      text: "$(warning) Bundle: not checked",
      tooltip: `Databricks Bundle Inspector could not check "${bundleName}". Click to see why.${others}`,
      warning: false,
    };
  }

  if (problemCount === 0) {
    return {
      text: "$(pass) Bundle: no problems",
      tooltip: `Databricks Bundle Inspector checked "${bundleName}" and found no problems. Click to open the graph.${others}`,
      warning: false,
    };
  }
  const problems = problemCount === 1 ? "1 problem" : `${problemCount} problems`;
  return {
    text: `$(warning) Bundle: ${problems}`,
    tooltip: `Databricks Bundle Inspector found ${problems} in "${bundleName}". They are listed in the Problems panel. Click to open the graph with the issues.${others}`,
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
