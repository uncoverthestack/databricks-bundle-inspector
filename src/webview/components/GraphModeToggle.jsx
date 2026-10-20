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
    <div className="flex h-7 shrink-0 overflow-hidden rounded-md border border-line bg-input">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={[
              "border-r border-line px-2.5 text-[11px] last:border-r-0",
              active
                ? "bg-hover text-fg"
                : "text-muted hover:bg-hover hover:text-fg-soft",
              "outline-none focus:ring-1 focus:ring-accent",
            ].join(" ")}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                className={[
                  "ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
                  active
                    ? "bg-error/20 text-fg-strong"
                    : "bg-error/15 text-fg-strong",
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
