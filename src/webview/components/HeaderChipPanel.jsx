import { X } from "lucide-react";
import { kindMeta } from "../lib/kindMeta";
import { severityMeta } from "../lib/issueSeverity";
import { hasTextSelection } from "../lib/textSelection";
import SeverityIcon from "./SeverityIcon";

export default function HeaderChipPanel({ title, items, onClose, onSelectItem }) {
  const groups = new Map();
  for (const item of items) {
    const groupItems = groups.get(item.group) ?? [];
    groupItems.push(item);
    groups.set(item.group, groupItems);
  }

  return (
    // Never taller than the space below the header, so it fits a short webview.
    <div className="absolute right-4 top-14 z-30 flex max-h-[calc(100%-4.5rem)] w-[360px] flex-col overflow-hidden rounded-lg border border-line-strong bg-widget shadow-popover">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <div>
          <div className="text-xs font-semibold text-fg">{title}</div>
          <div className="text-[11px] text-muted">
            {items.length} {items.length === 1 ? "item" : "items"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted outline-none hover:bg-hover hover:text-fg focus:ring-1 focus:ring-accent"
          aria-label={`Close ${title}`}
        >
          <X size={14} />
        </button>
      </div>
      <div className="max-h-[420px] min-h-0 flex-1 overflow-auto overscroll-contain py-1">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            {title === "Bundle Issues"
              ? "No issues found in this bundle."
              : `No ${title.toLowerCase()} found for this job.`}
          </div>
        ) : (
          [...groups.entries()].map(([group, groupItems]) => (
            <section key={group} className="py-1">
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
                {group} · {groupItems.length}
              </div>
              {groupItems.map((item) => {
                const clickable = Boolean(item.taskId || item.file);
                const meta = kindMeta(item.kind);
                return (
                  // A div, not a button: text inside a button cannot be selected and copied.
                  <div
                    key={item.id}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    title={clickable ? "Open source location" : undefined}
                    onClick={
                      clickable
                        ? () => {
                            if (hasTextSelection()) return;
                            onSelectItem(item);
                          }
                        : undefined
                    }
                    onKeyDown={
                      clickable
                        ? (event) => event.key === "Enter" && onSelectItem(item)
                        : undefined
                    }
                    className={[
                      "flex w-full items-start gap-2 px-3 py-2 text-left outline-none",
                      clickable
                        ? "cursor-pointer hover:bg-hover focus:bg-hover"
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
                      <span title={item.title} className="block line-clamp-2 text-xs text-fg">
                        {item.title}
                      </span>
                      {item.subtitle && (
                        <span className="mt-0.5 block truncate text-[11px] text-muted">
                          {item.subtitle}
                        </span>
                      )}
                      {item.fixHint && (
                        <span className="mt-1 block text-[11px] leading-snug text-fg-soft">
                          {item.fixHint}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
