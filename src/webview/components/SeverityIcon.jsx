import { CircleX, Info, TriangleAlert } from "lucide-react";
import { severityMeta } from "../lib/issueSeverity";

const ICONS = { "circle-x": CircleX, "triangle-alert": TriangleAlert, info: Info };

/** An issue's icon, its shape from severityMeta: a circled X, a triangle or a circled i. */
export default function SeverityIcon({ severity, ...props }) {
  const Icon = ICONS[severityMeta(severity).icon];
  return <Icon size={13} {...props} />;
}
