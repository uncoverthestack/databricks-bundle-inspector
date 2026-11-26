/**
 * Runs the checks on each bundle and gathers the report every format prints (#348). Uses the same
 * steps as the Problems panel (src/bundle/inspectBundle.ts), so both find the same things.
 */

import path from "node:path";
import { firstLine, targetFallback } from "../bundle/fallbackReason.js";
import { cliDiagnosticsOf, inspectorFindings, inspectorFindingsAt, targetResolutionOf } from "../bundle/inspectBundle.js";
import { issueDocsUrl } from "../bundle/issueDocs.js";
import { CHECK_WITH_TARGET_CLI, PICK_TARGET_IN_GRAPH, type InspectorIssue, type InspectorIssueKind } from "../bundle/issues.js";
import { validateBundle, type BundleResult } from "../bundle/validateBundle.js";
import { notCheckedIn, type NotChecked, type NotCheckedReason } from "../bundle/notChecked.js";
import type { BundleGraph } from "../bundle/graph/bundleGraph.js";
import { isOlderThanSupported, legacyCliVersion, MIN_SUPPORTED_CLI_VERSION } from "../databricksCli/parsing.js";
import { databricksCliInstallUrl, resolveDatabricksCli, verifyCliPath } from "../databricksCli/validateDatabricksCli.js";
import { displayPath } from "./discover.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  /** The check's name, as in the Problems panel and docs/checks.md. */
  code: InspectorIssueKind;
  /** The title, then the detail after ": ", as the Problems panel shows it. */
  message: string;
  /** Relative to where the command ran, with `/`. Absent for findings about the bundle as a whole. */
  file?: string;
  line?: number;
  column?: number;
  task?: string;
  /** The resource the finding is about, such as `resources.jobs.nightly`. */
  resource?: string;
  docs: string;
}

/** Something the checks couldn't look at, and why (#647). */
export interface NotCheckedEntry {
  reason: NotCheckedReason;
  message: string;
  /** Relative to where the command ran, with `/`. */
  file?: string;
  line?: number;
  task?: string;
  resource?: string;
}

export interface BundleReport {
  /** The bundle folder, relative to where the command ran, with `/`. */
  path: string;
  /** `bundle.name`, when the CLI could read it. */
  name?: string;
  /** False when `bundle validate` failed: only what the Databricks CLI reported is listed. */
  validated: boolean;
  findings: Finding[];
  /** What the checks couldn't look at. Empty when `bundle validate` failed, as nothing was checked then. */
  notChecked: NotCheckedEntry[];
}

export interface CheckReport {
  version: string;
  databricksCli: { path: string; version: string | undefined };
  /** The real target checked, or undefined for the structural preview. */
  target?: string;
  bundles: BundleReport[];
}

export type CheckOutcome =
  | { ok: true; report: CheckReport }
  | { ok: false; kind: "setup" | "usage"; message: string };

/** How long `--target` may take. The extension waits 15 seconds to stay responsive; CI networks are slower. */
export const CLI_REAL_TARGET_TIMEOUT_MS = 60_000;

export interface TargetOptions {
  target: string | undefined;
  profile: string | undefined;
}

/** The Databricks CLI to use, checked once before any bundle. */
export async function findDatabricksCli(
  given: string | undefined,
  cwd: string,
): Promise<{ ok: true; path: string; version: string | undefined } | { ok: false; message: string }> {
  if (given !== undefined) {
    // A path given on purpose is used or refused, never swapped for another CLI.
    const candidate = /[\\/]/.test(given) ? path.resolve(cwd, given) : given;
    const verified = await verifyCliPath(candidate);
    if (!verified.ok) return { ok: false, message: `--databricks-cli ${given} is not a working Databricks CLI.` };
    return checkVersion(verified.candidate, verified.versionOutput);
  }
  const found = await resolveDatabricksCli();
  if (found.ok) return checkVersion(found.candidate, found.versionOutput);
  if (found.problem === "not_databricks_cli") {
    const legacy = legacyCliVersion(found.versionOutput ?? "");
    return {
      ok: false,
      message: legacy
        ? `The "databricks" command on PATH is the legacy databricks-cli pip package (${legacy}), which can't check bundles. Install the Databricks CLI.`
        : `The "databricks" command on PATH is not the Databricks CLI. Install it (${databricksCliInstallUrl(process.platform)}), or pass --databricks-cli <path>.`,
    };
  }
  return {
    ok: false,
    message: [
      "This tool runs the Databricks CLI (`databricks bundle validate`) to read your bundle, and none was found.",
      `Install it (v${MIN_SUPPORTED_CLI_VERSION.slice(1)} or newer): ${databricksCliInstallUrl(process.platform)}`,
      "No sign-in is needed. Already installed somewhere else? Pass --databricks-cli <path>.",
    ].join("\n"),
  };
}

function checkVersion(cliPath: string, version: string | undefined) {
  if (isOlderThanSupported(version)) {
    return {
      ok: false as const,
      message: `Databricks CLI ${version} is older than ${MIN_SUPPORTED_CLI_VERSION}, the oldest version this inspector is tested with. Update it.`,
    };
  }
  return { ok: true as const, path: cliPath, version };
}

/** A finding's words as the command line says them: here a target is checked with --target, not in the graph. */
function cliTitle(issue: InspectorIssue): string {
  return issue.kind === "path_not_checked" || issue.kind === "environments_not_checked"
    ? issue.title.replace(PICK_TARGET_IN_GRAPH, CHECK_WITH_TARGET_CLI)
    : issue.title;
}

function notCheckedEntries(graph: BundleGraph, cwd: string): NotCheckedEntry[] {
  const taskNames = new Map(graph.nodes.map((node) => [node.id, node.taskKey ?? node.displayName]));
  return notCheckedIn(graph).map((item: NotChecked) => ({
    reason: item.reason,
    message: item.text,
    ...(item.file ? { file: displayPath(item.file, cwd) } : {}),
    ...(item.file && item.line !== undefined ? { line: item.line } : {}),
    ...(item.taskId ? { task: taskNames.get(item.taskId) ?? item.taskId } : {}),
    ...(item.resourceId ? { resource: item.resourceId } : {}),
  }));
}

export function findingFromIssue(issue: InspectorIssue, cwd: string, version: string): Finding {
  const title = cliTitle(issue);
  return {
    severity: issue.severity,
    code: issue.kind,
    message: issue.detail ? `${title}: ${issue.detail}` : title,
    ...(issue.file ? { file: displayPath(issue.file, cwd) } : {}),
    ...(issue.file && issue.line !== undefined ? { line: issue.line } : {}),
    ...(issue.file && issue.column !== undefined ? { column: issue.column } : {}),
    ...(issue.taskName ? { task: issue.taskName } : {}),
    ...(issue.resourceId ? { resource: issue.resourceId } : {}),
    docs: issueDocsUrl(issue.kind, version),
  };
}

/** What the Databricks CLI reported when `bundle validate` failed. */
export function findingsFromFailedValidate(
  result: Extract<BundleResult, { ok: false }>,
  bundleRoot: string,
  cwd: string,
  version: string,
): Finding[] {
  const docs = issueDocsUrl("cli_diagnostic", version);
  const diagnostics = cliDiagnosticsOf(result);
  // A failed validate always fails: when the CLI printed only warnings, its exit is the error.
  const failure: Finding[] = diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? []
    : [{ severity: "error", code: "cli_diagnostic", message: `${result.error.error}${result.error.details ? ` ${cliErrorLine(result.error.details)}` : ""}`, docs }];
  return [...failure, ...diagnostics.map((diagnostic) => {
    const file = diagnostic.path ? displayPath(path.resolve(bundleRoot, diagnostic.path), cwd) : undefined;
    return {
      severity: diagnostic.severity,
      code: "cli_diagnostic" as const,
      message: diagnostic.message,
      ...(file ? { file } : {}),
      ...(file && diagnostic.line !== undefined ? { line: diagnostic.line } : {}),
      ...(file && diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
      docs,
    };
  })];
}

/** The CLI's error line from its output, else its first line: the reason, not a warning before it. */
/**
 * The command that signs in again, for the profile the check used. Without `--profile` the
 * CLI picked one itself, so none is named. Quoted when the name needs it in a shell.
 */
export function signInCommand(profile: string | undefined): string {
  if (!profile) return "databricks auth login";
  return `databricks auth login --profile ${/^[\w.@-]+$/.test(profile) ? profile : `'${profile.replace(/'/g, `'\\''`)}'`}`;
}

export function cliErrorLine(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const error = lines.find((line) => /^error:/i.test(line));
  return firstLine(error ?? lines[0] ?? output);
}

function cliMissing(result: BundleResult): string | undefined {
  return !result.ok && (result.error.errorCode === "CLI_NOT_FOUND" || result.error.errorCode === "CLI_NOT_EXECUTABLE")
    ? result.error.error
    : undefined;
}

/**
 * Checks every bundle in order: the structural preview, or with `target`, the preview and then
 * the target as the Databricks CLI resolves it. Unlike the graph, a target that can't be checked
 * never falls back to the preview: CI that asked for a target must not pass on another. Throws
 * only when the inspector itself fails (exit code 4).
 */
export async function checkBundles(
  roots: readonly string[],
  cli: { path: string; version: string | undefined },
  cwd: string,
  version: string,
  { target, profile }: TargetOptions = { target: undefined, profile: undefined },
): Promise<CheckOutcome> {
  const bundles: BundleReport[] = [];
  for (const root of roots) {
    const preview = await validateBundle(root, undefined, cli.path);
    const missing = cliMissing(preview);
    if (missing) return { ok: false, kind: "setup", message: missing };
    const name = preview.data?.bundle?.name;
    const shown = displayPath(root, cwd);
    const base = { path: shown, ...(name ? { name } : {}) };
    if (!preview.ok) {
      bundles.push({ ...base, validated: false, findings: findingsFromFailedValidate(preview, root, cwd, version), notChecked: [] });
      continue;
    }
    if (!target) {
      const { graph, issues } = await inspectorFindings(preview, root);
      bundles.push({
        ...base,
        validated: true,
        findings: issues.map((issue) => findingFromIssue(issue, cwd, version)),
        notChecked: notCheckedEntries(graph, cwd),
      });
      continue;
    }

    const atTarget = await validateBundle(root, target, cli.path, profile, { realTargetTimeoutMs: CLI_REAL_TARGET_TIMEOUT_MS });
    const missingAtTarget = cliMissing(atTarget);
    if (missingAtTarget) return { ok: false, kind: "setup", message: missingAtTarget };
    if (!atTarget.ok) {
      const fallback = targetFallback(atTarget.error);
      if (fallback.code === "no_such_target") {
        const known = preview.targetOptions?.length ? preview.targetOptions : Object.keys(preview.data.targets ?? {});
        return {
          ok: false,
          kind: "usage",
          message: `Bundle ${shown} has no target "${target}".${known.length ? ` Its targets: ${known.join(", ")}.` : ""}`,
        };
      }
      if (fallback.code !== "other") {
        // Signing in, a profile, or the workspace not answering: nothing to do with the bundle.
        return {
          ok: false,
          kind: "setup",
          message:
            `Can't check target "${target}" of bundle ${shown}: ${fallback.reason}.\n` +
            (fallback.code === "login_rejected" ? `Sign in again: ${signInCommand(profile)}\n` : "") +
            `The Databricks CLI said: ${cliErrorLine(fallback.message)}`,
        };
      }
      // The Databricks CLI rejects the bundle for this target: that is a finding.
      bundles.push({ ...base, validated: false, findings: findingsFromFailedValidate(atTarget, root, cwd, version), notChecked: [] });
      continue;
    }
    const { resolutionBundle } = targetResolutionOf(
      atTarget.data,
      atTarget.targetOptions,
      preview.targetOptions ?? [],
      preview.data,
    );
    const { graph, issues } = await inspectorFindingsAt(atTarget, root, resolutionBundle, target);
    bundles.push({
      ...base,
      validated: true,
      findings: issues.map((issue) => findingFromIssue(issue, cwd, version)),
      notChecked: notCheckedEntries(graph, cwd),
    });
  }
  return { ok: true, report: { version, databricksCli: cli, ...(target ? { target } : {}), bundles } };
}

/** Errors, warnings and notes across every bundle. */
export function countFindings(report: CheckReport): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const bundle of report.bundles) for (const finding of bundle.findings) counts[finding.severity]++;
  return counts;
}
