import { legacyCliVersion } from "../databricksCli/parsing.js";
import type { CliProblem } from "../databricksCli/validateDatabricksCli.js";

/** Why no Databricks CLI could be used, as the last check reported it. */
export interface CliIssue {
  problem: CliProblem;
  /** With `not_databricks_cli`: what that other program printed for `--version`. */
  versionOutput?: string;
}

/** The status bar's words for a CLI that could not be used: short text, then the tooltip. */
function cliIssueWords(issue: CliIssue | undefined): { text: string; tooltip: string } {
  const unchecked = "Databricks Bundle Inspector needs the Databricks CLI to check this bundle. Nothing is being checked.";
  if (issue?.problem === "configured_path_invalid") {
    return {
      text: "Check the cliPath setting",
      tooltip: `The databricksBundleInspector.cliPath setting is not a working Databricks CLI, and none was found elsewhere. ${unchecked} Click to see what to do.`,
    };
  }
  if (issue?.problem === "not_databricks_cli") {
    const legacy = legacyCliVersion(issue.versionOutput ?? "");
    return legacy
      ? {
          text: `Legacy Databricks CLI (${legacy})`,
          tooltip: `The "databricks" command found is the legacy databricks-cli pip package (${legacy}), which can't check bundles. ${unchecked} Click to install the Databricks CLI.`,
        }
      : {
          text: `"databricks" is another program`,
          tooltip: `The "databricks" command found is not the Databricks CLI. ${unchecked} Click to install the Databricks CLI.`,
        };
  }
  return {
    text: "Databricks CLI not found",
    tooltip: `${unchecked} Click to install it or locate it.`,
  };
}

/**
 * How the last check of one bundle ended. `pending` is a bundle that was found but not
 * checked yet: a folder with many bundles only gets its first few checked on open.
 */
export type BundleCheckState = "checked" | "cli_missing" | "failed" | "pending";

export interface StatusBarView {
  text: string;
  tooltip: string;
  /** With several bundles: one line per bundle, shown as a list under the tooltip. */
  tooltipList?: string[];
  /** How many bundles the list leaves out, for a "Show N more" link that opens the picker. */
  tooltipMore?: number;
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
export function bundleSummary(
  state: BundleCheckState | undefined,
  count: BundleCount,
  cliIssue?: CliIssue | undefined,
): string {
  if (!state || state === "pending") return "not checked yet";
  if (state === "cli_missing") return cliIssueWords(cliIssue).text;
  if (count.problems > 0) return plural(count.problems, "problem");
  if (state === "failed") return "not checked";
  if (count.notes > 0) return plural(count.notes, "note");
  return "no problems";
}

/** What a check covered, counted from its graph. */
export interface BundleContents {
  jobs: number;
  /** A `for_each` task counts once: its inner task is not a task of its own. */
  tasks: number;
  pipelines: number;
  /** Local files the tasks point at, each path once. */
  files: number;
}

/** Counts what a check covered from the graph it built. */
export function bundleContents(graph: {
  nodes: ReadonlyArray<{ nodeType: string; resourceGroup?: string; location?: string }>;
}): BundleContents {
  const contents: BundleContents = { jobs: 0, tasks: 0, pipelines: 0, files: 0 };
  for (const node of graph.nodes) {
    if (node.nodeType === "job") contents.jobs++;
    else if (node.nodeType === "task") contents.tasks++;
    else if (node.nodeType === "file" && node.location === "local") contents.files++;
    else if (node.resourceGroup === "pipelines") contents.pipelines++;
  }
  return contents;
}

/** "3 jobs, 12 tasks, 1 pipeline and 8 files", leaving out what there is none of. */
export function describeContents(contents: BundleContents): string {
  const parts = [
    contents.jobs > 0 ? plural(contents.jobs, "job") : undefined,
    contents.tasks > 0 ? plural(contents.tasks, "task") : undefined,
    contents.pipelines > 0 ? plural(contents.pipelines, "pipeline") : undefined,
    contents.files > 0 ? plural(contents.files, "file") : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The one number the item shows next to a clean result: tasks, or pipelines when there are no tasks. */
function contentsLabel(contents: BundleContents | undefined): string {
  if (!contents) return "";
  if (contents.tasks > 0) return ` · ${plural(contents.tasks, "task")}`;
  if (contents.pipelines > 0) return ` · ${plural(contents.pipelines, "pipeline")}`;
  return "";
}

/** One bundle as the status bar sees it. */
export interface BundleStatus {
  /** The bundle's folder name. */
  name: string;
  /** How its last check ended; `undefined` or `pending` when it has not been checked. */
  state: BundleCheckState | undefined;
  /** What that check found. */
  count: BundleCount;
  /** What that check covered, when it built a graph. */
  contents?: BundleContents | undefined;
  /** Why the CLI could not be used, when that is how the check ended. */
  cliIssue?: CliIssue | undefined;
}

/** Whether a bundle's last check says anything about it. A failed check that reported errors does. */
function wasChecked(bundle: BundleStatus): boolean {
  return bundle.state === "checked" || (bundle.state === "failed" && bundle.count.problems > 0);
}

/** How many bundle lines the tooltip lists before it says how many more there are. */
export const TOOLTIP_BUNDLE_LIMIT = 3;

/**
 * What the status bar item says, or `undefined` to hide it when the open folders hold
 * no bundle. With one bundle it is about that bundle and says what was checked. With
 * several it is about the whole folder, so its count agrees with the Problems panel.
 * The tooltip only adds what the text does not already say, so it stays short enough to read.
 *
 * @param bundles Every bundle found in the open folders, in the order found.
 * @param folderCount With several bundles: what they found together, each file counted once.
 */
export function statusBarView(
  bundles: readonly BundleStatus[],
  folderCount?: BundleCount,
): StatusBarView | undefined {
  if (bundles.length === 0) return undefined;
  if (bundles.length === 1) return singleBundleView(bundles[0]!);
  return folderView(bundles, folderCount ?? sumCounts(bundles));
}

function sumCounts(bundles: readonly BundleStatus[]): BundleCount {
  return bundles.reduce<BundleCount>(
    (sum, bundle) => ({
      problems: sum.problems + bundle.count.problems,
      notes: sum.notes + bundle.count.notes,
      graphOnly: (sum.graphOnly ?? 0) + (bundle.count.graphOnly ?? 0),
    }),
    { problems: 0, notes: 0, graphOnly: 0 },
  );
}

function cliMissingView(issue: CliIssue | undefined): StatusBarView {
  const words = cliIssueWords(issue);
  return { text: `$(warning) ${words.text}`, tooltip: words.tooltip, warning: true };
}

function singleBundleView(bundle: BundleStatus): StatusBarView {
  const { name, state, count, contents } = bundle;
  const summary = bundleSummary(state, count, bundle.cliIssue);

  if (!state || state === "pending") {
    return {
      text: `$(circle-large-outline) Bundle: ${summary}`,
      tooltip: "Save a file or open the graph to check it.",
      warning: false,
    };
  }
  if (state === "cli_missing") return cliMissingView(bundle.cliIssue);

  if (count.problems === 0 && state === "failed") {
    return {
      text: `$(warning) Bundle: ${summary}`,
      tooltip: `Databricks Bundle Inspector could not check "${name}". Click to see why.`,
      warning: false,
    };
  }

  const covered = contents ? describeContents(contents) : "";
  const icon = count.problems > 0 ? "$(warning)" : count.notes > 0 ? "$(info)" : "$(pass)";
  const label = count.problems > 0 ? "" : contentsLabel(contents);
  return {
    text: `${icon} Bundle: ${summary}${label}`,
    tooltip: covered ? `Checked ${covered}.` : `Checked "${name}".`,
    warning: false,
  };
}

function folderView(bundles: readonly BundleStatus[], count: BundleCount): StatusBarView {
  // The CLI is the same for every bundle; without it nothing in the folder is checked.
  const cliMissing = bundles.find((bundle) => bundle.state === "cli_missing");
  if (cliMissing) return cliMissingView(cliMissing.cliIssue);

  const total = bundles.length;
  const checked = bundles.filter(wasChecked).length;
  const more = bundles.length - TOOLTIP_BUNDLE_LIMIT;
  const tooltip = { tooltip: "", tooltipList: bundleLines(bundles), ...(more > 0 ? { tooltipMore: more } : {}) };

  if (checked === 0) {
    return { text: `$(circle-large-outline) ${total} bundles: not checked yet`, ...tooltip, warning: false };
  }

  const scope = checked === total ? `${total} bundles` : `${checked} of ${total} bundles checked`;
  const [icon, result] =
    count.problems > 0
      ? ["$(warning)", plural(count.problems, "problem")]
      : count.notes > 0
        ? ["$(info)", plural(count.notes, "note")]
        : ["$(pass)", "no problems"];
  return { text: `${icon} ${scope}: ${result}`, ...tooltip, warning: false };
}

/** The first few bundles, those with problems first, then the rest in the order found. */
function bundleLines(bundles: readonly BundleStatus[]): string[] {
  const ordered = [
    ...bundles.filter((bundle) => bundle.count.problems > 0),
    ...bundles.filter((bundle) => bundle.count.problems === 0),
  ];
  return ordered
    .slice(0, TOOLTIP_BUNDLE_LIMIT)
    .map((bundle) => `${bundle.name}: ${bundleSummary(bundle.state, bundle.count, bundle.cliIssue)}`);
}

/**
 * The item while a check runs longer than a moment: the same result, with a turning
 * icon in place of its own. Without the motion when the user asked VS Code for less.
 */
export function checkingView(view: StatusBarView, reduceMotion: boolean): StatusBarView {
  const icon = reduceMotion ? "$(sync)" : "$(sync~spin)";
  return {
    ...view,
    text: view.text.replace(/^\$\([^)]+\)/, icon),
    tooltip: view.tooltip ? `Checking now. ${view.tooltip}` : "Checking now.",
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
