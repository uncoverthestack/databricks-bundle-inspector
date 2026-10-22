export function kindMeta(kind) {
  // `color` names a --kind-* variable in index.css, which follows the VS Code theme.
  const map = {
    notebook: { code: "NB", color: "notebook" },
    pipeline: { code: "P", color: "pipeline" },
    sql: { code: "SQL", color: "sql" },
    script: { code: "PY", color: "script" },
    job: { code: "J", color: "job" },
    dashboard: { code: "DB", color: "dashboard" },
    alert: { code: "ALRT", color: "alert" },
    cluster: { code: "C", color: "cluster" },
    warehouse: { code: "WH", color: "warehouse" },
    file: { code: "F", color: "file" },
    variable: { code: "V", color: "variable" },
    secret_scope: { code: "S", color: "alert" },
    widget: { code: "W", color: "widget" },
  };
  const { code, color } = map[kind] ?? { code: "T", color: "other" };
  return {
    code,
    color: `var(--kind-${color})`,
    bg: `color-mix(in srgb, var(--kind-${color}) 12%, transparent)`,
  };
}
