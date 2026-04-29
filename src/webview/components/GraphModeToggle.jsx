export default function GraphModeToggle({ value, onChange, issueCount = 0 }) {
  const options = [
    { value: "all", label: "All" },
    {
      value: "issues",
      label: "Issues",
      count: issueCount > 0 ? issueCount : undefined,
    },
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
            {option.count !== undefined && (
              <span
                className={[
                  "ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
                  active
                    ? "bg-red-500/25 text-red-200"
                    : "bg-red-500/15 text-red-300",
                ].join(" ")}
              >
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
