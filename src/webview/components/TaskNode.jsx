import { Handle, Position } from "@xyflow/react";
import { kindMeta } from "../lib/kindMeta";
import { UI_COLOR } from "../lib/vscodeTheme";

export default function TaskNode({ data, selected }) {
  const meta = kindMeta(data.kind);
  const missing = data.hasMissingFile;
  const dimmed = data.focusState === "dimmed";
  const issueCount = data.issueCounts?.total ?? 0;
  const branchOutcomes = Array.isArray(data.branchOutcomes)
    ? data.branchOutcomes
    : [];
  return (
    <div
      style={{
        width: 260,
        borderColor: missing
          ? UI_COLOR.error
          : selected
            ? UI_COLOR.accent
            : data.focusState === "related"
              ? `color-mix(in srgb, ${UI_COLOR.accent} 60%, transparent)`
              : UI_COLOR.line,
        // Tints over the widget colour, so a box never shows the canvas dots through it.
        backgroundColor: missing
          ? `color-mix(in srgb, ${UI_COLOR.error} 8%, ${UI_COLOR.widget})`
          : selected
            ? `color-mix(in srgb, ${UI_COLOR.accent} 10%, ${UI_COLOR.widget})`
            : UI_COLOR.widget,
        opacity: dimmed ? 0.48 : 1,
      }}
      className="flex items-center gap-2.5 h-12 rounded-xl border px-3 cursor-pointer transition-all hover:border-line-strong"
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <span
        style={{ color: meta.color, backgroundColor: meta.bg }}
        className="shrink-0 text-[10px] font-bold rounded-md px-1.5 py-0.5 font-mono leading-none"
      >
        {data.badge ?? meta.code}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-fg truncate leading-none mb-0.5">
          <span title={data.fullName ?? data.name}>{data.name}</span>
        </div>
        {data.subtitle && (
          <div className="text-[11px] text-muted truncate leading-none">
            {data.subtitle}
          </div>
        )}
      </div>
      {issueCount > 0 && (
        <span
          title={`${issueCount} issue${issueCount === 1 ? "" : "s"}`}
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-error/15 px-1.5 text-[10px] font-semibold text-fg-strong"
        >
          {issueCount}
        </span>
      )}
      {branchOutcomes.length > 0 && (
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {branchOutcomes.slice(0, 2).map((outcome) => {
            const normalized = String(outcome).toLowerCase();
            const className =
              normalized === "true"
                ? "border-ok/40 bg-ok/15 text-ok"
                : normalized === "false"
                  ? "border-line bg-hover text-fg-soft"
                  : "border-accent/40 bg-accent/15 text-link-active";
            return (
              <span
                key={outcome}
                className={`rounded border px-1 text-[9px] font-bold leading-3 ${className}`}
              >
                {outcome}
              </span>
            );
          })}
        </div>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
