import { AlertTriangle, Info, X } from "lucide-react";
import { kindMeta } from "../lib/kindMeta";
import { severityMeta } from "../lib/issueSeverity";

/** Notes get the info icon, as in the task panel; errors and warnings the triangle. */
function SeverityIcon({ severity, ...props }) {
  const Icon = severity === "info" ? Info : AlertTriangle;
  return <Icon size={13} {...props} />;
}

export default function HeaderChipPanel({ title, items, onClose, onSelectItem }) {
  const groups = new Map();
  for (const item of items) {
    const groupItems = groups.get(item.group) ?? [];
    groupItems.push(item);
    groups.set(item.group, groupItems);
  }

  return (
    // Never taller than the space below the header, so it fits a short webview.
    <div className="absolute right-4 top-14 z-30 flex max-h-[calc(100%-4.5rem)] w-[360px] flex-col overflow-hidden rounded-lg border border-stone-800 bg-stone-950 shadow-2xl">
      <div className="flex shrink-0 items-center justify-between border-b border-stone-800 px-3 py-2">
        <div>
          <div className="text-xs font-semibold text-stone-100">{title}</div>
          <div className="text-[11px] text-stone-500">
            {items.length} {items.length === 1 ? "item" : "items"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 outline-none hover:bg-stone-800 hover:text-stone-200 focus:ring-1 focus:ring-blue-500/40"
          aria-label={`Close ${title}`}
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[420px] min-h-0 flex-1 overflow-auto overscroll-contain py-1">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-stone-500">
            {title === "Bundle Issues"
              ? "No issues found in this bundle."
              : `No ${title.toLowerCase()} found for this job.`}
          </div>
        ) : (
          [...groups.entries()].map(([group, groupItems]) => (
            <section key={group} className="py-1">
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
                {group} · {groupItems.length}
              </div>
              {groupItems.map((item) => {
                const clickable = Boolean(item.taskId || item.file);
                const meta = kindMeta(item.kind);
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!clickable}
                    title={clickable ? "Open source location" : undefined}
                    onClick={clickable ? () => onSelectItem(item) : undefined}
                    className={[
                      "flex w-full items-start gap-2 px-3 py-2 text-left outline-none",
                      clickable
                        ? "cursor-pointer hover:bg-stone-900 focus:bg-stone-900"
                        : "cursor-default",
                    ].join(" ")}
                  >
                    {item.severity ? (
                      <SeverityIcon
                        severity={item.severity}
                        aria-label={severityMeta(item.severity).label}
                        className={`mt-0.5 shrink-0 ${severityMeta(item.severity).colorClass}`}
                      />
                    ) : (
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: meta.color }}
                      />
                    )}
                    <span className="min-w-0">
                      <span title={item.title} className="block line-clamp-2 text-xs text-stone-200">
                        {item.title}
                      </span>
                      {item.subtitle && (
                        <span className="mt-0.5 block truncate text-[11px] text-stone-500">
                          {item.subtitle}
                        </span>
                      )}
                      {item.fixHint && (
                        <span className="mt-1 block text-[11px] leading-snug text-stone-300">
                          {item.fixHint}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
