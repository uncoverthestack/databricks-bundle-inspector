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
}) {
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b border-stone-800/50 px-4"
      style={{ backgroundColor: "#0d0d0d" }}
    >
      <span className="truncate text-sm font-semibold text-stone-200">
        {bundleName ?? "Bundle Inspector"}
      </span>
      {targetOptions.length > 0 ? (
        <select
          title={targetTitle}
          value={selectedTarget ?? ""}
          onChange={(e) => onTargetChange(e.target.value || undefined)}
          className={[
            "hidden cursor-pointer rounded-md border px-2 py-1 text-xs outline-none focus:border-blue-400 md:block",
            targetMode === "probe"
              ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-300"
              : "border-stone-700 bg-stone-900 text-stone-300",
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
          className={[
            "hidden shrink-0 rounded-md border px-2 py-0.5 text-[11px] md:inline-flex",
            targetMode === "probe"
              ? "border-yellow-500/25 bg-yellow-500/10 text-yellow-300"
              : "border-stone-800 bg-stone-900/70 text-stone-400",
          ].join(" ")}
        >
          {targetLabel}
        </span>
      )}
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
      />
    </header>
  );
}
