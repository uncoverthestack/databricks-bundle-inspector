import { normalizeSeverity, orderBySeverity, severityLabel, severityRank, type IssueSeverity } from "../../bundle/issueSeverity.js";

export { orderBySeverity, type IssueSeverity };

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

const LOOK: Record<IssueSeverity, Pick<SeverityMeta, "colorClass" | "icon">> = {
  error: { colorClass: "text-error", icon: "circle-x" },
  warning: { colorClass: "text-warning", icon: "triangle-alert" },
  info: { colorClass: "text-info", icon: "info" },
};

/** How a severity looks. Anything unknown is shown as a warning, as VS Code does. */
export function severityMeta(severity: string | undefined): SeverityMeta {
  const known = normalizeSeverity(severity);
  return { label: severityLabel(known), ...LOOK[known], rank: severityRank(known) };
}
