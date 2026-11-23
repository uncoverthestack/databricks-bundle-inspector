/**
 * Runs the checks on each bundle and gathers the report every format prints (#348). Uses the same
 * steps as the Problems panel (src/bundle/inspectBundle.ts), so both find the same things.
 */

import path from "node:path";
import { cliDiagnosticsOf, inspectorFindings } from "../bundle/inspectBundle.js";
import { issueDocsUrl } from "../bundle/issueDocs.js";
import type { InspectorIssue, InspectorIssueKind } from "../bundle/issues.js";
import { validateBundle, type BundleResult } from "../bundle/validateBundle.js";
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

export interface BundleReport {
  /** The bundle folder, relative to where the command ran, with `/`. */
  path: string;
  /** `bundle.name`, when the CLI could read it. */
  name?: string;
  /** False when `bundle validate` failed: only what the Databricks CLI reported is listed. */
  validated: boolean;
  findings: Finding[];
}

export interface CheckReport {
  version: string;
  databricksCli: { path: string; version: string | undefined };
  bundles: BundleReport[];
}

export type CheckOutcome =
  | { ok: true; report: CheckReport }
  | { ok: false; kind: "setup"; message: string };

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

export function findingFromIssue(issue: InspectorIssue, cwd: string, version: string): Finding {
  return {
    severity: issue.severity,
    code: issue.kind,
    message: issue.detail ? `${issue.title}: ${issue.detail}` : issue.title,
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
  if (diagnostics.length === 0) {
    return [{ severity: "error", code: "cli_diagnostic", message: result.error.error, docs }];
  }
  return diagnostics.map((diagnostic) => {
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
  });
}

/** Checks every bundle in order. Throws only when the inspector itself fails (exit code 4). */
export async function checkBundles(
  roots: readonly string[],
  cli: { path: string; version: string | undefined },
  cwd: string,
  version: string,
): Promise<CheckOutcome> {
  const bundles: BundleReport[] = [];
  for (const root of roots) {
    const result = await validateBundle(root, undefined, cli.path);
    if (!result.ok && (result.error.errorCode === "CLI_NOT_FOUND" || result.error.errorCode === "CLI_NOT_EXECUTABLE")) {
      return { ok: false, kind: "setup", message: result.error.error };
    }
    const name = result.data?.bundle?.name;
    const base = { path: displayPath(root, cwd), ...(name ? { name } : {}) };
    if (!result.ok) {
      bundles.push({ ...base, validated: false, findings: findingsFromFailedValidate(result, root, cwd, version) });
      continue;
    }
    const { issues } = await inspectorFindings(result, root);
    bundles.push({ ...base, validated: true, findings: issues.map((issue) => findingFromIssue(issue, cwd, version)) });
  }
  return { ok: true, report: { version, databricksCli: cli, bundles } };
}

/** Errors, warnings and notes across every bundle. */
export function countFindings(report: CheckReport): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const bundle of report.bundles) for (const finding of bundle.findings) counts[finding.severity]++;
  return counts;
}
