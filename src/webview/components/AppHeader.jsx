import { ClipboardCopy } from "lucide-react";
import GraphModeToggle from "./GraphModeToggle";
import SearchBox from "./SearchBox";

export default function AppHeader({
  bundleName,
  targetLabel,
  targetTitle,
  targetMode,
  targetOptions,
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
      className="flex h-12 shrink-0 items-center gap-3 border-b border-stone-800/50 px-4"
      style={{ backgroundColor: "#0d0d0d" }}
    >
      <span className="truncate text-sm font-semibold text-stone-200">
        {bundleName ?? "Bundle Inspector"}
      </span>
      <span
        title={targetTitle}
        className="hidden shrink-0 rounded-md border border-stone-800 bg-stone-900/70 px-2 py-0.5 text-[11px] text-stone-400 md:inline-flex"
      >
        structural preview
      </span>
      {jobKeys.length > 0 && <span className="text-xs text-stone-700">·</span>}
      {jobKeys.length > 1 ? (
        <select
          value={selectedJobKey ?? ""}
          onChange={(e) => onJobChange(e.target.value)}
          className="cursor-pointer rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-200 outline-none focus:border-blue-400"
        >
          {jobOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : jobKeys.length === 1 ? (
        <span className="truncate text-xs text-stone-400">
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
          className="hidden shrink-0 items-center gap-1.5 rounded-md border border-stone-700 bg-stone-900 px-2 py-1 text-xs text-stone-300 outline-none hover:border-stone-600 hover:bg-stone-800 hover:text-stone-100 focus:border-blue-400 md:inline-flex"
          title="Copy bundle review summary"
        >
          <ClipboardCopy size={13} />
          <span>Copy review</span>
        </button>
      )}
    </header>
  );
}
