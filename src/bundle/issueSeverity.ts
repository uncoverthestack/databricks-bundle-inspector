/**
 * A problem's severity as words and order, without colours or icons. Shared by the panel and the
 * command-line tool (#348, #392); the panel adds its colours and icons in webview/lib/issueSeverity.
 */

export type IssueSeverity = "error" | "warning" | "info";

const LABEL: Record<IssueSeverity, string> = { error: "Error", warning: "Warning", info: "Note" };
const RANK: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

/** A known severity, or "warning" for anything else, as VS Code does. */
export function normalizeSeverity(severity: string | undefined): IssueSeverity {
  return Object.hasOwn(LABEL, severity ?? "") ? (severity as IssueSeverity) : "warning";
}

/** The word shown for a severity: "Error", "Warning" or "Note". */
export function severityLabel(severity: string | undefined): string {
  return LABEL[normalizeSeverity(severity)];
}

/** Lower comes first. */
export function severityRank(severity: string | undefined): number {
  return RANK[normalizeSeverity(severity)];
}

/** Errors first, then warnings, then notes, keeping the order found within each. */
export function orderBySeverity<T extends { severity?: string | undefined }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => severityRank(a.item.severity) - severityRank(b.item.severity) || a.index - b.index)
    .map(({ item }) => item);
}
