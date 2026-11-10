import { useState } from "react";
import { Check } from "lucide-react";

/**
 * All / Issues. With nothing to filter (`issueCount` 0 and `nothingToFilterNote` set),
 * Issues is dimmed and does nothing; pointing at it, or reaching it with Tab, says why.
 * It stays reachable by keyboard on purpose, so the note is not mouse-only (issue 390).
 */
export default function GraphModeToggle({ value, onChange, issueCount = 0, nothingToFilterNote }) {
  const [noteShown, setNoteShown] = useState(false);
  const issuesUnavailable = Boolean(nothingToFilterNote) && issueCount === 0;
  const options = [
    { value: "all", label: "All" },
    {
      value: "issues",
      label: "Issues",
      count: issueCount > 0 ? issueCount : undefined,
    },
  ];
  return (
    <div className="relative flex h-7 shrink-0 rounded-md border border-line bg-input">
      {options.map((option) => {
        const unavailable = option.value === "issues" && issuesUnavailable;
        const active = value === option.value && !unavailable;
        return (
          <button
            key={option.value}
            type="button"
            aria-disabled={unavailable || undefined}
            aria-describedby={unavailable ? "graph-mode-nothing-to-filter" : undefined}
            data-graph-mode={option.value}
            onClick={() => {
              if (!unavailable) onChange(option.value);
            }}
            onMouseEnter={unavailable ? () => setNoteShown(true) : undefined}
            onMouseLeave={unavailable ? () => setNoteShown(false) : undefined}
            onFocus={unavailable ? () => setNoteShown(true) : undefined}
            onBlur={unavailable ? () => setNoteShown(false) : undefined}
            className={[
              "border-r border-line px-2.5 text-[11px] first:rounded-l-md last:rounded-r-md last:border-r-0",
              unavailable
                ? "cursor-default text-muted opacity-50"
                : active
                  ? "bg-hover text-fg"
                  : "text-muted hover:bg-hover hover:text-fg-soft",
              "outline-none focus:ring-1 focus:ring-accent",
            ].join(" ")}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={[
                  "ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
                  active
                    ? "bg-error/20 text-fg-strong"
                    : "bg-error/15 text-fg-strong",
                ].join(" ")}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
      {issuesUnavailable && (
        <div
          id="graph-mode-nothing-to-filter"
          role="tooltip"
          data-nothing-to-filter
          hidden={!noteShown}
          className="absolute right-0 top-full z-50 mt-1 flex items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-widget px-2 py-1 text-[11px] text-fg shadow-popover"
        >
          <Check size={12} className="shrink-0 text-ok" aria-hidden="true" />
          {nothingToFilterNote}
        </div>
      )}
    </div>
  );
}
