/**
 * Unicode's direction overrides, embeddings and isolates (U+202A to U+202E, U+2066 to U+2069)
 * reorder the text around them when a browser or editor shows it: a file written
 * `./src/` + U+202E + `yp.tset` + U+202C is shown as `./src/test.py` (checked in Chrome). Text
 * from a bundle shows each one as a visible `[U+202E]`, so a name can't pass for another.
 * Plain right-to-left letters and the U+200E/U+200F marks are left alone: they don't reverse
 * text that isn't right-to-left already.
 */
const DIRECTION_CONTROLS = /[‪-‮⁦-⁩]/g;

export function withVisibleDirectionControls(text: string): string {
  return text.replace(DIRECTION_CONTROLS, (char) => `[U+${char.codePointAt(0)!.toString(16).toUpperCase()}]`);
}
