// @ts-check
import { Search } from "lucide-react";
import { useState } from "react";
import ProblemBadge from "./ProblemBadge";
import TypeDot from "./TypeDot";

/**
 * A job's task, or a box on the bundle overview.
 * @typedef {(import("../lib/headerItems").SearchItem & { overviewId?: undefined, source?: undefined })
 *   | import("../lib/headerItems").OverviewSearchItem} SearchResult
 */

/**
 * @param {{
 *   value: string,
 *   items: SearchResult[],
 *   onChange: (value: string) => void,
 *   onSelect: (item: SearchResult) => void,
 *   placeholder?: string,
 * }} props
 */
export default function SearchBox({ value, items, onChange, onSelect, placeholder = "Search tasks" }) {
  const normalized = value.trim().toLowerCase();
  const matches = normalized
    ? items
        .filter((item) =>
          `${item.label} ${item.subtitle}`.toLowerCase().includes(normalized),
        )
        .slice(0, 8)
    : [];
  // Below lg the search is the first thing in the header to give up its room: just its icon
  // until clicked or holding text, so the name and the target keep theirs (issues 551, 553).
  const [focused, setFocused] = useState(false);
  const open = focused || value !== "";

  return (
    <div
      data-search-open={open}
      className={
        open
          ? "relative w-40 lg:w-64"
          : "relative w-8 lg:w-64"
      }
    >
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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={placeholder}
        title={placeholder}
        placeholder={placeholder}
        className={`h-7 w-full rounded-md border border-line bg-input pl-8 pr-2 text-xs text-fg outline-none focus:border-accent ${
          open ? "placeholder:text-muted" : "cursor-pointer placeholder:text-transparent lg:cursor-text lg:placeholder:text-muted"
        }`}
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
                <TypeDot kind={item.kind} dot={!item.overviewId} ring={Boolean(item.overviewId) && item.source === "default"} />
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
