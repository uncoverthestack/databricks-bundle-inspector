import { Search } from "lucide-react";
import { kindMeta } from "../lib/kindMeta";

export default function SearchBox({ value, items, onChange, onSelect }) {
  const normalized = value.trim().toLowerCase();
  const matches = normalized
    ? items
        .filter((item) =>
          `${item.label} ${item.subtitle}`.toLowerCase().includes(normalized),
        )
        .slice(0, 8)
    : [];

  return (
    <div className="relative min-w-56 max-w-96 flex-1">
      <Search
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search tasks"
        className="h-7 w-full rounded-md border border-line bg-input pl-8 pr-2 text-xs text-fg outline-none placeholder:text-muted focus:border-accent"
      />
      {matches.length > 0 && (
        <div className="absolute left-0 right-0 top-8 z-20 max-h-[calc(100vh-4rem)] overflow-auto overscroll-contain rounded-md border border-line bg-widget shadow-xl">
          {matches.map((item) => {
            const meta = kindMeta(item.kind);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item)}
                className="flex w-full items-center gap-2 border-b border-line-soft px-2.5 py-2 text-left last:border-0 hover:bg-hover"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: meta.color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">
                    {item.label}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    {item.subtitle}
                  </span>
                </span>
                {item.issueCount > 0 && (
                  <span className="shrink-0 rounded bg-error/15 px-1.5 text-[10px] font-semibold text-fg-strong">
                    {item.issueCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
