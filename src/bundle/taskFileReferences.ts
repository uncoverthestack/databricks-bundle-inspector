import fs from "node:fs/promises";
import path from "node:path";

/**
 * A single detected use of a Databricks secret-access call within a file.
 * Covers `dbutils.secrets.get` in Python/notebooks and `secret()`/`try_secret()`
 * in Databricks SQL.
 */
export interface SecretDetection {
  /** 1-based line number where the call starts. */
  line: number;
  /** The source line on which the call appears. */
  raw: string;
  /**
   * The literal scope string when it can be determined statically, or `null`
   * when the scope is a variable whose value is only known at runtime.
   */
  scope: string | null;
  /**
   * The literal key string when it can be determined statically, or `null`
   * when the key is a variable whose value is only known at runtime.
   */
  key: string | null;
  /**
   * Optional human-readable note for contextual information surfaced to the
   * user — for example, a warning that the detected function is a preview
   * feature. Absent when there is nothing extra to communicate.
   */
  note?: string;
}

// ─── Shared utilities ────────────────────────────────────────────────────────

/** Returns the 1-based line number of `charIndex` within `content`. */
function getStartLine(content: string, charIndex: number): number {
  return content.slice(0, charIndex).split("\n").length;
}

/** Returns the source line that contains `charIndex`, with `\r` stripped. */
function getLineText(content: string, charIndex: number): string {
  const lineStart = content.lastIndexOf("\n", charIndex - 1) + 1;
  const lineEnd = content.indexOf("\n", charIndex);
  const raw = content.slice(
    lineStart,
    lineEnd === -1 ? content.length : lineEnd,
  );
  return raw.replace(/\r$/, "");
}

// ─── Python / notebook ───────────────────────────────────────────────────────

/**
 * Extracts the `scope` and `key` from the argument fragment of a
 * `dbutils.secrets.get(scope, key)` call.
 *
 * Resolution order for each parameter:
 * 1. Keyword form: `scope="value"` / `key="value"` (single or double quotes).
 * 2. Positional form: first and second quoted string literals respectively.
 * 3. `null` — the argument is a variable resolved at runtime.
 *
 * Backslash-continuations and excess whitespace are normalised before
 * matching so that multi-line calls are treated identically to single-line ones.
 *
 * @param argFragment Everything between the opening and closing parenthesis.
 */
function extractPythonArgs(argFragment: string): {
  scope: string | null;
  key: string | null;
} {
  const normalised = argFragment
    .replace(/\\\n/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // keyword forms — matched independently so either can be absent
  const scope =
    normalised.match(/scope\s*=\s*(["'])([^"']+)\1/)?.[2] ?? null;
  const key =
    normalised.match(/key\s*=\s*(["'])([^"']+)\1/)?.[2] ?? null;

  if (scope !== null || key !== null) {
    // At least one keyword arg was found; fill the other from positional if needed
    const positionalScope =
      scope ?? normalised.match(/^(["'])([^"']+)\1/)?.[2] ?? null;
    const positionalKey =
      key ??
      normalised.match(/^[^,]+,\s*(["'])([^"']+)\1/)?.[2] ??
      null;
    return { scope: positionalScope, key: positionalKey };
  }

  // fully positional: "scope", "key"
  const positional = normalised.match(
    /^(["'])([^"']+)\1\s*,\s*(["'])([^"']+)\3/,
  );
  if (positional) {
    return { scope: positional[2] ?? null, key: positional[4] ?? null };
  }

  // only first arg present (or both are variables)
  const first = normalised.match(/^(["'])([^"']+)\1/);
  return { scope: first?.[2] ?? null, key: null };
}

/**
 * Returns `true` when `charIndex` falls inside executable Python code — i.e.
 * not after a `#` comment marker and not inside a string literal on the same
 * line. Triple-quoted strings that open on a prior line are not detected;
 * that is an acceptable limitation for a sniffer.
 */
function isInPythonCodeContext(content: string, charIndex: number): boolean {
  const lineStart = content.lastIndexOf("\n", charIndex - 1) + 1;
  const prefix = content.slice(lineStart, charIndex);

  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];

    if (inDouble) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }

    if (inSingle) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }

    if (ch === "#") return false;
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
  }

  return !inDouble && !inSingle;
}

/**
 * Scans `content` for all `dbutils.secrets.get(...)` and
 * `dbutils.secrets.getBytes(...)` calls that appear in executable Python code
 * (not comments or string literals) and returns one {@link SecretDetection}
 * per call.
 */
function scanPythonContent(content: string): SecretDetection[] {
  const detections: SecretDetection[] = [];
  // Lazy [\s\S]*? lets the match span multiple lines while stopping at the
  // first closing paren. getBytes is listed to match both variants.
  const re = /dbutils\.secrets\.get(?:Bytes)?\s*\(([\s\S]*?)\)/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (!isInPythonCodeContext(content, match.index)) {
      continue;
    }
    const { scope, key } = extractPythonArgs(match[1] ?? "");
    detections.push({
      line: getStartLine(content, match.index),
      raw: getLineText(content, match.index),
      scope,
      key,
    });
  }

  return detections;
}

/**
 * Flattens a Jupyter notebook's cell sources into a single string so that
 * {@link scanPythonContent} can apply a single regex pass across all cells.
 * Each cell is separated by a newline to preserve line numbering.
 */
function notebookToContent(raw: string): string {
  const notebook = JSON.parse(raw) as {
    cells?: Array<{ source?: string | string[] }>;
  };

  return (notebook.cells ?? [])
    .map((cell) => {
      const src = cell.source ?? "";
      return Array.isArray(src) ? src.join("") : src;
    })
    .join("\n");
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

const SQL_PREVIEW_NOTE =
  "secret() and try_secret() are Databricks SQL preview features";

/**
 * Extracts the `scope` and `key` from the argument fragment of a SQL
 * `secret(scope, key)` or `try_secret(scope, key)` call.
 *
 * Per the Databricks SQL spec both arguments must be constant string literals,
 * so both fields are expected to be non-null for well-formed calls.
 *
 * @param argFragment Everything between the opening and closing parenthesis.
 */
function extractSqlArgs(argFragment: string): {
  scope: string | null;
  key: string | null;
} {
  const normalised = argFragment.replace(/\s+/g, " ").trim();

  // Both positional string literals: 'scope', 'key' or "scope", "key"
  const both = normalised.match(
    /^(["'])([^"']+)\1\s*,\s*(["'])([^"']+)\3/,
  );
  if (both) {
    return { scope: both[2] ?? null, key: both[4] ?? null };
  }

  // Only the first arg is a literal (malformed per spec, but be resilient)
  const first = normalised.match(/^(["'])([^"']+)\1/);
  return { scope: first?.[2] ?? null, key: null };
}

/**
 * Returns `true` when `charIndex` falls inside executable SQL — i.e. not
 * after a `--` line comment and not inside a quoted string literal on the
 * same line. Inline `/* ... *\/` block comments that open and close on the
 * same line before the match are also detected. Block comments that open on
 * a prior line are not tracked; acceptable for a sniffer.
 */
function isInSqlCodeContext(content: string, charIndex: number): boolean {
  const lineStart = content.lastIndexOf("\n", charIndex - 1) + 1;
  const prefix = content.slice(lineStart, charIndex);

  let inSingle = false;
  let inDouble = false;
  let inBlock = false;

  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    const next = prefix[i + 1] ?? "";

    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === "-" && next === "-") return false;
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
  }

  return !inSingle && !inDouble && !inBlock;
}

/**
 * Scans `content` for all `secret(...)` and `try_secret(...)` calls that
 * appear in executable SQL (not comments or string literals) and returns one
 * {@link SecretDetection} per call.
 *
 * Every detection carries {@link SQL_PREVIEW_NOTE} in its `note` field
 * because both functions are currently a Databricks SQL preview feature.
 */
function scanSqlContent(content: string): SecretDetection[] {
  const detections: SecretDetection[] = [];
  // try_secret is listed first so the alternation matches it before secret.
  // \b prevents matching longer names such as get_secret().
  const re = /\b(?:try_secret|secret)\s*\(([\s\S]*?)\)/gi;

  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (!isInSqlCodeContext(content, match.index)) {
      continue;
    }
    const { scope, key } = extractSqlArgs(match[1] ?? "");
    detections.push({
      line: getStartLine(content, match.index),
      raw: getLineText(content, match.index),
      scope,
      key,
      note: SQL_PREVIEW_NOTE,
    });
  }

  return detections;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scans a local file for secret-access calls and returns one
 * {@link SecretDetection} per call found in executable code.
 *
 * | Extension | Detected call                              |
 * |-----------|--------------------------------------------|
 * | `.py`     | `dbutils.secrets.get()`, `.getBytes()`     |
 * | `.ipynb`  | `dbutils.secrets.get()`, `.getBytes()`     |
 * | `.sql`    | `secret()`, `try_secret()`                 |
 *
 * For notebooks, all code cells are scanned and line numbers are counted
 * sequentially across cells in document order.
 *
 * `null` on `scope` or `key` means that argument is a variable resolved at
 * runtime (Python only — SQL requires constant string literals per spec).
 * SQL detections always carry a `note` marking the preview status.
 *
 * @param filePath Absolute path to a `.py`, `.ipynb`, or `.sql` file.
 * @returns Array of detections, one per secret call found.
 */
export async function detectSecretInNotebook(
  filePath: string,
): Promise<SecretDetection[]> {
  const content = await fs.readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".sql") {
    return scanSqlContent(content);
  }

  const searchContent = ext === ".ipynb" ? notebookToContent(content) : content;
  return scanPythonContent(searchContent);
}
