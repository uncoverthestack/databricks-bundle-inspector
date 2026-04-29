export function kindMeta(kind) {
  const map = {
    notebook: { code: "NB", color: "#4ade80", bg: "rgba(74,222,128,0.12)" },
    pipeline: { code: "P", color: "#22d3ee", bg: "rgba(34,211,238,0.12)" },
    sql: { code: "SQL", color: "#fbbf24", bg: "rgba(251,191,36,0.12)" },
    script: { code: "PY", color: "#60a5fa", bg: "rgba(96,165,250,0.12)" },
    job: { code: "J", color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
    dashboard: { code: "DB", color: "#f472b6", bg: "rgba(244,114,182,0.12)" },
    cluster: { code: "C", color: "#fb923c", bg: "rgba(251,146,60,0.12)" },
    warehouse: { code: "WH", color: "#34d399", bg: "rgba(52,211,153,0.12)" },
    file: { code: "F", color: "#94a3b8", bg: "rgba(148,163,184,0.12)" },
    variable: { code: "V", color: "#c084fc", bg: "rgba(192,132,252,0.12)" },
    secret_scope: { code: "S", color: "#f87171", bg: "rgba(248,113,113,0.12)" },
    widget: { code: "W", color: "#e879f9", bg: "rgba(232,121,249,0.12)" },
  };
  return (
    map[kind] ?? { code: "T", color: "#78716c", bg: "rgba(120,113,108,0.12)" }
  );
}
