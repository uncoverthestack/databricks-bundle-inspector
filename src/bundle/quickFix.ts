import { isScalar, parseDocument } from "yaml";

/** Where a value sits in a line of YAML, as character offsets: `start` up to, not including, `end`. */
export interface TextSpan {
  start: number;
  end: number;
}

const QUOTES = new Set(['"', "'"]);

/** Where a YAML comment starts on the line: a `#` after a space or at the start, outside quotes. */
function commentStart(line: string, valueStart: number): number {
  // Only an opening quote at the start makes this a quoted YAML scalar. Quotes
  // inside a plain path (../it's/a.py) are ordinary characters.
  let quote = QUOTES.has(line[valueStart] ?? "") ? line[valueStart] : undefined;
  for (let i = valueStart + (quote ? 1 : 0); i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (quote === '"' && char === "\\") {
        i++;
        continue;
      }
      if (quote === "'" && char === "'" && line[i + 1] === "'") {
        i++;
        continue;
      }
      if (char === quote) quote = undefined;
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
  const quoted = before !== undefined && QUOTES.has(before);
  if (quoted && after !== before) return false;
  if (!quoted && before !== undefined && before !== " " && before !== "\t") return false;
  // The value is the last thing on the line, apart from a comment, or, when quoted, it
  // ends a flow mapping or list entry ({ path: "x" }, [ "x", ... ]).
  const rest = line.slice(quoted ? end + 1 : end);
  return rest.trim() === "" || /^[ \t]+#/.test(rest) || (quoted && /^[ \t]*[,}\]]/.test(rest));
}

/**
 * Finds the value a quick fix replaces, or `undefined` when the line no longer holds it
 * exactly once as a whole value: the file changed since the check, or the value came
 * from a variable or a target override, so the fix would edit the wrong text.
 *
 * @param line The text of the issue's line.
 * @param oldText The value as the check read it.
 * @param column The issue's 1-based column: the value must start there, so a copy of the
 *   value elsewhere on the line, or inside a longer plain value, is never edited.
 */
export function locateFix(line: string, oldText: string, column: number): TextSpan | undefined {
  if (!oldText) return undefined;
  const found: TextSpan[] = [];
  const code = commentStart(line, column - 1);
  for (let start = line.indexOf(oldText); start !== -1; start = line.indexOf(oldText, start + 1)) {
    const end = start + oldText.length;
    if (end > code) break;
    if (!isWholeValue(line, start, end)) continue;
    // The column points at the value node, which starts at its opening quote when quoted.
    const valueStart = QUOTES.has(line[start - 1] ?? "") ? start - 1 : start;
    if (valueStart !== column - 1) continue;
    found.push({ start, end });
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Whether YAML, as 1.2 and as the older 1.1, reads `text` written plain as exactly `value`. */
function readsBackAs(text: string, value: string): boolean {
  return (["1.2", "1.1"] as const).every((version) => {
    const document = parseDocument(text, { version });
    const node = document.contents;
    return document.errors.length === 0 && document.warnings.length === 0 && isScalar(node) && !node.tag && node.value === value;
  });
}

/**
 * `value` written so YAML reads it back as that exact string, in the quotes the old
 * value had. A plain value stays plain unless that would change it: `a #b` would lose
 * `#b` as a comment, `a: b` would be a mapping, `1.5` a number. Then it is single
 * quoted, which needs no escapes but `''`. Control characters need double quotes.
 */
export function yamlValue(value: string, quote: '"' | "'" | undefined): string {
  if (quote === '"' || /[\u0000-\u001f\u007f]/.test(value)) return JSON.stringify(value);
  if (quote === undefined && readsBackAs(value, value)) return value;
  return `'${value.replaceAll("'", "''")}'`;
}

/** The edit a quick fix makes on its line: the whole value, quotes included. */
export interface FixEdit extends TextSpan {
  text: string;
}

/**
 * The edit that writes `newText` in place of `oldText` (see {@link locateFix}). The new
 * value keeps the old one's quotes when it can, and gains them when it needs them, so
 * a path holding `'`, `"`, `:` or `#` is still that path to the CLI.
 */
export function fixEdit(line: string, oldText: string, newText: string, column: number): FixEdit | undefined {
  const span = locateFix(line, oldText, column);
  if (!span) return undefined;
  const quote = line[span.start - 1];
  if (quote === '"' || quote === "'") return { start: span.start - 1, end: span.end + 1, text: yamlValue(newText, quote) };
  return { ...span, text: yamlValue(newText, undefined) };
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
    if (end === -1) return undefined;
    const inner = line.slice(start + 1, end);
    // An escape ("a\"b", 'it''s') means the text isn't the value as written; don't guess.
    if (first === '"' && inner.includes("\\")) return undefined;
    if (first === "'" && line[end + 1] === "'") return undefined;
    return inner || undefined;
  }
  const value = line.slice(start, commentStart(line, start)).trim();
  return value || undefined;
}
