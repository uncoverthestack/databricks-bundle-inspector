export default function StatChip({ label, value, tone = "neutral", title, onClick }) {
  const toneClass =
    tone === "danger"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : "border-stone-800 bg-stone-900/60 text-stone-300";
  const Component = onClick ? "button" : "span";
  return (
    <Component
      title={title}
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={[
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px]",
        onClick
          ? "cursor-pointer outline-none hover:bg-stone-800 focus:ring-1 focus:ring-blue-500/40"
          : "",
        toneClass,
      ].join(" ")}
    >
      <span className="text-stone-500">{label}</span>
      <span className="font-semibold">{value}</span>
    </Component>
  );
}
