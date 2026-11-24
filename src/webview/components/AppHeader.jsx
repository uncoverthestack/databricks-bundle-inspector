import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ClipboardCopy } from "lucide-react";
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
  // The picker's value for the bundle overview, when the bundle has one.
  overviewValue,
  // Set inside a job or pipeline: goes back to the bundle overview.
  onBack,
  showTaskTools = true,
  showSearch = true,
  searchPlaceholder,
  searchValue,
  searchItems,
  onSearchChange,
  onSearchSelect,
  graphMode,
  onGraphModeChange,
  issueCount,
  // Set when Issues has nothing to filter: it is dimmed, and this says why (issue 390).
  nothingToFilterNote,
  onCopyReviewSummary,
  onCopyReviewReport,
  copyReviewTitle,
}) {
  const options = pickerGroups.flatMap((group) => group.options);
  return (
    <header
      className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-1 gap-y-1.5 border-b border-line-soft px-2 py-1.5 md:gap-x-3 md:px-4"
      style={{ backgroundColor: UI_COLOR.panel }}
    >
      {/* Where you are: the name and the job picker shorten as the panel narrows, the target
          never does. Both start at w-16 and grow to their full text, so this group's minimum
          width is small, and the tools wrap to a second row only below it (issue 553). */}
      <div className="flex flex-1 basis-0 items-center gap-1 md:gap-3" data-header-place>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            data-back-to-overview
            aria-label="Back to bundle overview"
            title="Back to bundle overview"
            className="-ml-1 flex w-16 max-w-max grow items-center gap-1 rounded-md px-1 py-0.5 text-sm font-semibold text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ArrowLeft size={14} className="shrink-0 text-fg-soft" />
            <span className="truncate">{bundleName ?? "Databricks Bundle Inspector"}</span>
          </button>
        ) : (
          <span className="w-16 max-w-max grow truncate text-sm font-semibold text-fg">
            {bundleName ?? "Databricks Bundle Inspector"}
          </span>
        )}
        {targetOptions.length > 0 ? (
          <select
            aria-label="Target"
            title={targetTitle}
            value={selectedTarget ?? ""}
            onChange={(e) => onTargetChange?.(e.target.value || undefined)}
            className={[
              // The target is never cut: it says how far to trust what the panel shows (issue 553).
              "shrink-0 cursor-pointer rounded-md border px-2 py-1 text-xs outline-none focus:border-accent",
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
            className="inline-flex shrink-0 rounded-md border border-line bg-widget px-2 py-0.5 text-[11px] text-fg-soft"
          >
            {targetLabel ?? "structural preview"}
          </span>
        )}
        {options.length > 0 && <span className="text-xs text-muted">·</span>}
        {options.length > 1 || (options.length === 1 && overviewValue) ? (
          <select
            aria-label="Job or pipeline"
            value={selectedValue ?? ""}
            onChange={(e) => onPickerChange(e.target.value)}
            className="w-16 max-w-56 grow cursor-pointer truncate rounded-md border border-line bg-widget px-2 py-1 text-xs text-fg outline-none focus:border-accent"
          >
            {overviewValue && <option value={overviewValue}>Bundle overview</option>}
            {pickerGroups.length > 1 || overviewValue
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
          <span className="w-16 max-w-max grow truncate text-xs text-fg-soft">{options[0].key}</span>
        ) : null}
      </div>
      {/* The tools: they keep their size, and go to a second row when the place can't shrink further. */}
      <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-3" data-header-tools>
        {/* Search and the Issues toggle work on a job's tasks; a pipeline has none. */}
        {showTaskTools ? (
          <>
            {/* Search finds a job's tasks, so the bundle overview has none. */}
            {showSearch ? (
              <SearchBox
                value={searchValue}
                items={searchItems}
                onChange={onSearchChange}
                onSelect={onSearchSelect}
                placeholder={searchPlaceholder}
              />
            ) : null}
            <GraphModeToggle
              value={graphMode}
              onChange={onGraphModeChange}
              issueCount={issueCount}
              nothingToFilterNote={nothingToFilterNote}
            />
          </>
        ) : null}
        {onCopyReviewSummary && onCopyReviewReport ? (
          <CopyReviewMenu onCopySummary={onCopyReviewSummary} onCopyReport={onCopyReviewReport} />
        ) : (
          onCopyReviewSummary && (
            <button
              type="button"
              onClick={onCopyReviewSummary}
              className={COPY_BUTTON}
              title={copyReviewTitle ?? "Copy bundle review summary as Markdown"}
              aria-label="Copy review"
            >
              <ClipboardCopy size={13} />
              <span className={COPY_LABEL}>Copy review</span>
            </button>
          )
        )}
      </div>
    </header>
  );
}

const COPY_BUTTON =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-widget px-2 py-1 text-xs text-fg-soft outline-none hover:border-line-strong hover:bg-hover hover:text-fg focus:border-accent";
// Below lg the button drops its words, after the search box and before the name or the
// target are cut (issues 551, 553). The tooltip still names it.
const COPY_LABEL = "hidden lg:inline";

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
    <div ref={menu} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Copy review"
        title="Copy review"
        className={COPY_BUTTON}
      >
        <ClipboardCopy size={13} />
        <span className={COPY_LABEL}>Copy review</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border border-line-strong bg-widget text-xs text-fg shadow-popover"
        >
          <button type="button" role="menuitem" onClick={() => choose(onCopySummary)} className={MENU_ITEM}>
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium">Short summary</span>
              <MarkdownTag />
            </span>
            <span className="block text-fg-soft">Problems labelled as errors or warnings. For Slack, Teams or Jira.</span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onCopyReport)} className={MENU_ITEM}>
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium">Full report</span>
              <MarkdownTag />
            </span>
            <span className="block text-fg-soft">Adds a picture of the job and tables. Paste into GitHub or GitLab.</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Says what lands on the clipboard: Markdown, which GitHub and GitLab show formatted. */
function MarkdownTag() {
  return (
    <span
      title="Markdown text. GitHub and GitLab show it formatted."
      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-1 text-[10px] text-fg-soft"
    >
      {/* The Markdown mark: an M and a down arrow. lucide-react has no icon for it. */}
      <svg aria-hidden="true" width="14" height="9" viewBox="0 0 28 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 14V4l4 5 4-5v10" />
        <path d="M20 4v9" />
        <path d="m16.5 10 3.5 4 3.5-4" />
      </svg>
      Markdown
    </span>
  );
}

const MENU_ITEM = "block w-full border-b border-line-soft px-3 py-2 text-left last:border-0 hover:bg-hover focus:bg-hover focus:outline-none";
