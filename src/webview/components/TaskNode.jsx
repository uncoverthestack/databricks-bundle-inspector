import { Handle, Position } from "@xyflow/react";
import TypeDot from "./TypeDot";
import { UI_COLOR } from "../lib/vscodeTheme";

export default function TaskNode({ data, selected }) {
  // Red for an error, amber for warnings only, from the problem list Issues uses (issue 393).
  const tone = data.problemTone ?? "none";
  const toneColor = tone === "error" ? UI_COLOR.error : tone === "warning" ? UI_COLOR.warning : undefined;
  const dimmed = data.focusState === "dimmed";
  const issueCount = data.issueCounts?.total ?? 0;
  const branchOutcomes = Array.isArray(data.branchOutcomes)
    ? data.branchOutcomes
    : [];
  return (
    <div
      style={{
        width: 260,
        borderColor: toneColor
          ? toneColor
          : selected
            ? UI_COLOR.accent
            : data.focusState === "related"
              ? `color-mix(in srgb, ${UI_COLOR.accent} 60%, transparent)`
              : UI_COLOR.boxLine,
        // Tints over the widget colour, so a box never shows the canvas dots through it.
        backgroundColor: toneColor
          ? `color-mix(in srgb, ${toneColor} 8%, ${UI_COLOR.widget})`
          : selected
            ? `color-mix(in srgb, ${UI_COLOR.accent} 10%, ${UI_COLOR.widget})`
            : UI_COLOR.widget,
        opacity: dimmed ? 0.48 : 1,
      }}
      data-problem-tone={tone}
      className="flex items-center gap-2.5 h-12 rounded-xl border px-3 cursor-pointer transition-all hover:border-fg-soft"
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <TypeDot kind={data.kind} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-fg truncate leading-none mb-0.5">
          <span title={data.fullName ?? data.name}>{data.name}</span>
        </div>
        {(data.typeLabel || data.subtitle) && (
          <div className="text-[11px] text-muted truncate leading-none">
            {[data.typeLabel, data.subtitle].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      {issueCount > 0 && (
        <span
          title={`${issueCount} issue${issueCount === 1 ? "" : "s"}`}
          className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold text-fg-strong ${
            tone === "warning" ? "bg-warning/15" : tone === "error" ? "bg-error/15" : "bg-hover"
          }`}
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
