import { Search } from "lucide-react";
import ProblemBadge from "./ProblemBadge";
import TypeDot from "./TypeDot";

export default function SearchBox({ value, items, onChange, onSelect, placeholder = "Search tasks" }) {
  const normalized = value.trim().toLowerCase();
  const matches = normalized
    ? items
        .filter((item) =>
          `${item.label} ${item.subtitle}`.toLowerCase().includes(normalized),
        )
        .slice(0, 8)
    : [];

  return (
    <div className="relative min-w-12 max-w-96 flex-1 md:min-w-24">
      <Search
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
        aria-label={placeholder}
        placeholder={placeholder}
        className="h-7 w-full rounded-md border border-line bg-input pl-8 pr-2 text-xs text-fg outline-none placeholder:text-transparent focus:border-accent md:placeholder:text-muted"
      />
      {matches.length > 0 && (
        <div className="absolute left-0 right-0 top-8 z-20 max-h-[calc(100vh-4rem)] overflow-auto overscroll-contain rounded-md border border-line-strong bg-widget shadow-popover">
          {matches.map((item) => {
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item)}
                className="flex w-full items-center gap-2 border-b border-line-soft px-2.5 py-2 text-left last:border-0 hover:bg-hover"
              >
                {/* An overview box's result shows the box's icon; a task's keeps the task box's dot (issue 546). */}
                <TypeDot kind={item.kind} dot={!item.overviewId || item.source === "default"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">
                    {item.label}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    {item.subtitle}
                  </span>
                </span>
                {/* The same badge as the box: icon and colour of its worst problem (issue 555). */}
                {item.issueCount > 0 && <ProblemBadge count={item.issueCount} tone={item.problemTone} shape="rounded" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
