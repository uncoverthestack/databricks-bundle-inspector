import { isAlias, isMap, isScalar, LineCounter, parseDocument } from "yaml";
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
export type SidebarStatus = "checking" | "pending" | "passed" | "problems" | "failed" | "cli_missing";

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
  if (bundle.count.problems > 0) return "problems";
  return bundle.state === "failed" ? "failed" : "passed";
}

export function bundleRow(bundle: SidebarBundle): BundleRow {
  const summary = bundleSummary(bundle.state, bundle.count, bundle.cliIssue);
  const contents = bundle.contents ? describeContents(bundle.contents) : "";
  const tooltip = [
    bundle.displayPath,
    bundle.checking ? "Checking now." : `${capitalize(summary)}.`,
    contents ? `${capitalize(contents)}.` : undefined,
    "Problems come from the structural preview.",
  ].filter((line): line is string => Boolean(line));
  return {
    label: bundle.name,
    description: bundle.checking ? "checking…" : summary,
    tooltip: tooltip.join("\n"),
    status: bundleStatus(bundle),
  };
}

/** One choice under "Check against": the structural preview (`target` undefined) or a target. */
export interface CheckOption {
  target: string | undefined;
  label: string;
  description: string;
  inUse: boolean;
}

export interface CheckAgainstRow {
  description: string;
  tooltip: string;
  options: CheckOption[];
}

/**
 * What the graph checks the bundle against, and the choices. The structural preview is
 * not a target, so it is listed next to the targets rather than as one of them.
 */
export function checkAgainst(bundle: SidebarBundle): CheckAgainstRow {
  const picked = bundle.graphTarget;
  const inUse = picked && !picked.fellBack ? picked.target : undefined;
  const description = inUse
    ? inUse
    : picked
      ? `structural preview · ${picked.target} couldn't be checked`
      : "structural preview";
  return {
    description,
    tooltip:
      "What the graph checks this bundle against. The Problems panel and the status bar always use the structural preview.",
    options: [
      {
        target: undefined,
        label: "Structural preview",
        description: inUse === undefined ? "shared settings · in use" : "shared settings",
        inUse: inUse === undefined,
      },
      // By name: the CLI lists targets in a different order from one run to the next.
      ...[...bundle.targets].sort((a, b) => a.localeCompare(b)).map((target) => ({
        target,
        label: target,
        description: target === inUse ? "in use" : "",
        inUse: target === inUse,
      })),
    ],
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
 * there (a file `include` loads may). Read with the YAML parser, so any key style works
 * (`"targets":`, `targets: &all`, `targets: *all`, flow mappings); a repeated key counts
 * where it last appears, as the CLI keeps the last one.
 */
export function targetLine(yaml: string, target: string): number | undefined {
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, { lineCounter, uniqueKeys: false });
  const keyOffset = (map: unknown, key: string): number | undefined => {
    if (!isMap(map)) return undefined;
    const pair = map.items.findLast((item) => isScalar(item.key) && String(item.key.value) === key);
    return isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
  };
  const root = document.contents;
  if (!isMap(root)) return undefined;
  const targetsPair = root.items.findLast((item) => isScalar(item.key) && item.key.value === "targets");
  let targets: unknown = targetsPair?.value;
  if (isAlias(targets)) targets = targets.resolve(document);
  const offset = keyOffset(targets, target);
  return offset === undefined ? undefined : lineCounter.linePos(offset).line - 1;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
