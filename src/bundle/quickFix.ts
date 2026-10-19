/** Where a value sits in a line of YAML, as character offsets: `start` up to, not including, `end`. */
export interface TextSpan {
  start: number;
  end: number;
}

const QUOTES = new Set(['"', "'"]);

/** Where a YAML comment starts on the line: a `#` after a space or at the start, outside quotes. */
function commentStart(line: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (QUOTES.has(char)) {
      quote = char;
    } else if (char === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return i;
    }
  }
  return line.length;
}

/** Whether `oldText` at `start` is a whole YAML value, not part of a longer one. */
function isWholeValue(line: string, start: number, end: number): boolean {
  const before = line[start - 1];
  const after = line[end];
  if (before !== undefined && QUOTES.has(before)) return after === before;
  if (before !== undefined && before !== " " && before !== "\t") return false;
  // Plain YAML values end at the end of the line or at a comment.
  const rest = line.slice(end);
  return rest.trim() === "" || /^[ \t]+#/.test(rest);
}

/**
 * Finds the value a quick fix replaces, or `undefined` when the line no longer holds it
 * exactly once as a whole value: the file changed since the check, or the value came
 * from a variable or a target override, so the fix would edit the wrong text.
 *
 * @param line The text of the issue's line.
 * @param oldText The value as the check read it.
 * @param column The issue's 1-based column, when it has one: the value must start there.
 */
export function locateFix(line: string, oldText: string, column?: number): TextSpan | undefined {
  if (!oldText) return undefined;
  const found: TextSpan[] = [];
  const code = commentStart(line);
  for (let start = line.indexOf(oldText); start !== -1; start = line.indexOf(oldText, start + 1)) {
    const end = start + oldText.length;
    if (end > code) break;
    if (!isWholeValue(line, start, end)) continue;
    // The column points at the value node, which starts at its opening quote when quoted.
    const valueStart = QUOTES.has(line[start - 1] ?? "") ? start - 1 : start;
    if (column !== undefined && valueStart !== column - 1) continue;
    found.push({ start, end });
  }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The value written at a 1-based column of a YAML line: the text inside its quotes, or
 * a plain value up to the end of the line or a comment. `undefined` when there is none.
 */
export function writtenValueAt(line: string, column: number): string | undefined {
  const start = column - 1;
  const first = line[start];
  if (first === undefined) return undefined;
  if (QUOTES.has(first)) {
    const end = line.indexOf(first, start + 1);
    return end === -1 ? undefined : line.slice(start + 1, end) || undefined;
  }
  const value = line.slice(start, commentStart(line)).trim();
  return value || undefined;
}
