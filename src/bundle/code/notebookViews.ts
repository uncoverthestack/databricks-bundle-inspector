/**
 * Splits a notebook or source file into one view per language, so each language's
 * tokenizer sees only its own code.
 *
 * A view has exactly the length of the document: other languages' cells, markdown,
 * magic lines and `# MAGIC ` / `-- MAGIC ` prefixes are replaced with spaces, and line
 * breaks are kept. A token's offset in a view is therefore its offset in the document,
 * so line numbers and line text come from the document unchanged.
 *
 * - Databricks source notebooks (`# Databricks notebook source` / `-- Databricks notebook source`):
 *   cells are separated by `COMMAND ----------` lines; a cell starting with
 *   `MAGIC %sql`, `MAGIC %python`, `MAGIC %md` or another magic is in that language.
 * - Jupyter notebooks: the document is the cells' sources joined by line breaks, as
 *   before. Only code cells are code; a first line of `%sql`, `%python` and so on sets
 *   the cell's language. The notebook's own language comes from its metadata.
 * - Any other file is one cell in the file's language.
 */
import { emptyRecord } from "../ownKeys.js";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export type CodeLanguage = "python" | "sql";

export interface NotebookViews {
  /** Source text used to tokenize code (for `.ipynb`, joined cell sources). */
  document: string;
  python: string;
  sql: string;
  /** A `%run` cell, which can define widgets and variables in another notebook. */
  runsOtherNotebooks: boolean;
  /** Each `%run`: the notebook path as written, the `$name="value"` widget values it passes, and its line. */
  runs: NotebookRun[];
  /** Maps one-based joined source lines to lines in the Jupyter JSON file. */
  sourceLines?: number[];
  sourceSpans?: Array<{ start: number; end: number; line: number }>;
}

export interface NotebookRun {
  target: string;
  args: Record<string, string>;
  line: number;
}

/**
 * Reads a `%run` line: `%run ./shared $env="dev" $limit=10`
 * (https://docs.databricks.com/aws/en/notebooks/widgets).
 */
function parseRun(text: string, line: number): NotebookRun | undefined {
  // No `$` anchor: a CRLF file leaves "\r" at the end of the line, which `.` can't match.
  const match = /%run\s+("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']\S*)(.*)/.exec(text);
  if (!match) return undefined;
  const args = emptyRecord<string>();
  const argument = /\$(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let arg: RegExpExecArray | null;
  while ((arg = argument.exec(match[2] ?? "")) !== null) {
    args[arg[1]!] = arg[2] ?? arg[3] ?? arg[4] ?? "";
  }
  return { target: match[1]!, args, line };
}

type CellLanguage = CodeLanguage | "other";

interface Line {
  text: string;
  language: CellLanguage;
  /** Characters at the start of the line that are notebook markup, not code. */
  markupLength: number;
}

const MAGIC_LANGUAGE: Record<string, CellLanguage> = {
  python: "python",
  py: "python",
  sql: "sql",
};

function magicLanguage(magic: string): CellLanguage {
  return MAGIC_LANGUAGE[magic.toLowerCase()] ?? "other";
}

function buildViews(lines: Line[], runs: NotebookRun[]): NotebookViews {
  const view = (language: CodeLanguage) =>
    lines
      .map((line) =>
        line.language === language
          ? " ".repeat(line.markupLength) + line.text.slice(line.markupLength)
          : line.text.replace(/[^\r]/g, " "),
      )
      .join("\n");
  return {
    document: lines.map((line) => line.text).join("\n"),
    python: view("python"),
    sql: view("sql"),
    runsOtherNotebooks: runs.length > 0,
    runs,
  };
}

function sourceNotebookLines(
  content: string,
  language: CodeLanguage,
  comment: string = language === "python" ? "#" : "--",
): NotebookViews {
  const separator = new RegExp(`^${comment} COMMAND -{5,}\\s*$`);
  const magicPrefix = new RegExp(`^${comment} MAGIC ?`);
  const magicLine = new RegExp(`^${comment} MAGIC\\s*%(\\w+)`);

  const lines: Line[] = [];
  const runs: NotebookRun[] = [];
  let cellLanguage: CellLanguage = language;
  let atCellStart = true;
  // A cell opened by a magic line has `MAGIC` on every line, even `%python` in a
  // Python notebook, which Databricks runs as Python (job run, CLI v1.28.0, #588).
  let magicCell = false;

  const header = new RegExp(`^${comment} Databricks notebook source`);
  for (const text of content.split("\n")) {
    if (lines.length === 0 && header.test(text)) {
      lines.push({ text, language: "other", markupLength: 0 });
      continue;
    }
    if (separator.test(text)) {
      lines.push({ text, language: "other", markupLength: 0 });
      cellLanguage = language;
      atCellStart = true;
      magicCell = false;
      continue;
    }
    const magic = magicLine.exec(text);
    // Checked as job runs on a workspace (CLI v1.24.0, 2026-11-06): a %run that starts a
    // cell runs, and so does one further down a Python cell. Further down a %md cell it
    // is text, and further down a SQL cell it is a syntax error, so neither is a run.
    const startsCell = atCellStart && text.trim() !== "";
    if (magic?.[1]?.toLowerCase() === "run" && (startsCell || cellLanguage === "python")) {
      const run = parseRun(text, lines.length + 1);
      if (run) runs.push(run);
    }
    if (atCellStart && text.trim() !== "") {
      atCellStart = false;
      if (magic) {
        cellLanguage = magicLanguage(magic[1]!);
        magicCell = true;
        // The magic line itself (`%sql`) is not code.
        lines.push({ text, language: "other", markupLength: 0 });
        continue;
      }
    }
    const prefix = magicCell ? magicPrefix.exec(text) : null;
    lines.push({ text, language: cellLanguage, markupLength: prefix ? prefix[0].length : 0 });
  }
  return buildViews(lines, runs);
}

const SCALA_MARKUP = /^\/\/ (?:Databricks notebook source|COMMAND -{5,}|MAGIC)/;

/**
 * Scala text with its comments (`// ...` and nested block comments) replaced with spaces,
 * line breaks kept. Strings (`"..."`, `"""..."""`) and character literals are skipped.
 * Notebook markup lines (`// MAGIC`, `// COMMAND ----------`, the header) are kept.
 */
function blankScalaComments(content: string): string {
  const out = content.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  let i = 0;
  while (i < content.length) {
    const lineStart = i === 0 || content[i - 1] === "\n";
    if (lineStart && SCALA_MARKUP.test(content.slice(i, i + 60))) {
      const end = content.indexOf("\n", i);
      i = end === -1 ? content.length : end + 1;
      continue;
    }
    if (content.startsWith('"""', i)) {
      const end = content.indexOf('"""', i + 3);
      i = end === -1 ? content.length : end + 3;
    } else if (content[i] === '"') {
      let k = i + 1;
      while (k < content.length && content[k] !== '"' && content[k] !== "\n") k += content[k] === "\\" ? 2 : 1;
      i = k + 1;
    } else if (content[i] === "'") {
      const char = /^'(?:\\.|[^\\'\n])'/.exec(content.slice(i, i + 8));
      i += char ? char[0].length : 1;
    } else if (content.startsWith("//", i)) {
      const end = content.indexOf("\n", i);
      const stop = end === -1 ? content.length : end;
      blank(i, stop);
      i = stop;
    } else if (content.startsWith("/*", i)) {
      // Scala block comments nest.
      let depth = 0;
      let k = i;
      while (k < content.length) {
        if (content.startsWith("/*", k)) {
          depth += 1;
          k += 2;
        } else if (content.startsWith("*/", k)) {
          depth -= 1;
          k += 2;
          if (depth === 0) break;
        } else k += 1;
      }
      blank(i, k);
      i = k;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/**
 * A Scala file or notebook. Its own code goes in the Python view: `dbutils` calls read the
 * same in both, and comments are blanked first so they don't count (#588). A notebook's
 * `%python` and `%sql` cells go in their own views.
 */
function scalaViews(content: string): NotebookViews {
  const code = blankScalaComments(content);
  const views = /^\/\/ Databricks notebook source/.test(content)
    ? sourceNotebookLines(code, "python", "//")
    : buildViews(code.split("\n").map((text): Line => ({ text, language: "python", markupLength: 0 })), []);
  return { ...views, document: content };
}

interface JupyterNotebook {
  cells?: Array<{ cell_type?: string; source?: string | string[] }>;
  metadata?: {
    "application/vnd.databricks.v1+notebook"?: { language?: string };
    language_info?: { name?: string };
    kernelspec?: { language?: string };
  };
}

function jupyterLines(raw: string): NotebookViews {
  const notebook = JSON.parse(raw) as JupyterNotebook;
  const declared =
    notebook.metadata?.["application/vnd.databricks.v1+notebook"]?.language ??
    notebook.metadata?.language_info?.name ??
    notebook.metadata?.kernelspec?.language ??
    "python";
  const notebookLanguage = magicLanguage(declared);

  const lines: Line[] = [];
  const runs: NotebookRun[] = [];
  const sourceLines: number[] = [];
  const sourceSpans: Array<{ start: number; end: number; line: number }> = [];
  let documentOffset = 0;
  // JSON is also YAML. Node ranges locate source strings even when their contents repeat.
  const parsed = parseDocument(raw);
  const cellsNode = isMap(parsed.contents) ? parsed.contents.get("cells", true) : undefined;
  const cellNodes = isSeq(cellsNode) ? cellsNode.items : [];
  const lineStarts = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
  for (const [cellIndex, cell] of (notebook.cells ?? []).entries()) {
    const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
    const cellLines = source.split("\n");
    const node = cellNodes[cellIndex];
    const sourceNode = isMap(node) ? node.get("source", true) : undefined;
    const parts = isSeq(sourceNode) ? sourceNode.items : sourceNode ? [sourceNode] : [];
    const mapped: number[] = [];
    let current = 0;
    let partOffset = documentOffset;
    for (const part of parts) {
      if (!isScalar(part) || typeof part.value !== "string" || !part.range) continue;
      const fileLine = lineAt(part.range[0]);
      sourceSpans.push({ start: partOffset, end: partOffset + part.value.length, line: fileLine });
      partOffset += part.value.length;
      for (const char of part.value) {
        mapped[current] ??= fileLine;
        if (char === "\n") current += 1;
      }
    }
    const fallback = mapped.at(-1) ?? (isMap(node) && node.range ? lineAt(node.range[0]) : 1);
    for (let i = 0; i < cellLines.length; i++) sourceLines.push(mapped[i] ?? fallback);
    documentOffset += source.length + 1;
    const isCode = (cell.cell_type ?? "code") === "code";
    const magic = isCode ? /^\s*%(\w+)/.exec(cellLines[0] ?? "") : null;
    if (magic?.[1]?.toLowerCase() === "run") {
      const run = parseRun(cellLines[0] ?? "", lines.length + 1);
      if (run) runs.push(run);
    }
    const language: CellLanguage = !isCode ? "other" : magic ? magicLanguage(magic[1]!) : notebookLanguage;
    cellLines.forEach((text, index) => {
      lines.push({ text, language: magic && index === 0 ? "other" : language, markupLength: 0 });
    });
  }
  return { ...buildViews(lines, runs), sourceLines, sourceSpans };
}

/**
 * @param fileLanguage The language of a plain file, or of a source notebook's own cells.
 */
export function notebookViews(
  content: string,
  options: { jupyter: boolean; fileLanguage: CodeLanguage; scala?: boolean },
): NotebookViews {
  // A byte order mark first still makes a notebook for the CLI (#589), so read what follows it.
  if (content.startsWith("\uFEFF")) return notebookViews(content.slice(1), options);
  if (options.jupyter) return jupyterLines(content);
  if (options.scala) return scalaViews(content);
  if (/^# Databricks notebook source/.test(content)) return sourceNotebookLines(content, "python");
  if (/^-- Databricks notebook source/.test(content)) return sourceNotebookLines(content, "sql");
  const lines = content
    .split("\n")
    .map((text): Line => ({ text, language: options.fileLanguage, markupLength: 0 }));
  return buildViews(lines, []);
}
