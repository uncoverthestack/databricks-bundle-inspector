import { LineCounter, parseDocument } from "yaml";
import { anchorsOf, entries } from "../bundle/variableSources.js";
import { isOlderThanSupported, legacyCliVersion, MIN_SUPPORTED_CLI_VERSION } from "../databricksCli/parsing.js";
import {
  bundleSummary,
  describeContents,
  type BundleCheckState,
  type BundleContents,
  type BundleCount,
  type CliIssue,
} from "./statusBar.js";

/**
 * What the sidebar shows, worked out from what the checks found. No VS Code types here,
 * so the wording and the states can be tested; `sidebarView.ts` turns rows into tree items.
 */

/** A row's status icon. The view maps each one to a VS Code icon and theme colour. */
export type SidebarStatus = "checking" | "pending" | "passed" | "errors" | "problems" | "failed" | "cli_missing";

/** One bundle, as the status bar sees it, plus what only the sidebar shows. */
export interface SidebarBundle {
  root: string;
  name: string;
  /** Where the bundle is, from its workspace folder, for the tooltip. */
  displayPath: string;
  state: BundleCheckState | undefined;
  count: BundleCount;
  contents: BundleContents | undefined;
  cliIssue: CliIssue | undefined;
  /** A check of this bundle is running now. */
  checking: boolean;
  /** The targets the bundle's last check listed. Empty before its first check. */
  targets: readonly string[];
  /** Where the bundle is, when another bundle has the same folder name (see {@link pathHints}). */
  pathHint?: string;
  /** Set when this bundle is the one open in the graph with a real target picked. */
  graphTarget?: { target: string; fellBack: boolean };
}

export interface BundleRow {
  label: string;
  description: string;
  tooltip: string;
  status: SidebarStatus;
}

export function bundleStatus(bundle: SidebarBundle): SidebarStatus {
  if (bundle.checking) return "checking";
  if (!bundle.state || bundle.state === "pending") return "pending";
  if (bundle.state === "cli_missing") return "cli_missing";
  // The most severe one decides, as in the Problems panel: one error is red.
  if (bundle.count.problems > 0) return (bundle.count.errors ?? 0) > 0 ? "errors" : "problems";
  return bundle.state === "failed" ? "failed" : "passed";
}

const plural = (count: number, word: string) => (count === 1 ? `1 ${word}` : `${count} ${word}s`);

/** What the last check covered, short enough for a row: `3 jobs · 11 tasks`. Local files stay in the tooltip. */
export function compactContents(contents: BundleContents | undefined): string {
  if (!contents) return "";
  return [
    contents.jobs > 0 ? plural(contents.jobs, "job") : undefined,
    contents.tasks > 0 ? plural(contents.tasks, "task") : undefined,
    contents.pipelines > 0 ? plural(contents.pipelines, "pipeline") : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/**
 * Where each bundle is, for bundles whose folder name another bundle shares: the bundle's
 * folder from its workspace folder (`teams/sales/analytics`). Other bundles get none.
 */
export function pathHints(bundles: readonly { root: string; name: string; displayPath: string }[]): Map<string, string> {
  const byName = new Map<string, number>();
  for (const bundle of bundles) byName.set(bundle.name, (byName.get(bundle.name) ?? 0) + 1);
  const hints = new Map<string, string>();
  for (const bundle of bundles) {
    if ((byName.get(bundle.name) ?? 0) < 2) continue;
    const slash = bundle.displayPath.replace(/\\/g, "/").lastIndexOf("/");
    hints.set(bundle.root, slash > 0 ? bundle.displayPath.slice(0, slash).replace(/\\/g, "/") : "folder root");
  }
  return hints;
}

/**
 * The bundle row: the status bar's result, so the two always agree, and where the bundle
 * is when another has the same name. What the check covered is on the Graph row.
 */
export function bundleRow(bundle: SidebarBundle): BundleRow {
  const summary = bundleSummary(bundle.state, bundle.count, bundle.cliIssue);
  const contents = bundle.contents ? describeContents(bundle.contents) : "";
  const tooltip = [
    bundle.displayPath,
    bundle.checking ? "Checking now." : `${capitalize(summary)}.`,
    contents ? `${capitalize(contents)}.` : undefined,
    "Problems come from the structural preview.",
  ].filter((line): line is string => Boolean(line));
  const description = [bundle.checking ? "checking…" : summary, bundle.pathHint].filter(
    (part): part is string => Boolean(part),
  );
  return {
    label: bundle.name,
    description: description.join(" · "),
    tooltip: tooltip.join("\n"),
    status: bundleStatus(bundle),
  };
}

/** A row under a bundle: what it shows, and what clicking it does. */
export interface ChildRow {
  description: string;
  tooltip: string;
}

/**
 * The Graph row: what the graph shows. On the structural preview, what the check covered
 * (`3 jobs · 11 tasks`); with a target picked in the graph, that target. Clicking it opens the graph.
 */
export function graphRow(bundle: SidebarBundle): ChildRow {
  const picked = bundle.graphTarget;
  if (picked && !picked.fellBack) {
    return {
      description: picked.target,
      tooltip: `Jobs, tasks and their dependencies, checked against ${picked.target}. Click to show the graph.`,
    };
  }
  if (picked) {
    return {
      description: `${picked.target} couldn't be checked`,
      tooltip: `${picked.target} couldn't be checked, so the graph shows the structural preview: the bundle's shared settings. Click to show the graph, where the reason is.`,
    };
  }
  const contents = bundle.contents ? describeContents(bundle.contents) : "";
  return {
    description: compactContents(bundle.contents) || (!bundle.state || bundle.state === "pending" ? "not checked yet" : ""),
    tooltip: [
      contents ? `${capitalize(contents)}, from the structural preview: the bundle's shared settings, checked without signing in.` : undefined,
      "Click to open the graph of jobs, tasks and their dependencies. Pick a target there to check against it.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  };
}

export interface ProblemsRow extends ChildRow {
  /** The icon: errors found, only warnings found, none found, or no result to show. */
  status: "errors" | "problems" | "none" | "unknown";
  /** Clicking opens the first problem in the YAML. Only when there is one. */
  canOpen: boolean;
}

/**
 * The Problems row: what the last check found, and the one place the sidebar says that
 * it comes from the structural preview. One problem opens where it is; several are listed to pick from.
 */
export function problemsRow(bundle: SidebarBundle): ProblemsRow {
  const scope = "The Problems panel and the status bar count the structural preview: the bundle's shared settings, checked without signing in.";
  if (bundle.state === "cli_missing") {
    return {
      description: "not checked",
      tooltip: "Not checked: the Databricks CLI couldn't be used. Choose or locate it under Settings, below.",
      status: "unknown",
      canOpen: false,
    };
  }
  if (!bundle.state || bundle.state === "pending") {
    return {
      description: "not checked yet",
      tooltip: "Not checked yet. Save one of its files, or use Check Again on the bundle.",
      status: "unknown",
      canOpen: false,
    };
  }
  if (bundle.count.problems > 0) {
    return {
      description: `${bundle.count.problems} · structural preview`,
      tooltip: `${capitalize(plural(bundle.count.problems, "problem"))}. ${
        bundle.count.problems === 1
          ? "Click to open it where it is."
          : `Click to see all ${bundle.count.problems}, by file, and pick one to open it where it is.`
      } ${scope}`,
      status: (bundle.count.errors ?? 0) > 0 ? "errors" : "problems",
      canOpen: true,
    };
  }
  if (bundle.state === "failed") {
    return {
      description: "not checked",
      tooltip: "The check stopped before it could look for problems. Open the graph to see the Databricks CLI's error.",
      status: "unknown",
      canOpen: false,
    };
  }
  return {
    description: "none found · structural preview",
    tooltip: `No problems found in the structural preview. A target can still have its own: pick it in the graph to check it. ${scope}`,
    status: "none",
    canOpen: false,
  };
}

/** One target under Targets: clicking opens where it is defined. */
export interface TargetItem {
  target: string;
  description: string;
}

export interface TargetsRow extends ChildRow {
  targets: TargetItem[];
}

/** The Targets row and its targets, by name: the CLI lists them in a different order from one run to the next. */
export function targetsRow(bundle: SidebarBundle): TargetsRow {
  const inUse = bundle.graphTarget && !bundle.graphTarget.fellBack ? bundle.graphTarget.target : undefined;
  const targets = [...bundle.targets].sort((a, b) => a.localeCompare(b));
  return {
    description:
      targets.length > 0 ? targets.join(", ") : !bundle.state || bundle.state === "pending" ? "not checked yet" : "none listed",
    tooltip:
      targets.length > 0
        ? "Where each target is defined. Click one to open its definition. To check against a target, pick it in the graph."
        : "The bundle's last check listed no targets.",
    targets: targets.map((target) => ({ target, description: target === inUse ? "graph in use" : "" })),
  };
}

/** Where a Databricks CLI was found, as the CLI picker and Settings say it. */
export type CliSource = "setting" | "path" | "windowsPath" | "databricksExtension";

export const CLI_SOURCE_LABELS: Record<CliSource, string> = {
  setting: "cliPath setting",
  path: "on PATH",
  windowsPath: "Windows Path",
  databricksExtension: "Databricks extension",
};

export interface CliCandidate {
  path: string;
  source: CliSource;
}

/**
 * Every place a CLI could come from, in the order the extension tries them, each file once:
 * the setting, then VS Code's PATH, the Path Windows has stored, the Databricks extension's.
 */
export function cliCandidates(found: {
  setting: string | undefined;
  onPath: readonly string[];
  windowsPath: readonly string[];
  databricksExtension: readonly string[];
  ignoreCase: boolean;
}): CliCandidate[] {
  const seen = new Set<string>();
  const candidates: CliCandidate[] = [];
  const add = (files: readonly string[], source: CliSource) => {
    for (const file of files) {
      const key = found.ignoreCase ? file.toLowerCase() : file;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ path: file, source });
    }
  };
  add(found.setting ? [found.setting] : [], "setting");
  add(found.onPath, "path");
  add(found.windowsPath, "windowsPath");
  add(found.databricksExtension, "databricksExtension");
  return candidates;
}

/** A candidate after `--version`: undefined `version` when it isn't the Databricks CLI. */
export interface CheckedCli extends CliCandidate {
  isDatabricksCli: boolean;
  version: string | undefined;
}

export interface CliChoice {
  path: string;
  label: string;
  description: string;
  inUse: boolean;
}

/** The CLI picker's rows: Databricks CLIs only, the one in use first and ticked. */
export function cliChoices(checked: readonly CheckedCli[], inUsePath: string | undefined): CliChoice[] {
  return checked
    .filter((cli) => cli.isDatabricksCli)
    .map((cli) => {
      const inUse = cli.path === inUsePath;
      const tooOld = isOlderThanSupported(cli.version);
      const parts = [CLI_SOURCE_LABELS[cli.source], inUse ? "in use" : undefined, tooOld ? `older than ${MIN_SUPPORTED_CLI_VERSION}` : undefined];
      return {
        path: cli.path,
        label: cli.version ?? "version unknown",
        description: parts.filter(Boolean).join(" · "),
        inUse,
      };
    })
    .sort((a, b) => Number(b.inUse) - Number(a.inUse));
}

/** What the Settings view knows about the Databricks CLI. `undefined` while it is looked up. */
export type SidebarCli =
  | { ok: true; path: string; version: string | undefined; source: CliSource | undefined }
  | { ok: false; issue: CliIssue }
  | undefined;

export interface SettingRow {
  label: string;
  description: string;
  tooltip: string;
  warning: boolean;
}

export function cliRow(cli: SidebarCli): SettingRow {
  const label = "Databricks CLI";
  if (!cli) return { label, description: "looking…", tooltip: "Looking for the Databricks CLI.", warning: false };
  if (cli.ok) {
    const old = isOlderThanSupported(cli.version);
    const parts = [
      cli.version ?? "version unknown",
      cli.source ? CLI_SOURCE_LABELS[cli.source] : undefined,
      old ? `older than ${MIN_SUPPORTED_CLI_VERSION}` : undefined,
    ];
    return {
      label,
      description: parts.filter(Boolean).join(" · "),
      tooltip: `${cli.path}\nClick to see every Databricks CLI found and choose one.`,
      warning: old,
    };
  }
  return {
    label,
    description: cliProblemWords(cli.issue),
    tooltip: "Bundle Inspector checks bundles with the Databricks CLI. Click to choose or locate one, or open the install guide.",
    warning: true,
  };
}

function cliProblemWords(issue: CliIssue): string {
  if (issue.problem === "configured_path_invalid") return "the cliPath setting doesn't point to it";
  if (issue.problem === "not_databricks_cli") {
    const legacy = legacyCliVersion(issue.versionOutput ?? "");
    return legacy ? `found the legacy pip CLI (${legacy})` : `"databricks" is another program`;
  }
  return "not found";
}

export function profileRow(profile: string | undefined): SettingRow {
  return {
    label: "Sign-in profile",
    description: profile ?? "CLI default",
    tooltip: profile
      ? `Targets are checked with the ${profile} profile from ~/.databrickscfg. The structural preview needs no sign-in. Click to choose another.`
      : "Targets are checked with the profile the Databricks CLI picks. The structural preview needs no sign-in. Click to choose one.",
    warning: false,
  };
}

/** A line above the bundles when none of them could be checked for want of a CLI. */
export function bundlesMessage(bundles: readonly SidebarBundle[]): string | undefined {
  if (bundles.length === 0 || !bundles.every((bundle) => bundle.state === "cli_missing")) return undefined;
  const notInstalled = bundles.every((bundle) => !bundle.cliIssue || bundle.cliIssue.problem === "not_installed");
  return notInstalled
    ? "Bundle Inspector checks bundles with the Databricks CLI, and couldn't find it. See Settings below."
    : "Bundle Inspector checks bundles with the Databricks CLI, and couldn't use the one it found. See Settings below.";
}

/**
 * The line of `target` under the top-level `targets:` mapping of a bundle file, 0-based,
 * so a target row can open its definition. Undefined when the file doesn't define it
 * there (a file `include` loads may). Keys are read as the CLI reads them (see
 * `entries`): any key style, aliases, `<<` merges (the line where the merged anchor
 * writes the target), and a repeated key where it last appears.
 */
export function targetLine(yaml: string, target: string): number | undefined {
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, { lineCounter, uniqueKeys: false });
  const anchors = anchorsOf(document);
  const targets = entries(anchors, document.contents).get("targets")?.value;
  const offset = entries(anchors, targets).get(target)?.key?.range?.[0];
  return offset === undefined ? undefined : lineCounter.linePos(offset).line - 1;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
