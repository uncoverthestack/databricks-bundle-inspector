import { kindMeta } from "../lib/kindMeta";

export default function NodeLegend({ items }) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-6 border-t border-stone-800/40 px-5"
      style={{ backgroundColor: "#0a0a0a" }}
    >
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: kindMeta(item.kind).color }}
          />
          <span className="text-[10px] tracking-wide text-stone-500">
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}
