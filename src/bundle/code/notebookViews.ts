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

export type CodeLanguage = "python" | "sql";

export interface NotebookViews {
  /** The text line numbers refer to (for `.ipynb`, the joined cell sources). */
  document: string;
  python: string;
  sql: string;
  /** A `%run` cell, which can define widgets and variables in another notebook. */
  runsOtherNotebooks: boolean;
  /** Each `%run`: the notebook path as written, the `$name="value"` widget values it passes, and its line. */
  runs: NotebookRun[];
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
  const match = /%run\s+(\S+)(.*)$/.exec(text);
  if (!match) return undefined;
  const args: Record<string, string> = {};
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

function sourceNotebookLines(content: string, language: CodeLanguage): NotebookViews {
  const comment = language === "python" ? "#" : "--";
  const separator = new RegExp(`^${comment} COMMAND -{5,}\\s*$`);
  const magicPrefix = new RegExp(`^${comment} MAGIC ?`);
  const magicLine = new RegExp(`^${comment} MAGIC\\s*%(\\w+)`);

  const lines: Line[] = [];
  const runs: NotebookRun[] = [];
  let cellLanguage: CellLanguage = language;
  let atCellStart = true;

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
      continue;
    }
    const magic = magicLine.exec(text);
    if (magic?.[1]?.toLowerCase() === "run") {
      const run = parseRun(text, lines.length + 1);
      if (run) runs.push(run);
    }
    if (atCellStart && text.trim() !== "") {
      atCellStart = false;
      if (magic) {
        cellLanguage = magicLanguage(magic[1]!);
        // The magic line itself (`%sql`) is not code.
        lines.push({ text, language: "other", markupLength: 0 });
        continue;
      }
    }
    const prefix = cellLanguage !== language ? magicPrefix.exec(text) : null;
    lines.push({ text, language: cellLanguage, markupLength: prefix ? prefix[0].length : 0 });
  }
  return buildViews(lines, runs);
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
  for (const cell of notebook.cells ?? []) {
    const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
    const cellLines = source.split("\n");
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
  return buildViews(lines, runs);
}

/**
 * @param fileLanguage The language of a plain file, or of a source notebook's own cells.
 */
export function notebookViews(
  content: string,
  options: { jupyter: boolean; fileLanguage: CodeLanguage },
): NotebookViews {
  if (options.jupyter) return jupyterLines(content);
  if (/^# Databricks notebook source/.test(content)) return sourceNotebookLines(content, "python");
  if (/^-- Databricks notebook source/.test(content)) return sourceNotebookLines(content, "sql");
  const lines = content
    .split("\n")
    .map((text): Line => ({ text, language: options.fileLanguage, markupLength: 0 }));
  return buildViews(lines, []);
}
