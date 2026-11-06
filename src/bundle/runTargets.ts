import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { closestName } from "./closestName.js";
import { CLI_NOTEBOOK_EXTENSIONS, isNotebookFile, type NotebookHeaderRule } from "./notebookFiles.js";

/**
 * What a `%run` or `dbutils.notebook.run` path points at, read from the local files the
 * bundle deploys (#233). Both follow the same rule, checked by running a job on a
 * serverless workspace (Databricks CLI v1.24.0, 2026-11-06), each case a task of its own:
 *
 * - A notebook runs, with or without its extension in the path (`./helper`,
 *   `./helper.py`), from `./` or `../`, and a SQL or `.ipynb` notebook from a Python one.
 * - Nothing at the path fails: `Notebook not found` (`%run`), `Unable to access the
 *   notebook` (`notebook.run`). So does a plain file without the notebook header, and
 *   a folder, and a notebook `bundle deploy` doesn't upload (gitignored).
 * - The error names the forms Databricks accepts: a relative path (`./x`, `../x`) or an
 *   absolute one. Absolute paths name the workspace and can't be checked offline.
 */
export type RunTargetCheck =
  | { status: "notebook"; file: string }
  | { status: "missing"; suggestion?: string }
  | { status: "file"; file: string }
  | { status: "folder" }
  /** Not a path the inspector can check: built at run time, absolute, or bare. */
  | { status: "unchecked" };

/** A path without the quotes around it, if it has a matching pair. */
export function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

/**
 * Whether each name in the path is spelled with the same case as on disk. The workspace
 * tells `./Helper` and `./helper` apart (`Notebook not found`, checked on a workspace,
 * CLI v1.24.0, 2026-11-06), but macOS and Windows disks find either one.
 */
function sameCaseOnDisk(fromFile: string, target: string, found: string): boolean {
  const segments = target.split("/").filter((segment) => segment !== "" && segment !== ".");
  let dir = path.dirname(fromFile);
  for (const [index, segment] of segments.entries()) {
    if (segment === "..") {
      dir = path.dirname(dir);
      continue;
    }
    // The last name may have gained an extension: `./helper` found as helper.py.
    const name = index === segments.length - 1 ? path.basename(found) : segment;
    try {
      if (!readdirSync(dir).includes(name)) return false;
    } catch {
      return true;
    }
    dir = path.join(dir, name);
  }
  return true;
}

function kindOf(file: string): "file" | "folder" | undefined {
  try {
    const stats = statSync(file);
    return stats.isDirectory() ? "folder" : stats.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** Notebook names in a folder, without their extension, for "Did you mean". */
function notebookNamesIn(folder: string, rule: NotebookHeaderRule): string[] {
  try {
    return readdirSync(folder)
      .filter((name) => CLI_NOTEBOOK_EXTENSIONS.includes(path.extname(name).toLowerCase()))
      .filter((name) => isNotebookFile(path.join(folder, name), rule) === true)
      .map((name) => name.slice(0, -path.extname(name).length));
  } catch {
    return [];
  }
}

/**
 * @param fromFile The notebook the `%run` or `notebook.run` line is in.
 * @param target The path as written, or `null` when it isn't a string literal.
 * @param rule The CLI version's notebook header rule (see notebookFiles.ts).
 */
export function checkRunTarget(fromFile: string, written: string | null, rule: NotebookHeaderRule = "contains"): RunTargetCheck {
  // `%run "./a path"`: Databricks' own solution notebooks quote %run paths.
  const target = written === null ? null : unquote(written);
  if (target === null || !(target.startsWith("./") || target.startsWith("../"))) return { status: "unchecked" };
  const base = path.resolve(path.dirname(fromFile), target);
  const extension = path.extname(base).toLowerCase();
  // `./helper.py` names the file itself; `./helper` is a notebook whichever its extension.
  const candidates = CLI_NOTEBOOK_EXTENSIONS.includes(extension)
    ? [base]
    : CLI_NOTEBOOK_EXTENSIONS.map((extension) => base + extension);
  const kind = (file: string) => {
    const found = kindOf(file);
    return found && sameCaseOnDisk(fromFile, target, file) ? found : undefined;
  };
  const files = candidates.filter((candidate) => kind(candidate) === "file");
  const notebook = files.find((file) => isNotebookFile(file, rule) === true);
  if (notebook) return { status: "notebook", file: notebook };
  if (files[0]) return { status: "file", file: files[0] };
  const atBase = kind(base);
  if (atBase === "folder") return { status: "folder" };
  if (atBase === "file") return { status: "file", file: base };
  const wanted = path.basename(base, CLI_NOTEBOOK_EXTENSIONS.includes(extension) ? path.extname(base) : "");
  const suggestion = closestName(wanted, notebookNamesIn(path.dirname(base), rule));
  if (!suggestion) return { status: "missing" };
  const prefix = target.slice(0, target.length - path.basename(target).length);
  return { status: "missing", suggestion: `${prefix}${suggestion}` };
}
