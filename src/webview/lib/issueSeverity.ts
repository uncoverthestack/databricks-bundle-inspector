export type IssueSeverity = "error" | "warning" | "info";

export interface SeverityMeta {
  /** The word shown next to the icon, so the colour is never the only cue. */
  label: string;
  /** Tailwind colour class for the icon and label. */
  colorClass: string;
  /** Lower comes first. */
  rank: number;
}

const META: Record<IssueSeverity, SeverityMeta> = {
  error: { label: "Error", colorClass: "text-red-400", rank: 0 },
  warning: { label: "Warning", colorClass: "text-yellow-400", rank: 1 },
  info: { label: "Note", colorClass: "text-sky-400", rank: 2 },
};

/** How a severity looks. Anything unknown is shown as a warning, as VS Code does. */
export function severityMeta(severity: string | undefined): SeverityMeta {
  return META[severity as IssueSeverity] ?? META.warning;
}

/** Errors first, then warnings, then notes, keeping the order found within each. */
export function orderBySeverity<T extends { severity?: string | undefined }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => severityMeta(a.item.severity).rank - severityMeta(b.item.severity).rank || a.index - b.index)
    .map(({ item }) => item);
}
