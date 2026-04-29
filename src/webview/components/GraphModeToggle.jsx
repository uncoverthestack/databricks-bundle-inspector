export default function GraphModeToggle({ value, onChange }) {
  const options = [
    { value: "all", label: "All" },
    { value: "issues", label: "Issues" },
  ];
  return (
    <div className="flex h-7 shrink-0 overflow-hidden rounded-md border border-stone-800 bg-stone-950">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={[
              "border-r border-stone-800 px-2.5 text-[11px] last:border-r-0",
              active
                ? "bg-stone-800 text-stone-100"
                : "text-stone-500 hover:bg-stone-900 hover:text-stone-300",
              "outline-none focus:ring-1 focus:ring-blue-500/40",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
