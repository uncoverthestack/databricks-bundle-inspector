import fs from "node:fs/promises";
import path from "node:path";

/**
 * A single detected use of `dbutils.secrets.get` within a file.
 */
export interface SecretDetection {
  /** 1-based line number where the call starts. */
  line: number;
  /** The source line on which `dbutils.secrets.get(` appears. */
  raw: string;
  /**
   * The literal scope string when it can be determined statically
   * (e.g. `dbutils.secrets.get(scope="dev-scope", ...)`), or `null`
   * when the scope is a variable whose value is only known at runtime
   * (e.g. `dbutils.secrets.get(scope_var)`).
   */
  scope: string | null;
}

/**
 * Attempts to extract the literal scope name from the raw argument fragment
 * captured inside the parentheses of a `dbutils.secrets.get(...)` call.
 *
 * Handles keyword form (`scope="value"`), positional form (`"value"`), and
 * both single and double quotes. Normalises backslash-continuations and
 * whitespace before matching so multi-line calls are treated consistently.
 *
 * @param argFragment Everything between the opening and closing parenthesis.
 * @returns The literal scope string, or `null` if the scope is a variable.
 */
function extractScope(argFragment: string): string | null {
  const normalised = argFragment
    .replace(/\\\n/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const kwarg = normalised.match(/scope\s*=\s*(["'])([^"']+)\1/);
  if (kwarg) {
    return kwarg[2] ?? null;
  }

  const positional = normalised.match(/^(["'])([^"']+)\1/);
  if (positional) {
    return positional[2] ?? null;
  }

  return null;
}

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

/**
 * Returns `true` when `charIndex` falls inside executable code — i.e. not
 * after a `#` comment marker and not inside a string literal on the same line.
 *
 * Only the prefix of the current line is examined, so triple-quoted strings
 * that open on a prior line are not detected. This is an acceptable limitation
 * for a sniffer that reports possible secret usage rather than proving it.
 */
function isInCodeContext(content: string, charIndex: number): boolean {
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
 * Scans `content` for all `dbutils.secrets.get(...)` calls that appear in
 * executable code (not comments or string literals) and returns one
 * {@link SecretDetection} per call.
 */
function scanContent(content: string): SecretDetection[] {
  const detections: SecretDetection[] = [];
  // Lazy [\s\S]*? lets the match span multiple lines while stopping at the
  // first closing paren, which is the correct boundary for a simple argument list.
  const re = /dbutils\.secrets\.get\s*\(([\s\S]*?)\)/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (!isInCodeContext(content, match.index)) {
      continue;
    }
    detections.push({
      line: getStartLine(content, match.index),
      raw: getLineText(content, match.index),
      scope: extractScope(match[1] ?? ""),
    });
  }

  return detections;
}

/**
 * Flattens a Jupyter notebook's cell sources into a single string so that
 * {@link scanContent} can apply a single regex pass across all cells.
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

/**
 * Scans a local file for uses of `dbutils.secrets.get(...)` and returns one
 * {@link SecretDetection} per call found in executable code.
 *
 * Supports Python source files (`.py`) and Jupyter notebooks (`.ipynb`).
 * For notebooks, all code cells are scanned and line numbers are counted
 * sequentially across cells in document order.
 *
 * A `null` scope in the result means the scope argument is a variable — its
 * value is only known at runtime. A string scope means it was a literal that
 * could be read statically.
 *
 * @param filePath Absolute path to a `.py` or `.ipynb` file.
 * @returns Array of detections, one per `dbutils.secrets.get` call found.
 */
export async function detectSecretInNotebook(
  filePath: string,
): Promise<SecretDetection[]> {
  const content = await fs.readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  const searchContent = ext === ".ipynb" ? notebookToContent(content) : content;

  return scanContent(searchContent);
}
