import { readdirSync } from "node:fs";
import path from "node:path";
import { SKIPPED_FOLDERS } from "./bundleDiscovery.js";
import { isNotebookFile } from "./notebookFiles.js";

/**
 * "Did you mean" for a local path that doesn't exist: the one file in the bundle with
 * the same name that the CLI would take for that field. Checked on CLI 0.299.0 and
 * 1.21.0 against a local fake workspace:
 *
 * - A path is read from the folder of the YAML file that writes it, not the bundle root
 *   (`src/train.py` written in `resources/job.yml` is "not found"), so the suggestion is
 *   written from there.
 * - A notebook field rejects a file without the notebook header ("expected a notebook
 *   ... but got a file"), and a file field rejects a notebook ("expected a file ... but
 *   got a notebook"), so only files of the right kind are suggested.
 *
 * No suggestion when several files would do, or when the bundle has too many files to
 * list them all: the inspector would be guessing.
 */

/** What the field takes, as the CLI checks it. `any`: wheels and jars, which have no notebook rule. */
export type ExpectedFile = "notebook" | "file" | "any";

const MAX_FILES = 20_000;

/** The files under a folder. `complete` is false when the listing stopped at {@link MAX_FILES}. */
export interface FileList {
  files: string[];
  complete: boolean;
}

/** Every file under a folder, skipping installed and generated folders. Stops at {@link MAX_FILES}. */
export function filesUnder(root: string, maxFiles = MAX_FILES): FileList {
  const files: string[] = [];
  const pending = [root];
  let readable = true;
  while (pending.length > 0 && files.length < maxFiles) {
    const folder = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      readable = false;
      continue;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.includes(entry.name)) pending.push(full);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) return { files, complete: false };
        files.push(full);
      }
    }
  }
  // Folders left unread may hold another file with the name.
  return { files, complete: readable && pending.length === 0 };
}

function fitsField(file: string, expects: ExpectedFile): boolean {
  if (expects === "any") return true;
  const notebook = isNotebookFile(file);
  return expects === "notebook" ? notebook === true : notebook === false;
}

/**
 * The path to write instead of `rawPath`, from the folder of `sourceFile`, or undefined.
 *
 * @param resolvedPath Where `rawPath` points, which doesn't exist.
 * @param files The bundle's files (see {@link filesUnder}), listed once per check.
 * @param excluded Whether the CLI would leave a file out of the upload.
 */
export function movedFileSuggestion(options: {
  rawPath: string;
  resolvedPath: string;
  sourceFile: string;
  expects: ExpectedFile;
  files: () => FileList;
  excluded: (file: string) => boolean;
}): string | undefined {
  const name = path.basename(options.resolvedPath);
  const listed = options.files();
  if (!listed.complete) return undefined;
  const matches = listed.files.filter(
    (file) =>
      path.basename(file) === name &&
      file !== options.resolvedPath &&
      !options.excluded(file) &&
      fitsField(file, options.expects),
  );
  if (matches.length !== 1) return undefined;
  const relative = path.relative(path.dirname(options.sourceFile), matches[0]!).split(path.sep).join("/");
  // Keep the way the path was written: `./src/x.py` stays with its `./`.
  return options.rawPath.startsWith("./") && !relative.startsWith("../") ? `./${relative}` : relative;
}
