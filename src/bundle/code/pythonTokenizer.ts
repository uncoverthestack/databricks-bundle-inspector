/**
 * A small Python tokenizer: enough of the language to tell code from strings and
 * comments exactly, so detections never match text inside a docstring or comment.
 *
 * - Strings in every form: single, double and triple quotes, and the `r`, `b`, `u`
 *   and `f` prefixes. The expressions inside an f-string's `{...}` are code, so
 *   their tokens are emitted too, after the f-string's own token.
 * - Comments, line continuations and whitespace are skipped.
 * - Every other character is a name, number or single-character operator.
 *
 * It does not build a syntax tree: detections match short token sequences such as
 * `dbutils . widgets . get ( ... )`.
 */

export type PythonTokenKind = "name" | "string" | "number" | "op";

export interface PythonToken {
  kind: PythonTokenKind;
  /** Names, numbers and operators: the source text. Strings: the text between the quotes. */
  value: string;
  /** Offset of the token's first character in the tokenized text. */
  start: number;
  /** Offset just past the token's last character. */
  end: number;
  /** True for f-strings, whose value depends on the expressions inside them. */
  formatted?: boolean;
}

const STRING_PREFIX = /^(?:[rRbBuUfF]|[bB][rR]|[rR][bB]|[fF][rR]|[rR][fF])$/;

function isNameStart(ch: string): boolean {
  return /[A-Za-z_À-￿]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[\wÀ-￿]/.test(ch);
}

/**
 * Finds where a string literal that opens at `quoteStart` ends.
 *
 * @returns The offset just past the closing quote (or the end of the line or text,
 *   for an unterminated string), and the offsets of its body.
 */
function scanString(
  text: string,
  quoteStart: number,
  formatted = false,
): { end: number; bodyStart: number; bodyEnd: number } {
  const quote = text[quoteStart]!;
  const triple = text.startsWith(quote.repeat(3), quoteStart);
  const delimiter = triple ? quote.repeat(3) : quote;
  const bodyStart = quoteStart + delimiter.length;
  let i = bodyStart;
  while (i < text.length) {
    const ch = text[i]!;
    // A backslash always protects the next character from closing the string,
    // raw strings included.
    if (ch === "\\") {
      i += 2;
      continue;
    }
    // An f-string expression can hold strings with the same quote (Python 3.12+),
    // so skip whole `{...}` expressions; `{{` is a literal brace.
    if (formatted && ch === "{") {
      if (text[i + 1] === "{") {
        i += 2;
        continue;
      }
      i = matchingBrace(text, i, text.length) + 1;
      continue;
    }
    if (!triple && ch === "\n") return { end: i, bodyStart, bodyEnd: i };
    if (text.startsWith(delimiter, i)) {
      return { end: i + delimiter.length, bodyStart, bodyEnd: i };
    }
    i += 1;
  }
  return { end: text.length, bodyStart, bodyEnd: text.length };
}

/**
 * Finds the `}` that closes an f-string expression opened at `open`, skipping
 * nested brackets and strings.
 */
function matchingBrace(text: string, open: number, limit: number): number {
  let depth = 0;
  let i = open;
  while (i < limit) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      i = scanString(text, i).end;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0 && ch === "}") return i;
    }
    i += 1;
  }
  return limit;
}

/** Tokenizes `text[from, to)`. Offsets in the result are offsets into `text`. */
function tokenizeRange(text: string, from: number, to: number, tokens: PythonToken[]): void {
  let i = from;
  while (i < to) {
    const ch = text[i]!;

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < to && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "\\" && (text[i + 1] === "\n" || text[i + 1] === "\r")) {
      i += 2;
      continue;
    }

    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < to && isNameChar(text[j]!)) j += 1;
      const word = text.slice(i, j);
      if (STRING_PREFIX.test(word) && (text[j] === "'" || text[j] === '"')) {
        i = pushString(text, i, j, /f/i.test(word), to, tokens);
        continue;
      }
      tokens.push({ kind: "name", value: word, start: i, end: j });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      i = pushString(text, i, i, false, to, tokens);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < to && /[\w.]/.test(text[j]!)) j += 1;
      tokens.push({ kind: "number", value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    tokens.push({ kind: "op", value: ch, start: i, end: i + 1 });
    i += 1;
  }
}

/** Adds a string token (and, for an f-string, the tokens of its expressions). */
function pushString(
  text: string,
  prefixStart: number,
  quoteStart: number,
  formatted: boolean,
  limit: number,
  tokens: PythonToken[],
): number {
  const { end, bodyStart, bodyEnd } = scanString(text, quoteStart, formatted);
  const stop = Math.min(end, limit);
  tokens.push({
    kind: "string",
    value: text.slice(bodyStart, Math.min(bodyEnd, limit)),
    start: prefixStart,
    end: stop,
    ...(formatted ? { formatted: true } : {}),
  });
  if (formatted) {
    let i = bodyStart;
    while (i < Math.min(bodyEnd, limit)) {
      if (text[i] === "{" && text[i + 1] === "{") {
        i += 2;
        continue;
      }
      if (text[i] === "{") {
        const close = matchingBrace(text, i, bodyEnd);
        tokenizeRange(text, i + 1, close, tokens);
        i = close + 1;
        continue;
      }
      i += 1;
    }
  }
  return stop;
}

export function tokenizePython(text: string): PythonToken[] {
  const tokens: PythonToken[] = [];
  tokenizeRange(text, 0, text.length, tokens);
  return tokens;
}

/** A call's argument: `name=value` or a positional value, as tokens. */
export interface PythonArgument {
  keyword?: string;
  tokens: PythonToken[];
}

/**
 * Reads the arguments of a call whose `(` is at `tokens[open]`.
 *
 * @returns The arguments and the index of the closing `)`, or `undefined` when the
 *   call is not closed.
 */
export function readArguments(
  tokens: PythonToken[],
  open: number,
): { args: PythonArgument[]; close: number } | undefined {
  const args: PythonArgument[] = [];
  let current: PythonToken[] = [];
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "op" && "([{".includes(token.value)) {
      depth += 1;
      if (depth === 1) continue;
    } else if (token.kind === "op" && ")]}".includes(token.value)) {
      depth -= 1;
      if (depth === 0) {
        if (current.length) args.push(toArgument(current));
        return { args, close: i };
      }
    } else if (depth === 1 && token.kind === "op" && token.value === ",") {
      if (current.length) args.push(toArgument(current));
      current = [];
      continue;
    }
    current.push(token);
  }
  return undefined;
}

function toArgument(tokens: PythonToken[]): PythonArgument {
  const [first, second, third] = tokens;
  // `name=value`, but not `name == value`.
  if (
    first?.kind === "name" &&
    second?.kind === "op" &&
    second.value === "=" &&
    !(third?.kind === "op" && third.value === "=")
  ) {
    return { keyword: first.value, tokens: tokens.slice(2) };
  }
  return { tokens };
}

/**
 * The value of an argument that is a plain string literal (or adjacent literals,
 * which Python joins), or `null` when it is anything else, such as a variable or
 * an f-string. An empty string counts as no value.
 */
export function literalValue(arg: PythonArgument | undefined): string | null {
  if (!arg || arg.tokens.length === 0) return null;
  if (!arg.tokens.every((token) => token.kind === "string" && !token.formatted)) return null;
  const value = arg.tokens.map((token) => token.value).join("");
  return value === "" ? null : value;
}

/**
 * Whether `tokens[index...]` is the dotted name `parts`, e.g. `dbutils . widgets`.
 */
export function matchesDottedName(
  tokens: PythonToken[],
  index: number,
  parts: readonly string[],
): boolean {
  for (let p = 0; p < parts.length; p++) {
    const name = tokens[index + p * 2];
    if (name?.kind !== "name" || name.value !== parts[p]) return false;
    if (p < parts.length - 1) {
      const dot = tokens[index + p * 2 + 1];
      if (dot?.kind !== "op" || dot.value !== ".") return false;
    }
  }
  return true;
}
