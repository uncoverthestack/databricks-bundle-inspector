import { Handle, Position } from "@xyflow/react";
import { kindMeta } from "../lib/kindMeta";

export default function TaskNode({ data, selected }) {
  const meta = kindMeta(data.kind);
  const missing = data.hasMissingFile;
  const dimmed = data.focusState === "dimmed";
  const issueCount = data.issueCounts?.total ?? 0;
  return (
    <div
      style={{
        width: 260,
        borderColor: missing
          ? "rgba(248,113,113,0.6)"
          : selected
            ? "#3b82f6"
            : data.focusState === "related"
              ? "rgba(96,165,250,0.55)"
              : "rgba(120,113,108,0.35)",
        backgroundColor: missing
          ? "rgba(248,113,113,0.06)"
          : selected
            ? "rgba(59,130,246,0.08)"
            : "rgba(20,18,16,0.97)",
        opacity: dimmed ? 0.48 : 1,
      }}
      className="flex items-center gap-2.5 h-12 rounded-xl border px-3 cursor-pointer transition-all hover:border-stone-500"
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <span
        style={{ color: meta.color, backgroundColor: meta.bg }}
        className="shrink-0 text-[10px] font-bold rounded-md px-1.5 py-0.5 font-mono leading-none"
      >
        {meta.code}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-stone-100 truncate leading-none mb-0.5">
          <span title={data.fullName ?? data.name}>{data.name}</span>
        </div>
        {data.subtitle && (
          <div className="text-[11px] text-stone-500 truncate leading-none">
            {data.subtitle}
          </div>
        )}
      </div>
      {issueCount > 0 && (
        <span
          title={`${issueCount} issue${issueCount === 1 ? "" : "s"}`}
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-300"
        >
          {issueCount}
        </span>
      )}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}
