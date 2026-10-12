import path from "node:path";

/** Matches a bundle file anywhere below a folder. */
export const BUNDLE_FILE_GLOB = "**/databricks.{yml,yaml}";

/** Folders that hold installed or generated files, never a bundle the user is working on. */
export const SKIPPED_FOLDERS: readonly string[] = [
  "node_modules",
  ".git",
  ".databricks",
  ".venv",
  "venv",
];

/** Glob for the folders in {@link SKIPPED_FOLDERS}, at any depth. */
export const SKIPPED_FOLDERS_GLOB = `**/{${SKIPPED_FOLDERS.join(",")}}/**`;

/** How many bundles are checked when a folder opens. The rest are checked on save. */
export const MAX_BUNDLES_CHECKED_ON_OPEN = 10;

/**
 * Picks the bundle roots to check from the bundle files found in the open folders.
 *
 * A folder with both `databricks.yml` and `databricks.yaml` counts once. Bundles
 * closest to the top of the folder come first, so a limit keeps the ones the user
 * most likely opened the folder for.
 */
export function selectBundleRoots(
  bundleFilePaths: readonly string[],
  limit: number = MAX_BUNDLES_CHECKED_ON_OPEN,
): string[] {
  const depth = (dir: string) => dir.split(/[\\/]+/).length;
  const roots = new Set<string>();
  for (const filePath of bundleFilePaths) {
    const dir = path.dirname(filePath);
    if (dir.split(/[\\/]+/).some((segment) => SKIPPED_FOLDERS.includes(segment))) continue;
    roots.add(dir);
  }
  return [...roots]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, Math.max(0, limit));
}
