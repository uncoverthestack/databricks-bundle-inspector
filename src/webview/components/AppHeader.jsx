import { useEffect, useRef, useState } from "react";
import { ChevronDown, ClipboardCopy } from "lucide-react";
import GraphModeToggle from "./GraphModeToggle";
import SearchBox from "./SearchBox";
import { UI_COLOR } from "../lib/vscodeTheme";

export default function AppHeader({
  bundleName,
  targetLabel,
  targetTitle,
  targetMode,
  targetOptions = [],
  selectedTarget,
  onTargetChange,
  pickerGroups = [],
  selectedValue,
  onPickerChange,
  showTaskTools = true,
  searchValue,
  searchItems,
  onSearchChange,
  onSearchSelect,
  graphMode,
  onGraphModeChange,
  issueCount,
  onCopyReviewSummary,
  onCopyReviewReport,
}) {
  const options = pickerGroups.flatMap((group) => group.options);
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b border-line-soft px-4"
      style={{ backgroundColor: UI_COLOR.panel }}
    >
      <span className="truncate text-sm font-semibold text-fg">
        {bundleName ?? "Databricks Bundle Inspector"}
      </span>
      {targetOptions.length > 0 ? (
        <select
          aria-label="Target"
          title={targetTitle}
          value={selectedTarget ?? ""}
          onChange={(e) => onTargetChange?.(e.target.value || undefined)}
          className={[
            "hidden cursor-pointer rounded-md border px-2 py-1 text-xs outline-none focus:border-accent md:block",
            targetMode === "probe"
              ? "border-line bg-widget text-fg-soft"
              : "border-accent/40 bg-accent/10 text-link-active",
          ].join(" ")}
        >
          <option value="">structural preview</option>
          {targetOptions.map((target) => (
            <option key={target} value={target}>
              target: {target}
            </option>
          ))}
        </select>
      ) : (
        <span
          title={targetTitle}
          className="hidden shrink-0 rounded-md border border-line bg-widget px-2 py-0.5 text-[11px] text-fg-soft md:inline-flex"
        >
          {targetLabel ?? "structural preview"}
        </span>
      )}
      {options.length > 0 && <span className="text-xs text-muted">·</span>}
      {options.length > 1 ? (
        <select
          aria-label="Job or pipeline"
          value={selectedValue ?? ""}
          onChange={(e) => onPickerChange(e.target.value)}
          className="cursor-pointer rounded-md border border-line bg-widget px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        >
          {pickerGroups.length > 1
            ? pickerGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))
            : options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
        </select>
      ) : options.length === 1 ? (
        <span className="truncate text-xs text-fg-soft">{options[0].key}</span>
      ) : null}
      {/* Search and the Issues toggle work on a job's tasks; a pipeline has none. */}
      {showTaskTools ? (
        <>
          <SearchBox
            value={searchValue}
            items={searchItems}
            onChange={onSearchChange}
            onSelect={onSearchSelect}
          />
          <GraphModeToggle
            value={graphMode}
            onChange={onGraphModeChange}
            issueCount={issueCount}
          />
        </>
      ) : (
        <div className="flex-1" />
      )}
      {onCopyReviewSummary && onCopyReviewReport ? (
        <CopyReviewMenu onCopySummary={onCopyReviewSummary} onCopyReport={onCopyReviewReport} />
      ) : (
        onCopyReviewSummary && (
          <button
            type="button"
            onClick={onCopyReviewSummary}
            className={COPY_BUTTON}
            title="Copy bundle review summary"
          >
            <ClipboardCopy size={13} />
            <span>Copy review</span>
          </button>
        )
      )}
    </header>
  );
}

const COPY_BUTTON =
  "hidden shrink-0 items-center gap-1.5 rounded-md border border-line bg-widget px-2 py-1 text-xs text-fg-soft outline-none hover:border-line-strong hover:bg-hover hover:text-fg focus:border-accent md:inline-flex";

/** Copy review, as a menu: the short summary, or the full report with the task graph. */
function CopyReviewMenu({ onCopySummary, onCopyReport }) {
  const [open, setOpen] = useState(false);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.type === "keydown" ? event.key === "Escape" : !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const choose = (copy) => {
    setOpen(false);
    copy();
  };
  return (
    <div ref={menu} className="relative hidden shrink-0 md:block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={COPY_BUTTON}
      >
        <ClipboardCopy size={13} />
        <span>Copy review</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border border-line bg-widget text-xs text-fg shadow-lg"
        >
          <button type="button" role="menuitem" onClick={() => choose(onCopySummary)} className={MENU_ITEM}>
            <span className="block font-medium">Short summary</span>
            <span className="block text-fg-soft">Problems labelled as errors or warnings. For Slack, Teams or Jira.</span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onCopyReport)} className={MENU_ITEM}>
            <span className="block font-medium">Full report</span>
            <span className="block text-fg-soft">Adds a picture of the job and tables. Paste into GitHub or GitLab.</span>
          </button>
        </div>
      )}
    </div>
  );
}

const MENU_ITEM = "block w-full border-b border-line-soft px-3 py-2 text-left last:border-0 hover:bg-hover focus:bg-hover focus:outline-none";
