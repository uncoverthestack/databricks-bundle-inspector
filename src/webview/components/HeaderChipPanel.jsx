import { AlertTriangle, X } from "lucide-react";
import { kindMeta } from "../lib/kindMeta";

export default function HeaderChipPanel({ title, items, onClose, onSelectItem }) {
  const groups = new Map();
  for (const item of items) {
    const groupItems = groups.get(item.group) ?? [];
    groupItems.push(item);
    groups.set(item.group, groupItems);
  }

  return (
    <div className="absolute right-4 top-14 z-30 w-[360px] overflow-hidden rounded-lg border border-stone-800 bg-stone-950 shadow-2xl">
      <div className="flex items-center justify-between border-b border-stone-800 px-3 py-2">
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
      <div className="max-h-[420px] overflow-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-stone-500">
            No {title.toLowerCase()} found for this job.
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
                      <AlertTriangle
                        size={13}
                        className={
                          item.severity === "error"
                            ? "mt-0.5 shrink-0 text-red-400"
                            : "mt-0.5 shrink-0 text-yellow-400"
                        }
                      />
                    ) : (
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: meta.color }}
                      />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-stone-200">
                        {item.title}
                      </span>
                      {item.subtitle && (
                        <span className="mt-0.5 block truncate text-[11px] text-stone-500">
                          {item.subtitle}
                        </span>
                      )}
                      {item.fixHint && (
                        <span className="mt-1 block text-[11px] leading-snug text-stone-600">
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
