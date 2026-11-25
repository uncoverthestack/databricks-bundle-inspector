import {
  Activity,
  AppWindow,
  Bell,
  BrainCircuit,
  Cable,
  Cloud,
  Columns3,
  Database,
  FlaskConical,
  FolderTree,
  Gauge,
  HardDrive,
  Layers,
  LayoutDashboard,
  Library,
  ListTree,
  LockKeyhole,
  MessagesSquare,
  Plug,
  Radar,
  RotateCcwClock,
  Router,
  ScrollText,
  Server,
  SquareFunction,
  Table,
  TextSearch,
  Warehouse,
  Waypoints,
  Workflow,
} from "lucide-react";
import { kindMeta } from "../lib/kindMeta";
import { iconOfKind } from "../lib/kindIcons";

const ICONS = {
  activity: Activity,
  "app-window": AppWindow,
  bell: Bell,
  "brain-circuit": BrainCircuit,
  cable: Cable,
  cloud: Cloud,
  "columns-3": Columns3,
  database: Database,
  "flask-conical": FlaskConical,
  "folder-tree": FolderTree,
  gauge: Gauge,
  "hard-drive": HardDrive,
  layers: Layers,
  "layout-dashboard": LayoutDashboard,
  library: Library,
  "list-tree": ListTree,
  "lock-keyhole": LockKeyhole,
  "messages-square": MessagesSquare,
  plug: Plug,
  radar: Radar,
  "rotate-ccw-clock": RotateCcwClock,
  router: Router,
  "scroll-text": ScrollText,
  server: Server,
  "square-function": SquareFunction,
  table: Table,
  "text-search": TextSearch,
  warehouse: Warehouse,
  waypoints: Waypoints,
  workflow: Workflow,
};

/**
 * An item's type mark, in the colour of its type family (what runs, code, compute, or grey for
 * the rest; see kindMeta). Resource types get an icon (issue 546, names in kindIcons); a kind
 * with no icon, or `dot` set, gets a small dot. The type itself is written out beside it in
 * Databricks' words, never as a code the inspector made up (issue 400).
 *
 * A secret scope gets its own key drawing, in the same grey. Never yellow: amber means a
 * warning across the panel (issue 535). Job graph task boxes pass `dot`: they print their type.
 *
 * Icons are 14 px (issue 556): at 12 px a schema's folder tree and a volume's drive were hard
 * to tell apart, worst on a faded box. `ring` draws a hollow dashed ring in place of the icon,
 * for Serverless or inherited compute: it isn't a cluster, and a filled dot beside icons reads
 * as a status light. The dashes match the dashed border that means "not defined in this bundle".
 */
export default function TypeDot({ kind, dot = false, ring = false }) {
  const color = kindMeta(kind).color;
  if (ring) {
    return (
      <span
        aria-hidden="true"
        data-type-dot={kind}
        data-type-mark="ring"
        style={{ borderColor: color }}
        className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-dashed"
      />
    );
  }
  const icon = dot ? undefined : iconOfKind(kind);
  if (icon === "key") {
    return (
      <svg
        aria-hidden="true"
        data-type-dot={kind}
        data-type-icon="key"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <circle cx="5" cy="8" r="2.75" />
        <path d="M7.75 8h6.5M12 8v2.25M14.25 8v1.5" />
      </svg>
    );
  }
  const Icon = icon ? ICONS[icon] : undefined;
  if (Icon) {
    return (
      <Icon
        aria-hidden="true"
        data-type-dot={kind}
        data-type-icon={icon}
        className="h-3.5 w-3.5 shrink-0"
        color={color}
        strokeWidth={2}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-type-dot={kind}
      style={{ backgroundColor: color }}
      className="h-2 w-2 shrink-0 rounded-full"
    />
  );
}
