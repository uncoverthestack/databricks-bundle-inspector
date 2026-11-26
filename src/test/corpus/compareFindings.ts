/**
 * Compares two `check --format json` reports of the same bundles (#651): what the pull
 * request's inspector finds that the base's doesn't, and the other way round, per code.
 * A finding is its bundle, code, severity, message, file, line and column; the docs link is
 * left out, as it names the version.
 */

export interface CorpusFinding {
  severity: string;
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface CorpusReport {
  bundles: Array<{ path: string; validated: boolean; findings: CorpusFinding[]; notChecked?: unknown[] }>;
}

export interface FindingChange {
  bundle: string;
  finding: CorpusFinding;
}

export interface CorpusComparison {
  bundles: number;
  baseFindings: number;
  headFindings: number;
  /** In the pull request's report only. */
  appeared: FindingChange[];
  /** In the base's report only. */
  disappeared: FindingChange[];
  /** Bundles in one report only (a bundle folder added or removed). */
  bundlesOnlyIn: { base: string[]; head: string[] };
}

function keyOf(bundle: string, finding: CorpusFinding): string {
  return JSON.stringify([bundle, finding.code, finding.severity, finding.message, finding.file ?? null, finding.line ?? null, finding.column ?? null]);
}

function counted(report: CorpusReport): Map<string, FindingChange[]> {
  const byKey = new Map<string, FindingChange[]>();
  for (const bundle of report.bundles) {
    for (const finding of bundle.findings) {
      const key = keyOf(bundle.path, finding);
      byKey.set(key, [...(byKey.get(key) ?? []), { bundle: bundle.path, finding }]);
    }
  }
  return byKey;
}

/** Each finding counted: two identical findings and one are a difference. */
function onlyIn(from: Map<string, FindingChange[]>, other: Map<string, FindingChange[]>): FindingChange[] {
  return [...from].flatMap(([key, changes]) => changes.slice(other.get(key)?.length ?? 0));
}

export function compareReports(base: CorpusReport, head: CorpusReport): CorpusComparison {
  const baseFindings = counted(base);
  const headFindings = counted(head);
  const basePaths = new Set(base.bundles.map((bundle) => bundle.path));
  const headPaths = new Set(head.bundles.map((bundle) => bundle.path));
  return {
    bundles: headPaths.size,
    baseFindings: base.bundles.reduce((sum, bundle) => sum + bundle.findings.length, 0),
    headFindings: head.bundles.reduce((sum, bundle) => sum + bundle.findings.length, 0),
    appeared: onlyIn(headFindings, baseFindings),
    disappeared: onlyIn(baseFindings, headFindings),
    bundlesOnlyIn: {
      base: [...basePaths].filter((path) => !headPaths.has(path)),
      head: [...headPaths].filter((path) => !basePaths.has(path)),
    },
  };
}

export function hasChanges(comparison: CorpusComparison): boolean {
  return (
    comparison.appeared.length > 0 ||
    comparison.disappeared.length > 0 ||
    comparison.bundlesOnlyIn.base.length > 0 ||
    comparison.bundlesOnlyIn.head.length > 0
  );
}

/** Markdown text in a table cell or a list: no pipes, no line breaks, nothing that renders as HTML or a link. */
function plain(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[|\\`*_[\]<>@]/g, (ch) => `\\${ch}`);
}

/** How many example findings each code lists. */
const EXAMPLES_PER_CODE = 5;

/** The job summary: totals, a table per code, then examples. */
export function comparisonMarkdown(comparison: CorpusComparison, corpus: string): string {
  const lines = [
    "## Findings on real bundles",
    "",
    `${comparison.bundles} bundles (${plain(corpus)}). Findings: ${comparison.baseFindings} on the base, ${comparison.headFindings} with this pull request.`,
    "",
  ];
  if (!hasChanges(comparison)) {
    lines.push("**No differences.**");
    return lines.join("\n") + "\n";
  }
  const codes = new Map<string, { appeared: number; disappeared: number }>();
  for (const [list, field] of [[comparison.appeared, "appeared"], [comparison.disappeared, "disappeared"]] as const) {
    for (const change of list) {
      const row = codes.get(change.finding.code) ?? { appeared: 0, disappeared: 0 };
      row[field] += 1;
      codes.set(change.finding.code, row);
    }
  }
  lines.push("| Code | New | Gone |", "| --- | --- | --- |");
  for (const [code, row] of [...codes].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${plain(code)} | ${row.appeared} | ${row.disappeared} |`);
  }
  for (const [title, list] of [["New", comparison.appeared], ["Gone", comparison.disappeared]] as const) {
    if (list.length === 0) continue;
    lines.push("", `### ${title}`, "");
    const shown = new Map<string, number>();
    for (const change of list) {
      const count = shown.get(change.finding.code) ?? 0;
      shown.set(change.finding.code, count + 1);
      if (count >= EXAMPLES_PER_CODE) continue;
      const where = change.finding.file ? ` (${plain(change.finding.file)}${change.finding.line !== undefined ? `:${change.finding.line}` : ""})` : "";
      lines.push(`- ${plain(change.finding.code)}, ${plain(change.bundle)}${where}: ${plain(change.finding.message).slice(0, 300)}`);
    }
    const hidden = list.length - [...shown.values()].reduce((sum, count) => sum + Math.min(count, EXAMPLES_PER_CODE), 0);
    if (hidden > 0) lines.push(`- ...and ${hidden} more.`);
  }
  for (const [side, paths] of [["the base", comparison.bundlesOnlyIn.base], ["this pull request", comparison.bundlesOnlyIn.head]] as const) {
    if (paths.length > 0) lines.push("", `Bundles found only by ${side}: ${paths.map(plain).join(", ")}.`);
  }
  lines.push("", "If every change is intended, add the `corpus-change-expected` label to the pull request.");
  return lines.join("\n") + "\n";
}
