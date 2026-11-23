/** Finds the bundles under the paths given on the command line, by the extension's rules (#348). */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { selectBundleRoots, SKIPPED_FOLDERS } from "../bundle/bundleDiscovery.js";

const BUNDLE_FILE_NAMES = new Set(["databricks.yml", "databricks.yaml"]);

export type Discovery = { ok: true; roots: string[] } | { ok: false; message: string };

/** Every bundle file below a folder. Skips SKIPPED_FOLDERS and never follows links, so it can't loop. */
function bundleFilesBelow(folder: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return; // A folder it can't read holds no bundle it can check.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.includes(entry.name)) bundleFilesBelow(path.join(folder, entry.name), found);
    } else if (entry.isFile() && BUNDLE_FILE_NAMES.has(entry.name)) {
      found.push(path.join(folder, entry.name));
    }
  }
}

/**
 * The bundle folders to check, closest to the top first. A path can be a folder (searched
 * below) or a bundle file. A path that doesn't exist, or a file that isn't a bundle file, is
 * wrong usage.
 */
export function discoverBundles(paths: readonly string[], cwd: string): Discovery {
  const files: string[] = [];
  for (const given of paths) {
    const full = path.resolve(cwd, given);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      return { ok: false, message: `No such file or folder: ${given}` };
    }
    if (stat.isDirectory()) bundleFilesBelow(full, files);
    else if (BUNDLE_FILE_NAMES.has(path.basename(full))) files.push(full);
    else return { ok: false, message: `Not a bundle file or a folder: ${given} (expected databricks.yml or databricks.yaml)` };
  }
  const roots = selectBundleRoots(files, Infinity);
  if (roots.length === 0) {
    return { ok: false, message: `No databricks.yml or databricks.yaml found under: ${paths.join(", ")}` };
  }
  return { ok: true, roots };
}

/** A path as the report shows it: relative to where the command ran, with `/` on every OS. */
export function displayPath(file: string, cwd: string): string {
  const relative = path.relative(cwd, file) || ".";
  return relative.split(path.sep).join("/");
}

/** Whether a path names an existing file (not a folder). */
export function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
