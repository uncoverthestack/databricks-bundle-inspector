// @ts-check
import { CircleX, Info, TriangleAlert } from "lucide-react";
import { severityMeta } from "../lib/issueSeverity";

/** @type {Record<import("../lib/issueSeverity").SeverityMeta["icon"], import("lucide-react").LucideIcon>} */
const ICONS = { "circle-x": CircleX, "triangle-alert": TriangleAlert, info: Info };

/**
 * An issue's icon, its shape from severityMeta: a circled X, a triangle or a circled i.
 * @param {{ severity: string | undefined } & import("lucide-react").LucideProps} props
 */
export default function SeverityIcon({ severity, ...props }) {
  const Icon = ICONS[severityMeta(severity).icon];
  return <Icon size={13} {...props} />;
}
