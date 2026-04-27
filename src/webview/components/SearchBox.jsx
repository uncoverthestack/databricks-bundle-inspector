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
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500"
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search tasks"
        className="h-7 w-full rounded-md border border-stone-800 bg-stone-950 pl-8 pr-2 text-xs text-stone-200 outline-none placeholder:text-stone-600 focus:border-blue-500"
      />
      {matches.length > 0 && (
        <div className="absolute left-0 right-0 top-8 z-20 overflow-hidden rounded-md border border-stone-800 bg-stone-950 shadow-xl">
          {matches.map((item) => {
            const meta = kindMeta(item.kind);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item)}
                className="flex w-full items-center gap-2 border-b border-stone-800/60 px-2.5 py-2 text-left last:border-0 hover:bg-stone-900"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: meta.color }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-stone-200">
                    {item.label}
                  </span>
                  <span className="block truncate text-[11px] text-stone-500">
                    {item.subtitle}
                  </span>
                </span>
                {item.issueCount > 0 && (
                  <span className="shrink-0 rounded bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-300">
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
