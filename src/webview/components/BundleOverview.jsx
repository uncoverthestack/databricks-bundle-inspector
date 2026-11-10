import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { kindMeta } from "../lib/kindMeta";
import {
  findMatches,
  foldedGroupIds,
  isUnchecked,
  itemNote,
  linkedIds,
  linksOf,
  litByFind,
  namedOutside,
  problemContext,
  problemsFirst,
  showsAllLines,
  sourceSentence,
  typeWords,
} from "../lib/overviewView";
import { UI_COLOR } from "../lib/vscodeTheme";

const TAGGED_KINDS = new Set(["job", "pipeline", "warehouse", "cluster", "secret_scope"]);
const COLUMNS = [
  { id: "workloads", title: "Workloads", empty: "Nothing in this bundle runs or shows data." },
  { id: "uses", title: "What they use", empty: "No compute, secrets or data in this bundle." },
];

/** A job or pipeline of this bundle has its own graph to open. */
function opens(item) {
  return (item.kind === "job" || item.kind === "pipeline") && item.source === "bundle" && Boolean(item.resourceKey);
}

function problemCount(item) {
  return item.problems.errors + item.problems.warnings;
}

function problemWords(item) {
  const { errors, warnings } = item.problems;
  return [
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** One box: a resource, or something the bundle names from outside. */
function OverviewRow({ item, note, state, onHover, onToggle, onOpen, register }) {
  const meta = kindMeta(item.kind);
  const problems = problemCount(item);
  const selected = state === "selected";
  const related = state === "related";
  const canOpen = Boolean(onOpen) && opens(item);
  const row = (
    <button
      ref={(element) => register(item.id, element)}
      type="button"
      data-overview-item={item.id}
      aria-pressed={selected}
      title={[`${typeWords(item)} ${item.label}`, sourceSentence(item), problems ? problemWords(item) : ""]
        .filter(Boolean)
        .join("\n")}
      onMouseEnter={() => onHover(item.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(item.id)}
      onBlur={() => onHover(null)}
      onClick={() => onToggle(item.id)}
      onDoubleClick={canOpen ? () => onOpen(item) : undefined}
      onKeyDown={
        canOpen
          ? (event) => {
              // Enter opens the job or pipeline. Space selects it, as on every box.
              if (event.key !== "Enter") return;
              event.preventDefault();
              onOpen(item);
            }
          : undefined
      }
      style={{
        borderColor: item.problems.errors
          ? UI_COLOR.error
          : selected
            ? UI_COLOR.accent
            : related
              ? // Full strength: a paler blue falls under 3:1 against the canvas in most themes.
                UI_COLOR.accent
              : UI_COLOR.boxLine,
        backgroundColor: selected
          ? `color-mix(in srgb, ${UI_COLOR.accent} 10%, ${UI_COLOR.widget})`
          : UI_COLOR.widget,
        opacity: state === "dimmed" ? 0.48 : 1,
      }}
      className={`relative z-10 flex h-10 w-full items-center gap-2.5 rounded-xl border pl-3 text-left transition-colors hover:border-fg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        canOpen ? "pr-[4.25rem]" : "pr-3"
      } ${namedOutside(item) ? "border-dashed" : "border-solid"}`}
    >
      {TAGGED_KINDS.has(item.kind) && (
        // The tag sits on the plain box colour, so a selected box's blue tint does not dull it.
        <span style={{ backgroundColor: UI_COLOR.widget }} className="flex shrink-0 rounded-md">
          <span
            style={{ color: meta.color, backgroundColor: meta.bg }}
            className="rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold leading-none"
          >
            {meta.code}
          </span>
        </span>
      )}
      <span className="max-w-[65%] shrink-0 truncate text-[13px] font-medium text-fg">{item.label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted">{note}</span>
      {problems > 0 && (
        <span
          title={problemWords(item)}
          className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold text-fg-strong ${
            item.problems.errors ? "bg-error/15" : "bg-warning/15"
          }`}
        >
          {problems}
        </span>
      )}
    </button>
  );
  if (!canOpen) return row;
  // The Open link sits on the box, not in it: a button cannot hold another button.
  return (
    <div className="relative">
      {row}
      <button
        type="button"
        data-overview-open={item.id}
        aria-label={`Open ${typeWords(item)} ${item.label}`}
        title={`Open the ${typeWords(item)}'s graph`}
        onClick={() => onOpen(item)}
        onMouseEnter={() => onHover(item.id)}
        onMouseLeave={() => onHover(null)}
        style={{ opacity: state === "dimmed" ? 0.48 : 1 }}
        className="absolute right-2 top-1/2 z-20 -translate-y-1/2 rounded-md px-1.5 py-1 text-[11px] text-link hover:bg-hover hover:text-link-active focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        Open ›
      </button>
    </div>
  );
}

/** What the selected box is, where it is defined, and what it is linked to. */
function OverviewDetails({ overview, item, itemById, onSelect, onOpen, onOpenFile, onClose }) {
  const links = linksOf(overview, item.id);
  const uses = links.filter((link) => link.from === item.id);
  const usedBy = links.filter((link) => link.to === item.id);
  const fileName = item.file ? item.file.split(/[\\/]/).pop() : "";
  const linkList = (title, list, otherEnd) =>
    list.length > 0 && (
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{title}</div>
        {list.map((link) => {
          const other = itemById.get(link[otherEnd]);
          if (!other) return null;
          return (
            <button
              key={`${link.from}->${link.to}`}
              type="button"
              onClick={() => onSelect(other.id)}
              className="flex items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-xs text-fg hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="shrink-0 font-medium">{other.label}</span>
              <span className="min-w-0 truncate text-muted">
                {link.taskNames.length > 0 ? link.taskNames.join(", ") : typeWords(other)}
              </span>
            </button>
          );
        })}
      </div>
    );
  return (
    <aside
      aria-label={`${typeWords(item)} ${item.label}`}
      data-overview-details={item.id}
      className="flex shrink-0 flex-col gap-3 border-t border-line bg-panel p-4 @5xl:w-80 @5xl:overflow-y-auto @5xl:border-l @5xl:border-t-0"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-muted">{typeWords(item)}</div>
          <div className="truncate text-base font-semibold text-fg" title={item.label}>
            {item.label}
          </div>
        </div>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="rounded-md px-1.5 text-sm text-muted hover:bg-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          ×
        </button>
      </div>
      <div className="text-xs leading-5 text-fg-soft">{sourceSentence(item)}</div>
      {onOpen && opens(item) && (
        <button
          type="button"
          data-overview-details-open
          onClick={() => onOpen(item)}
          className="self-start rounded-md border border-line bg-widget px-2.5 py-1 text-xs font-medium text-fg hover:border-line-strong hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open {typeWords(item)} graph
        </button>
      )}
      {item.file && (
        <button
          type="button"
          onClick={() => onOpenFile?.(item.file, item.line)}
          data-overview-open-file
          className="self-start text-xs text-link hover:text-link-active focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {fileName}
          {item.line ? `:${item.line}` : ""}
        </button>
      )}
      {problemCount(item) > 0 && (
        <div className="text-xs text-fg-soft">{problemWords(item)}. The Problems panel lists them.</div>
      )}
      {linkList("Uses", uses, "to")}
      {linkList("Used by", usedBy, "from")}
      {item.source === "bundle" && !item.hasChecks && (
        <div className="rounded-lg border border-dashed border-line px-3 py-2 text-xs leading-5 text-muted">
          Not checked yet. The inspector shows this resource but has no checks for its type.
        </div>
      )}
    </aside>
  );
}

/**
 * The bundle overview: every resource as a box in two columns, with the links between
 * them. Pointing at a box, or focusing it, lights up what it is linked to; clicking keeps
 * it lit and shows its details. In a narrow panel the columns stack and no lines are drawn.
 */
export default function BundleOverview({
  overview,
  background,
  selectedId,
  onSelect,
  onOpen,
  onOpenFile,
  // Typed in the header's search box: matching boxes stay lit, the rest fade.
  find = "",
  // The header's Issues switch: only boxes with a problem, and what they link to.
  problemsOnly = false,
  onShowAll,
  // Holds how far the overview was scrolled, kept by the panel while a job or pipeline is open.
  scrollMemoryRef,
}) {
  const [hoverId, setHoverId] = useState(null);
  const setSelectedId = onSelect;
  const [opened, setOpened] = useState(() => new Set());
  const [paths, setPaths] = useState([]);
  const canvasRef = useRef(null);
  const rowElements = useRef(new Map());

  const itemById = useMemo(
    () => new Map(overview.groups.flatMap((group) => group.items).map((item) => [item.id, item])),
    [overview],
  );
  const selected = selectedId ? itemById.get(selectedId) : undefined;
  const activeId = hoverId ?? (selected ? selected.id : null);
  const lit = useMemo(() => (activeId ? linkedIds(overview, activeId) : new Set()), [overview, activeId]);
  const matches = useMemo(() => findMatches(overview, find), [overview, find]);
  const foundLit = useMemo(() => (matches ? litByFind(overview, matches) : null), [overview, matches]);
  const kept = useMemo(() => (problemsOnly ? problemContext(overview) : null), [overview, problemsOnly]);
  const hiddenCount = kept ? overview.groups.reduce((sum, group) => sum + group.items.filter((item) => !kept.has(item.id)).length, 0) : 0;
  const baseFolded = useMemo(() => foldedGroupIds(overview), [overview]);
  // A folded group with a match, or with a box kept by Issues, opens.
  const folded = useMemo(() => {
    const keep = foundLit ?? kept;
    if (!keep) return baseFolded;
    return new Set(
      [...baseFolded].filter((id) => !overview.groups.find((group) => group.id === id)?.items.some((item) => keep.has(item.id))),
    );
  }, [baseFolded, foundLit, kept, overview]);
  const allLines = showsAllLines(overview);

  const register = useCallback((id, element) => {
    if (element) rowElements.current.set(id, element);
    else rowElements.current.delete(id);
  }, []);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const origin = canvas.getBoundingClientRect();
    const next = [];
    // Stacked columns (a narrow panel) get no lines at all, not even within one column:
    // the boxes' notes and details say what they are linked to.
    const [left, right] = [...canvas.querySelectorAll(":scope > section")].map((column) => column.getBoundingClientRect());
    const stacked = Boolean(left && right && right.top >= left.bottom);
    for (const link of stacked ? [] : overview.links) {
      const from = rowElements.current.get(link.from)?.getBoundingClientRect();
      const to = rowElements.current.get(link.to)?.getBoundingClientRect();
      if (!from || !to) continue;
      const y1 = from.top + from.height / 2 - origin.top;
      const y2 = to.top + to.height / 2 - origin.top;
      let d;
      if (Math.abs(from.left - to.left) < 1) {
        // Same column. Stacked columns share one left edge too, and get no lines.
        if (itemById.get(link.from)?.column !== itemById.get(link.to)?.column) continue;
        const leftColumn = itemById.get(link.from)?.column === "workloads";
        const x = (leftColumn ? from.left : from.right) - origin.left;
        const bend = x + (leftColumn ? -26 : 26);
        d = `M${x} ${y1} C${bend} ${y1} ${bend} ${y2} ${x} ${y2}`;
      } else {
        const leftToRight = from.left < to.left;
        const x1 = (leftToRight ? from.right : from.left) - origin.left;
        const x2 = (leftToRight ? to.left : to.right) - origin.left;
        const middle = (x1 + x2) / 2;
        d = `M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}`;
      }
      next.push({ key: `${link.from}->${link.to}`, d, from: link.from, to: link.to, kind: link.kind });
    }
    setPaths((previous) =>
      previous.length === next.length && previous.every((path, index) => path.d === next[index].d && path.key === next[index].key)
        ? previous
        : next,
    );
  }, [overview, itemById]);

  useLayoutEffect(() => {
    measure();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [measure, opened, find, problemsOnly]);

  const stateOf = (item) => {
    if (selected?.id === item.id) return "selected";
    if (!activeId) return foundLit && !foundLit.has(item.id) ? "dimmed" : "plain";
    if (item.id === activeId || lit.has(item.id)) return "related";
    return "dimmed";
  };

  const toggle = (id) => setSelectedId(selectedId === id ? null : id);

  const scrollerRef = useRef(null);
  // Back from a job or pipeline: where it was scrolled to, else the selected box in view.
  useLayoutEffect(() => {
    const saved = scrollMemoryRef?.current ?? 0;
    if (saved > 0 && scrollerRef.current) scrollerRef.current.scrollTop = saved;
    else if (selectedId) rowElements.current.get(selectedId)?.scrollIntoView?.({ block: "nearest" });
    // Only when the overview appears, not on every selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="@container flex h-full flex-col @5xl:flex-row"
      style={background}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedId) {
          event.stopPropagation();
          setSelectedId(null);
        }
      }}
    >
      <div
        ref={scrollerRef}
        data-overview-scroller
        onScroll={(event) => {
          if (scrollMemoryRef) scrollMemoryRef.current = event.currentTarget.scrollTop;
        }}
        className="min-h-0 flex-1 overflow-auto"
      >
        <div ref={canvasRef} data-overview-canvas className="relative grid grid-cols-1 gap-x-28 gap-y-8 px-4 py-6 @3xl:grid-cols-2 @3xl:px-10">
          <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
            <defs>
              <marker id="overview-runs" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L8 4 L0 8 Z" fill="context-stroke" />
              </marker>
            </defs>
            {paths.map((path) => {
              const active =
                activeId !== null
                  ? path.from === activeId || path.to === activeId
                  : Boolean(matches) && (matches.has(path.from) || matches.has(path.to));
              if (!allLines && !active) return null;
              return (
                <path
                  key={path.key}
                  d={path.d}
                  fill="none"
                  data-overview-link={path.key}
                  stroke={active ? UI_COLOR.accent : UI_COLOR.boxLine}
                  strokeWidth={active ? 1.75 : 1.25}
                  opacity={(activeId !== null || matches) && !active ? 0.3 : 1}
                  markerEnd={path.kind === "runs" ? "url(#overview-runs)" : undefined}
                />
              );
            })}
          </svg>
          {COLUMNS.map((column) => {
            const groups = overview.groups
              .filter((group) => group.column === column.id)
              .map((group) => ({
                ...group,
                items: problemsFirst(kept ? group.items.filter((item) => kept.has(item.id)) : group.items),
              }))
              .filter((group) => group.items.length > 0);
            const open = groups.filter((group) => !folded.has(group.id) || opened.has(group.id));
            const closed = groups.filter((group) => folded.has(group.id) && !opened.has(group.id));
            return (
              <section key={column.id} aria-label={column.title} className="flex min-w-0 flex-col gap-4">
                <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{column.title}</h2>
                {groups.length === 0 && !kept && <div className="text-xs text-muted">{column.empty}</div>}
                {column.id === "workloads" && kept && kept.size === 0 && (
                  <div className="text-xs text-muted">No problems found in this bundle.</div>
                )}
                {open.map((group) => (
                  <div
                    key={group.id}
                    data-overview-group={group.id}
                    data-unchecked={isUnchecked(overview, group) || undefined}
                    className="flex flex-col gap-2"
                  >
                    <h3 className="text-xs text-fg-soft">
                      {group.name}
                      {isUnchecked(overview, group) && <span className="text-muted"> · not checked yet</span>}
                    </h3>
                    {group.items.map((item) => (
                      <OverviewRow
                        key={item.id}
                        item={item}
                        note={itemNote(overview, item)}
                        state={stateOf(item)}
                        onHover={setHoverId}
                        onToggle={toggle}
                        onOpen={onOpen}
                        register={register}
                      />
                    ))}
                  </div>
                ))}
                {column.id === "workloads" && hiddenCount > 0 && (
                  <button
                    type="button"
                    data-overview-show-all
                    onClick={onShowAll}
                    className="relative z-10 flex h-8 items-center gap-2 rounded-lg border border-line px-3 text-left text-xs text-muted hover:bg-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {hiddenCount} {hiddenCount === 1 ? "resource" : "resources"} with no problems
                    </span>
                    <span className="shrink-0">Show all ›</span>
                  </button>
                )}
                {closed.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-xs text-muted">Not checked yet</h3>
                    {closed.map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        aria-expanded={false}
                        onClick={() => setOpened((current) => new Set(current).add(group.id))}
                        className="relative z-10 flex h-8 items-center gap-2 rounded-lg border border-line px-3 text-left text-xs text-fg hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <span className="min-w-0 flex-1 truncate">{group.name}</span>
                        <span className="shrink-0 text-muted">
                          {group.items.length} {group.items.length === 1 ? "resource" : "resources"} ›
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      {selected && (
        <OverviewDetails
          overview={overview}
          item={selected}
          itemById={itemById}
          onSelect={setSelectedId}
          onOpen={onOpen}
          onOpenFile={onOpenFile}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
