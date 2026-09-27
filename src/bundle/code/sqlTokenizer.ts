/**
 * A small Databricks SQL tokenizer: enough to tell code from strings and comments
 * exactly, plus the notebook-only forms Databricks adds.
 *
 * - Comments: `-- ...` and `/* ... *\/`, which can nest in Spark SQL.
 * - Strings: `'...'` and `"..."` with backslash escapes and doubled quotes, raw
 *   strings (`r'...'`), and `$$ ... $$` bodies (optionally tagged, `$py$ ... $py$`).
 * - Backtick identifiers, `` `a:b` ``, with doubled backticks.
 * - The legacy notebook reference `${name}`, as one token.
 * - `::` (a cast) as one operator; any other character is a single-character operator.
 *
 * Like sqlglot's tokenizer, it stops at tokens: detections match short sequences such
 * as `CREATE WIDGET TEXT name` or `: name`.
 */

export type SqlTokenKind =
  | "word"
  | "quoted_identifier"
  | "string"
  | "number"
  | "legacy_reference"
  | "op";

export interface SqlToken {
  kind: SqlTokenKind;
  /** Words, numbers, operators: the source text. Strings and quoted identifiers: the text inside the quotes. `${name}`: the name. */
  value: string;
  start: number;
  end: number;
  /** Strings and quoted identifiers: offset of the first character inside the quotes. */
  bodyStart?: number;
}

function isWordStart(ch: string): boolean {
  return /[A-Za-z_À-￿]/.test(ch);
}

function isWordChar(ch: string): boolean {
  return /[\wÀ-￿]/.test(ch);
}

/** The end of a `/* ... *\/` comment opened at `start`, counting nested comments. */
function blockCommentEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (text.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return text.length;
}

/** The end of a quoted string or identifier opened by `quote` at `start`. */
function quotedEnd(text: string, start: number, quote: string, escapes: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (escapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

export function tokenizeSql(text: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (text.startsWith("--", i)) {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      i = blockCommentEnd(text, i);
      continue;
    }

    // `$$ ... $$` or `$tag$ ... $tag$` bodies, e.g. a Python UDF.
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
    if (dollar) {
      const tag = dollar[0];
      const close = text.indexOf(tag, i + tag.length);
      const end = close === -1 ? text.length : close + tag.length;
      tokens.push({
        kind: "string",
        value: text.slice(i + tag.length, close === -1 ? text.length : close),
        start: i,
        end,
        bodyStart: i + tag.length,
      });
      i = end;
      continue;
    }

    if (text.startsWith("${", i)) {
      const close = text.indexOf("}", i + 2);
      if (close !== -1) {
        tokens.push({ kind: "legacy_reference", value: text.slice(i + 2, close), start: i, end: close + 1 });
        i = close + 1;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      const end = quotedEnd(text, i, ch, true);
      tokens.push({ kind: "string", value: text.slice(i + 1, end - 1), start: i, end, bodyStart: i + 1 });
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = quotedEnd(text, i, "`", false);
      tokens.push({ kind: "quoted_identifier", value: text.slice(i + 1, end - 1), start: i, end, bodyStart: i + 1 });
      i = end;
      continue;
    }

    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < text.length && isWordChar(text[j]!)) j += 1;
      // Raw strings: r'...' keeps backslashes, so they don't escape the quote.
      if (j === i + 1 && /[rR]/.test(ch) && (text[j] === "'" || text[j] === '"')) {
        const end = quotedEnd(text, j, text[j]!, false);
        tokens.push({ kind: "string", value: text.slice(j + 1, end - 1), start: i, end, bodyStart: j + 1 });
        i = end;
        continue;
      }
      tokens.push({ kind: "word", value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[\w.]/.test(text[j]!)) j += 1;
      tokens.push({ kind: "number", value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    if (text.startsWith("::", i)) {
      tokens.push({ kind: "op", value: "::", start: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ kind: "op", value: ch, start: i, end: i + 1 });
    i += 1;
  }
  return tokens;
}

/**
 * Legacy `${name}` references inside a string literal or a backtick identifier,
 * e.g. `'${run_date}'` or `` delta.`${path}/events` ``: the notebook substitutes them
 * as plain text before the SQL runs.
 */
export function legacyReferencesInString(token: SqlToken): Array<{ name: string; offset: number }> {
  const found: Array<{ name: string; offset: number }> = [];
  const bodyStart = token.bodyStart ?? token.start;
  const re = /\$\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(token.value)) !== null) {
    found.push({ name: match[1]!, offset: bodyStart + match.index });
  }
  return found;
}
