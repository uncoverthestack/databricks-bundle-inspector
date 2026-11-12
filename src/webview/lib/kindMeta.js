/**
 * A type's colour: its family's, never its own. Red, amber, blue and green mean a problem,
 * focus or ok and nothing else, which leaves three hues (issue 424): what runs, code, and
 * compute. Every other type is grey; the type itself is written in words beside the dot.
 */
const FAMILY_OF_KIND = {
  job: "workload",
  pipeline: "workload",
  dashboard: "workload",
  alert: "workload",
  notebook: "code",
  sql: "code",
  script: "code",
  cluster: "compute",
  warehouse: "compute",
};

export function kindMeta(kind) {
  // Names a --kind-* variable in index.css, which follows the VS Code theme.
  const family = FAMILY_OF_KIND[kind] ?? "other";
  return {
    color: `var(--kind-${family})`,
    bg: `color-mix(in srgb, var(--kind-${family}) 12%, transparent)`,
  };
}
