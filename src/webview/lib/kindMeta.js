export function kindMeta(kind) {
  // `color` names a --kind-* variable in index.css, which follows the VS Code theme.
  const map = {
    notebook: { color: "notebook" },
    pipeline: { color: "pipeline" },
    sql: { color: "sql" },
    script: { color: "script" },
    job: { color: "job" },
    dashboard: { color: "dashboard" },
    alert: { color: "alert" },
    cluster: { color: "cluster" },
    warehouse: { color: "warehouse" },
    file: { color: "file" },
    variable: { color: "variable" },
    secret_scope: { color: "alert" },
    widget: { color: "widget" },
  };
  const { color } = map[kind] ?? { color: "other" };
  // No short codes: the screens write the type in Databricks' words beside a dot (issue 400).
  return {
    color: `var(--kind-${color})`,
    bg: `color-mix(in srgb, var(--kind-${color}) 12%, transparent)`,
  };
}
