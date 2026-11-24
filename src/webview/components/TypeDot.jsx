import { kindMeta } from "../lib/kindMeta";

/**
 * A small dot in the colour of an item's type family (what runs, code, compute, or grey for
 * the rest; see kindMeta), so kinds of thing can be scanned by colour. The type itself is
 * written out beside it in Databricks' words, never as a code the inspector made up (issue 400).
 *
 * A secret scope gets a key instead, in the same grey, so scopes are found by shape. Never
 * yellow: amber means a warning across the panel (issue 535).
 */
export default function TypeDot({ kind }) {
  const color = kindMeta(kind).color;
  if (kind === "secret_scope") {
    return (
      <svg
        aria-hidden="true"
        data-type-dot={kind}
        data-type-icon="key"
        viewBox="0 0 16 16"
        className="h-3 w-3 shrink-0"
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <circle cx="5" cy="8" r="2.75" />
        <path d="M7.75 8h6.5M12 8v2.25M14.25 8v1.5" />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-type-dot={kind}
      style={{ backgroundColor: color }}
      className="h-2 w-2 shrink-0 rounded-full"
    />
  );
}
