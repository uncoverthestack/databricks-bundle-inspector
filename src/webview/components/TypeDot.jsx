import { kindMeta } from "../lib/kindMeta";

/**
 * A small dot in the colour of an item's type family (what runs, code, compute, or grey for
 * the rest; see kindMeta), so kinds of thing can be scanned by colour. The type itself is
 * written out beside it in Databricks' words, never as a code the inspector made up (issue 400).
 */
export default function TypeDot({ kind }) {
  return (
    <span
      aria-hidden="true"
      data-type-dot={kind}
      style={{ backgroundColor: kindMeta(kind).color }}
      className="h-2 w-2 shrink-0 rounded-full"
    />
  );
}
