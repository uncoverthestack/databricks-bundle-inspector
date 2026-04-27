export default function GraphModeToggle({ value, onChange, disabled }) {
  const options = [
    { value: "all", label: "All" },
    { value: "issues", label: "Issues" },
    { value: "upstream", label: "Upstream" },
    { value: "downstream", label: "Downstream" },
  ];
  return (
    <div className="flex h-7 shrink-0 overflow-hidden rounded-md border border-stone-800 bg-stone-950">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={
              disabled && option.value !== "all" && option.value !== "issues"
            }
            onClick={() => onChange(option.value)}
            className={[
              "border-r border-stone-800 px-2.5 text-[11px] last:border-r-0",
              active
                ? "bg-stone-800 text-stone-100"
                : "text-stone-500 hover:bg-stone-900 hover:text-stone-300",
              disabled && option.value !== "all" && option.value !== "issues"
                ? "cursor-not-allowed opacity-45"
                : "outline-none focus:ring-1 focus:ring-blue-500/40",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
