import path from "node:path";
import { CLI_NOTEBOOK_EXTENSIONS, isNotebookFile, type NotebookHeaderRule } from "./notebookFiles.js";

/**
 * Files `bundle deploy` can't both upload, because they get the same workspace path
 * (#370). From `libs/sync/snapshot_state.go` and `libs/notebook/ext.go` (CLI v1.24.0):
 * an uploaded file's workspace path is its path from the bundle root, without the
 * extension when the file is a notebook, and a `.designer.ipynb` file keeps its full
 * name. Two files with one workspace path stop the deploy with "both a and b point to
 * the same remote file location". A notebook whose workspace path is a folder of
 * uploaded files stops it too ("type mismatch (asked: NOTEBOOK, actual: DIRECTORY)").
 *
 * Checked by deploying one bundle per case (CLI v1.24.0, 2026-11-06): notebooks `.py` +
 * `.sql`, `.py` + `.ipynb` and `.PY` + `.sql`, a notebook and a plain file with no
 * extension, a notebook and a folder, all with `sync_mode: immutable` too, fail. A
 * gitignored file, a name that differs in case, and a plain `.py` without the header
 * next to a notebook `.sql`, deploy.
 */
export type WorkspacePathClash =
  | { kind: "files"; workspacePath: string; files: string[] }
  | { kind: "folder"; workspacePath: string; notebook: string };

const DESIGNER_EXTENSION = ".designer.ipynb";

/** The workspace path a notebook gets: its path without the extension. */
function notebookWorkspacePath(relative: string): string | undefined {
  if (relative.endsWith(DESIGNER_EXTENSION)) return undefined;
  const extension = path.posix.extname(relative);
  return CLI_NOTEBOOK_EXTENSIONS.includes(extension.toLowerCase()) ? relative.slice(0, -extension.length) : undefined;
}

/**
 * @param bundleRoot The folder the deploy uploads from.
 * @param files Every file under it (absolute paths).
 * @param uploaded Whether the deploy uploads a file (the `.gitignore` and `sync` rules).
 * @param rule The CLI version's notebook header rule.
 */
export function findWorkspacePathClashes(
  bundleRoot: string,
  files: readonly string[],
  uploaded: (file: string) => boolean,
  rule: NotebookHeaderRule,
): WorkspacePathClash[] {
  const relativeOf = (file: string) => path.relative(bundleRoot, file).split(path.sep).join("/");
  // Names first: only files that could share a workspace path are filtered by the sync
  // rules and have their first line read.
  const byWorkspacePath = new Map<string, string[]>();
  for (const file of files) {
    const candidate = notebookWorkspacePath(relativeOf(file));
    if (candidate !== undefined) byWorkspacePath.set(candidate, [...(byWorkspacePath.get(candidate) ?? []), file]);
  }
  if (byWorkspacePath.size === 0) return [];
  const plainByPath = new Map<string, string>();
  const folders = new Map<string, string[]>();
  for (const file of files) {
    const relative = relativeOf(file);
    if (byWorkspacePath.has(relative)) plainByPath.set(relative, file);
    for (let dir = path.posix.dirname(relative); dir !== "."; dir = path.posix.dirname(dir)) {
      if (byWorkspacePath.has(dir)) folders.set(dir, [...(folders.get(dir) ?? []), file]);
    }
  }

  const clashes: WorkspacePathClash[] = [];
  for (const [workspacePath, candidates] of byWorkspacePath) {
    const plain = plainByPath.get(workspacePath);
    const inFolder = folders.get(workspacePath);
    if (candidates.length < 2 && !plain && !inFolder) continue;
    const notebooks = candidates.filter((file) => uploaded(file) && isNotebookFile(file, rule) === true);
    if (notebooks.length === 0) continue;
    // A file keeps its full name when it isn't a notebook. One the CLI can't read is
    // skipped by the deploy, so it clashes with nothing.
    const keepsName = (file: string) =>
      notebookWorkspacePath(relativeOf(file)) === undefined || isNotebookFile(file, rule) === false;
    const sharing = [...notebooks, ...(plain && uploaded(plain) && keepsName(plain) ? [plain] : [])];
    if (sharing.length > 1) {
      clashes.push({ kind: "files", workspacePath, files: sharing.map(relativeOf).sort() });
    } else if (inFolder?.some(uploaded)) {
      clashes.push({ kind: "folder", workspacePath, notebook: relativeOf(notebooks[0]!) });
    }
  }
  return clashes.sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
}
