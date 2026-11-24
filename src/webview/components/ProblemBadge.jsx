import SeverityIcon from "./SeverityIcon";

// The colour is on the icon and the border, never the number: red or amber digits on a tinted
// box fall below WCAG AA in light themes (4.3:1), while an icon needs 3:1. The number stays in
// the strong text colour, which the themes suite measures.
const LOOK = {
  error: { severity: "error", className: "border-error/60", icon: "text-error" },
  warning: { severity: "warning", className: "border-warning/60", icon: "text-warning" },
  none: { severity: "info", className: "border-line", icon: "text-fg-soft" },
};

/**
 * A box's problem count, with the icon and colour of its worst problem (issue 555): a circled
 * X for an error, a triangle for warnings only, as in the Problems panel (issue 303). The number is
 * every problem on the box, so the boxes still add up to the Issues count (issue 393). The
 * shape tells error from warning without colour; `title` says it in words.
 */
export default function ProblemBadge({ count, tone, title, shape = "rounded-full" }) {
  const look = LOOK[tone] ?? LOOK.none;
  const words = title || `${count} issue${count === 1 ? "" : "s"}`;
  return (
    <span
      title={words}
      aria-label={words}
      data-problem-badge={look.severity}
      data-problem-count={count}
      className={`flex h-5 shrink-0 items-center gap-1 border px-1.5 text-[10px] font-semibold text-fg-strong ${shape} ${look.className}`}
    >
      <SeverityIcon severity={look.severity} size={11} strokeWidth={2.2} aria-hidden="true" className={look.icon} />
      {count}
    </span>
  );
}
