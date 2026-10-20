import { ClipboardCopy } from "lucide-react";
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
  jobKeys,
  selectedJobKey,
  jobOptions,
  onJobChange,
  searchValue,
  searchItems,
  onSearchChange,
  onSearchSelect,
  graphMode,
  onGraphModeChange,
  issueCount,
  onCopyReviewSummary,
}) {
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b border-line-soft px-4"
      style={{ backgroundColor: UI_COLOR.panel }}
    >
      <span className="truncate text-sm font-semibold text-fg">
        {bundleName ?? "Bundle Inspector"}
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
      {jobKeys.length > 0 && <span className="text-xs text-muted">·</span>}
      {jobKeys.length > 1 ? (
        <select
          value={selectedJobKey ?? ""}
          onChange={(e) => onJobChange(e.target.value)}
          className="cursor-pointer rounded-md border border-line bg-widget px-2 py-1 text-xs text-fg outline-none focus:border-accent"
        >
          {jobOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : jobKeys.length === 1 ? (
        <span className="truncate text-xs text-fg-soft">
          {selectedJobKey}
        </span>
      ) : null}
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
      {onCopyReviewSummary && (
        <button
          type="button"
          onClick={onCopyReviewSummary}
          className="hidden shrink-0 items-center gap-1.5 rounded-md border border-line bg-widget px-2 py-1 text-xs text-fg-soft outline-none hover:border-line-strong hover:bg-hover hover:text-fg focus:border-accent md:inline-flex"
          title="Copy bundle review summary"
        >
          <ClipboardCopy size={13} />
          <span>Copy review</span>
        </button>
      )}
    </header>
  );
}
