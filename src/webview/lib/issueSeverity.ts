export type IssueSeverity = "error" | "warning" | "info";

export interface SeverityMeta {
  /** The word shown next to the icon, so the colour is never the only cue. */
  label: string;
  /** Tailwind colour class for the icon and label. */
  colorClass: string;
  /**
   * The icon's shape, as in VS Code's Problems panel, so it differs without colour too: with
   * red-green colour blindness the error red and warning amber look the same.
   */
  icon: "circle-x" | "triangle-alert" | "info";
  /** Lower comes first. */
  rank: number;
}

const META: Record<IssueSeverity, SeverityMeta> = {
  error: { label: "Error", colorClass: "text-error", icon: "circle-x", rank: 0 },
  warning: { label: "Warning", colorClass: "text-warning", icon: "triangle-alert", rank: 1 },
  info: { label: "Note", colorClass: "text-info", icon: "info", rank: 2 },
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
