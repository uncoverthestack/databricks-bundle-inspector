/**
 * The four report formats (#348). Text from a bundle (names, messages, paths) is shown as the text
 * it is in every format: never a link, HTML, a mention or a GitHub workflow command.
 */

import { escapeMarkdown, markdownCode, withoutMentions } from "../bundle/markdownText.js";
import { withVisibleDirectionControls } from "../bundle/visibleText.js";
import type { FailOn, Format } from "./args.js";
import { countFindings, type BundleReport, type CheckReport, type Finding, type Severity } from "./check.js";

export const JSON_SCHEMA_VERSION = 1;

const SEVERITY_WORD: Record<Severity, string> = { error: "error", warning: "warning", info: "note" };
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then notes; by file and line within each. */
export function orderFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0),
  );
}

/** Whether a finding counts towards `--fail-on`. */
export function failsOn(severity: Severity, failOn: FailOn): boolean {
  if (failOn === "never") return false;
  const threshold: Record<Exclude<FailOn, "never">, number> = { error: 0, warning: 1, note: 2 };
  return RANK[severity] <= threshold[failOn];
}

/** 0 when nothing reaches `--fail-on`, else 1. */
export function exitCodeFor(report: CheckReport, failOn: FailOn): 0 | 1 {
  return report.bundles.some((bundle) => bundle.findings.some((finding) => failsOn(finding.severity, failOn))) ? 1 : 0;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** What was checked: "the structural preview" or `target "prod"`. */
function checkedWhat(report: CheckReport): string {
  return report.target ? `target "${report.target}"` : "the structural preview";
}

/** "2 errors, 1 warning and 0 notes in 3 bundles (the structural preview)" */
export function summaryLine(report: CheckReport): string {
  const counts = countFindings(report);
  return `${plural(counts.error, "error")}, ${plural(counts.warning, "warning")} and ${plural(counts.info, "note")} in ${plural(report.bundles.length, "bundle")} (${checkedWhat(report)})`;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

function location(finding: Finding): string {
  if (!finding.file) return "";
  return `${finding.file}${finding.line !== undefined ? `:${finding.line}${finding.column !== undefined ? `:${finding.column}` : ""}` : ""}`;
}

function bundleHeading(bundle: BundleReport): string {
  return `${bundle.path}${bundle.name ? ` (${bundle.name})` : ""}`;
}

/** How many "not checked" lines the text and Markdown formats list per bundle; JSON lists every one. */
export const NOT_CHECKED_SHOWN = 5;

// ── text ─────────────────────────────────────────────────────

const COLOR: Record<Severity, string> = { error: "\x1b[31m", warning: "\x1b[33m", info: "\x1b[34m" };
const RESET = "\x1b[0m";

/** Control characters from a bundle never reach the terminal, so a name can't move the cursor or recolour. */
function terminalText(text: string): string {
  return withVisibleDirectionControls(oneLine(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ""));
}

export function formatText(report: CheckReport, color: boolean): string {
  const paint = (severity: Severity, text: string) => (color ? `${COLOR[severity]}${text}${RESET}` : text);
  const lines: string[] = [];
  for (const bundle of report.bundles) {
    lines.push(terminalText(bundleHeading(bundle)));
    if (!bundle.validated) lines.push("  bundle validate failed; only what the Databricks CLI reported is listed");
    if (bundle.findings.length === 0) lines.push("  no problems");
    for (const finding of orderFindings(bundle.findings)) {
      const where = location(finding);
      lines.push(
        `  ${paint(finding.severity, SEVERITY_WORD[finding.severity].padEnd(7))} ${where ? `${terminalText(where)}  ` : ""}${terminalText(finding.message)}  [${finding.code}]`,
      );
    }
    // So "no problems" never hides code that wasn't read (#647).
    for (const entry of bundle.notChecked.slice(0, NOT_CHECKED_SHOWN)) lines.push(`  not checked  ${terminalText(entry.message)}`);
    if (bundle.notChecked.length > NOT_CHECKED_SHOWN) {
      lines.push(`  not checked  ...and ${bundle.notChecked.length - NOT_CHECKED_SHOWN} more (--format json lists every one)`);
    }
    lines.push("");
  }
  lines.push(summaryLine(report));
  return lines.join("\n") + "\n";
}

// ── json ─────────────────────────────────────────────────────

export function formatJson(report: CheckReport, failOn: FailOn): string {
  const counts = countFindings(report);
  return (
    JSON.stringify(
      {
        schemaVersion: JSON_SCHEMA_VERSION,
        tool: { name: "databricks-bundle-inspector", version: report.version },
        databricksCli: { version: report.databricksCli.version ?? null },
        failOn,
        target: report.target ?? null,
        summary: { errors: counts.error, warnings: counts.warning, notes: counts.info, bundles: report.bundles.length },
        bundles: report.bundles.map((bundle) => ({ ...bundle, findings: orderFindings(bundle.findings) })),
      },
      null,
      2,
    ) + "\n"
  );
}

// ── markdown ─────────────────────────────────────────────────

const SEVERITY_LABEL: Record<Severity, string> = { error: "Error", warning: "Warning", info: "Note" };

export function formatMarkdown(report: CheckReport): string {
  const counts = countFindings(report);
  const lines = [
    "## Databricks Bundle Inspector",
    "",
    `**${plural(counts.error, "error")}, ${plural(counts.warning, "warning")} and ${plural(counts.info, "note")}** in ${plural(report.bundles.length, "bundle")}, ${report.target ? `target ${markdownCode(report.target)}` : "structural preview"}.`,
  ];
  for (const bundle of report.bundles) {
    lines.push("", `### ${markdownCode(bundle.path)}${bundle.name ? ` (${escapeMarkdown(bundle.name)})` : ""}`, "");
    if (!bundle.validated) lines.push("`bundle validate` failed; only what the Databricks CLI reported is listed.", "");
    if (bundle.findings.length === 0) {
      lines.push("No problems.");
    } else {
      lines.push("| Severity | Where | Problem | Check |", "| --- | --- | --- | --- |");
      for (const finding of orderFindings(bundle.findings)) {
        const where = location(finding);
        lines.push(
          `| ${SEVERITY_LABEL[finding.severity]} | ${where ? markdownCode(where) : ""} | ${escapeMarkdown(oneLine(finding.message))} | [${finding.code.replace(/_/g, "\\_")}](${finding.docs}) |`,
        );
      }
    }
    if (bundle.notChecked.length > 0) {
      lines.push("", "Not checked:", "");
      for (const entry of bundle.notChecked.slice(0, NOT_CHECKED_SHOWN)) lines.push(`- ${escapeMarkdown(oneLine(entry.message))}`);
      if (bundle.notChecked.length > NOT_CHECKED_SHOWN) lines.push(`- ...and ${bundle.notChecked.length - NOT_CHECKED_SHOWN} more.`);
    }
  }
  lines.push("", `Databricks Bundle Inspector ${escapeMarkdown(report.version)}, Databricks CLI ${escapeMarkdown(report.databricksCli.version ?? "unknown")}.`);
  return lines.join("\n") + "\n";
}

// ── github ───────────────────────────────────────────────────

/** A workflow command's message: GitHub's own escaping, so text can't end the command or start another. */
export function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A workflow command's property (file, title): also `:` and `,`, which separate properties. */
export function escapeCommandProperty(text: string): string {
  return escapeCommandData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

const COMMAND: Record<Severity, string> = { error: "error", warning: "warning", info: "notice" };

/** One annotation per finding, on its file and line when it has one, then a plain summary line. */
export function formatGithub(report: CheckReport): string {
  const lines: string[] = [];
  for (const bundle of report.bundles) {
    for (const finding of orderFindings(bundle.findings)) {
      const properties = [
        ...(finding.file ? [`file=${escapeCommandProperty(finding.file)}`] : []),
        ...(finding.file && finding.line !== undefined ? [`line=${finding.line}`] : []),
        ...(finding.file && finding.column !== undefined ? [`col=${finding.column}`] : []),
        `title=${escapeCommandProperty(`${finding.code} (${bundle.path})`)}`,
      ];
      const message = withoutMentions(withVisibleDirectionControls(`${finding.message}${finding.file ? "" : ` (${bundleHeading(bundle)})`}`));
      lines.push(`::${COMMAND[finding.severity]} ${properties.join(",")}::${escapeCommandData(message)}`);
    }
  }
  lines.push(neutraliseCommands(`Databricks Bundle Inspector: ${summaryLine(report)}`));
  return lines.join("\n") + "\n";
}

// ── every format ─────────────────────────────────────────────

/**
 * A line that starts with `::` (after spaces) is a GitHub workflow command when printed in a CI
 * log. Formats other than github never print one: a zero-width space after the first `:` stops it.
 */
export function neutraliseCommands(text: string): string {
  return text.replace(/^(\s*):(?=:)/gm, "$1:​");
}

export function formatReport(report: CheckReport, format: Format, failOn: FailOn, color: boolean): string {
  switch (format) {
    case "json":
      return neutraliseCommands(formatJson(report, failOn));
    case "markdown":
      return neutraliseCommands(formatMarkdown(report));
    case "github":
      return formatGithub(report);
    case "text":
      return neutraliseCommands(formatText(report, color));
  }
}
