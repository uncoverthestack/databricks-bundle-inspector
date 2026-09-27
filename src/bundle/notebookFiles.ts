import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { extname } from "node:path";

/**
 * How the Databricks CLI tells notebooks from plain files when it checks bundle paths
 * (`libs/notebook/detect.go` and `bundle/config/mutator/translate_paths.go` in databricks/cli):
 *
 * - `.py`, `.r`, `.scala` and `.sql` files are notebooks only when their first line is
 *   exactly the Databricks notebook header. The CLI reads the first 32 bytes.
 * - `.ipynb` files are notebooks when they are Jupyter JSON with `cells` and `metadata`,
 *   at nbformat 4 or later.
 * - Local notebook paths must include the extension; a notebook path without one is
 *   not found, even when `name.py` exists.
 * - A path the CLI expects to be a plain file must not be a notebook.
 */

/** Notebook extensions, in the order the CLI suggests them. */
export const CLI_NOTEBOOK_EXTENSIONS = [".py", ".r", ".scala", ".sql", ".ipynb"];

const NOTEBOOK_HEADERS: Record<string, string> = {
  ".py": "# Databricks notebook source",
  ".r": "# Databricks notebook source",
  ".scala": "// Databricks notebook source",
  ".sql": "-- Databricks notebook source",
};

const HEADER_BYTES = 32;

export type NotebookPathProblem =
  /** A notebook path without an extension, where `path + extension` exists. */
  | { kind: "missing_extension"; suggestedPath: string }
  /** A notebook path that points at a file that is not a notebook. */
  | { kind: "not_a_notebook" }
  /** A file path that points at a notebook. */
  | { kind: "is_a_notebook" };

/** The first-line header that makes a file with this extension a notebook, if any. */
export function notebookHeaderFor(filePath: string): string | undefined {
  return NOTEBOOK_HEADERS[extname(filePath).toLowerCase()];
}

function readFirstLine(filePath: string): string {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Like Go's line scanner: up to the first newline, without a trailing carriage return.
    return text.split("\n")[0]!.replace(/\r$/, "");
  } finally {
    closeSync(fd);
  }
}

function isJupyterNotebook(filePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return (
      Array.isArray(parsed.cells) &&
      typeof parsed.metadata === "object" &&
      parsed.metadata !== null &&
      typeof parsed.nbformat === "number" &&
      parsed.nbformat >= 4
    );
  } catch {
    return false;
  }
}

/**
 * Whether a local file is a Databricks notebook, as the CLI decides it.
 *
 * @returns `undefined` when the path is not a readable file (missing or a folder).
 */
export function isNotebookFile(filePath: string): boolean | undefined {
  try {
    if (!statSync(filePath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ipynb") return isJupyterNotebook(filePath);
  const header = NOTEBOOK_HEADERS[extension];
  if (!header) return false;
  try {
    return readFirstLine(filePath) === header;
  } catch {
    return undefined;
  }
}

/**
 * Checks a resolved local path against the CLI's notebook rules.
 *
 * @param rawPath The path as written in the bundle, used for the suggestion.
 * @param resolvedPath The absolute path the inspector resolved it to.
 * @param expects Whether the bundle field takes a notebook or a plain file.
 */
export function checkNotebookPath(
  rawPath: string,
  resolvedPath: string,
  expects: "notebook" | "file",
): NotebookPathProblem | undefined {
  const isNotebook = isNotebookFile(resolvedPath);

  if (expects === "file") {
    return isNotebook ? { kind: "is_a_notebook" } : undefined;
  }

  if (isNotebook === false) return { kind: "not_a_notebook" };
  if (isNotebook === undefined && !existsSync(resolvedPath) && !extname(resolvedPath)) {
    const extension = CLI_NOTEBOOK_EXTENSIONS.find((ext) => existsSync(resolvedPath + ext));
    if (extension) {
      return { kind: "missing_extension", suggestedPath: rawPath + extension };
    }
  }
  return undefined;
}
