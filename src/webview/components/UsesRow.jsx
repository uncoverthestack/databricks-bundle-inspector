import TypeDot from "./TypeDot";

const KIND_LABEL = {
  warehouse: "SQL warehouse",
  cluster: "cluster",
  secret_scope: "secret scope",
};

/** One line on where the name comes from, for the tooltip. */
function sourceLine(item) {
  switch (item.source) {
    case "bundle":
      return "Defined in this bundle";
    case "variable":
      return `From a variable: ${item.expression}`;
    case "fixed":
      return item.expression && item.expression !== item.label
        ? `Written in as ${item.expression}`
        : "Written in as an ID or name, not defined in this bundle";
    case "default":
      return "No compute set: the task runs on serverless or inherited compute";
    case "workspace":
      return "Not defined in this bundle";
    default:
      return "";
  }
}

function tooltip(item) {
  const used = `Used by ${item.taskNames.join(", ")}`;
  return [`${KIND_LABEL[item.kind]} ${item.label}`, sourceLine(item), used].filter(Boolean).join("\n");
}

/**
 * The "Uses" row above a job's graph. A solid chip is defined in this bundle; a dashed one
 * is named by a variable or an ID, is a scope from outside the bundle, or is the default
 * compute. Pointing at a chip, or focusing it, lights up its tasks; clicking keeps them lit.
 */
export default function UsesRow({ items, activeId, pinnedId, onHover, onTogglePin }) {
  if (!items?.length) return null;
  return (
    <div
      role="group"
      aria-label="What this job uses"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2"
    >
      <span className="text-[11px] text-muted">Uses</span>
      {items.map((item) => {
        const active = item.id === activeId;
        const pinned = item.id === pinnedId;
        const count = item.taskIds.length;
        return (
          <button
            key={item.id}
            type="button"
            title={tooltip(item)}
            aria-pressed={pinned}
            aria-label={`${KIND_LABEL[item.kind]} ${item.label}, ${count} ${count === 1 ? "task" : "tasks"}. ${sourceLine(item)}`}
            onMouseEnter={() => onHover(item.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(item.id)}
            onBlur={() => onHover(null)}
            onClick={() => onTogglePin(item.id)}
            className={`flex max-w-[340px] items-center gap-1.5 rounded-full border py-0.5 pl-2.5 pr-2.5 text-xs text-fg transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              item.source === "bundle" ? "border-solid" : "border-dashed"
            } ${active || pinned ? "border-accent bg-hover" : "border-line-strong"}`}
          >
            <TypeDot kind={item.kind} />
            <span className="truncate">{item.label}</span>
            <span className="shrink-0 text-muted">
              {/* Serverless isn't a cluster: Databricks calls it serverless compute. */}
              · {item.source === "default" ? "compute" : KIND_LABEL[item.kind]} · {count} {count === 1 ? "task" : "tasks"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
