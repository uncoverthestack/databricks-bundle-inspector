import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { Sync } from "./graph/bundleGraph.js";

/**
 * Whether `bundle deploy` would upload a local file, following the CLI's sync rules
 * (verified with `databricks bundle sync --dry-run` on CLI v1.17.0):
 *
 * - Files matched by a `.gitignore` are skipped, including nested `.gitignore` files,
 *   whether or not the folder is a git repository. A nested `!name` does not bring
 *   back a file a parent `.gitignore` skipped.
 * - `sync.include` adds back files a `.gitignore` skipped.
 * - `sync.exclude` skips files, and wins over `sync.include`.
 * - Patterns use gitignore syntax: `src/dir` skips the folder, `*.tmp` matches at any depth.
 *
 * Files outside the bundle root are reported as synced; they are only uploaded
 * through `sync.paths`, which is not modelled here.
 */
export type SyncFilter = (absolutePath: string) => boolean;

// The CLI never uploads these, whatever the bundle config says.
const ALWAYS_SKIPPED = [".git/", ".databricks/"];

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  // ".." or "../x" leaves `dir`; a child named "..data" doesn't.
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The git repository root containing `bundleRoot`, so a parent `.gitignore` applies too. */
function findGitRoot(bundleRoot: string): string | undefined {
  let dir = bundleRoot;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Why `bundle deploy` would skip a file. */
export type SyncExclusion =
  | { rule: "gitignore"; gitignoreFile: string }
  | { rule: "sync_exclude" }
  | { rule: "always" };

/**
 * Whether the deploy uploads from the bundle root, as these rules assume. The CLI fills
 * in `sync.paths: ["."]` when the bundle sets none (`sync_default_path.go`, v1.24.0), so a
 * real target's output always has it (#374). Any entry that isn't the bundle root moves
 * the sync root (`sync_infer_root.go`), and the CLI then writes every entry relative to
 * the new root: `[".", "../common"]` comes back as `["<bundle folder>", "common"]`.
 * Checked with `bundle validate -o json` on a workspace, 2026-11-06. In the preview,
 * an entry in an included file is relative to that file, so `[".."]` in
 * `resources/sync.yml` reads as outside, and the rules stay off there.
 */
export function syncsFromBundleRoot(bundleRoot: string, sync?: Sync): boolean {
  const root = resolve(bundleRoot);
  return (sync?.paths ?? []).every((entry) => resolve(root, entry) === root);
}

export function createSyncFilter(bundleRoot: string, sync?: Sync): SyncFilter {
  const exclusionOf = createSyncExclusion(bundleRoot, sync);
  return (absolutePath) => exclusionOf(absolutePath) === undefined;
}

/**
 * Like {@link createSyncFilter}, but says which rule skips a file, so an issue can
 * point at the `.gitignore` or `sync.exclude` to change.
 */
export function createSyncExclusion(
  bundleRoot: string,
  sync?: Sync,
): (absolutePath: string) => SyncExclusion | undefined {
  const gitRoot = findGitRoot(bundleRoot);
  const topDir = gitRoot && isInside(bundleRoot, gitRoot) ? gitRoot : bundleRoot;
  const gitignoreByDir = new Map<string, Ignore | undefined>();

  function gitignoreIn(dir: string): Ignore | undefined {
    if (gitignoreByDir.has(dir)) return gitignoreByDir.get(dir);
    let rules: Ignore | undefined;
    try {
      rules = ignore().add(readFileSync(join(dir, ".gitignore"), "utf8"));
    } catch {
      rules = undefined;
    }
    gitignoreByDir.set(dir, rules);
    return rules;
  }

  // Unlike git, a deeper `.gitignore` cannot re-include (`!name`) a file that a
  // parent `.gitignore` skipped: the CLI skips a file if any level matches it.
  function gitignoreMatching(path: string): string | undefined {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (gitignoreIn(dir)?.ignores(toPosix(relative(dir, path)))) {
        return join(dir, ".gitignore");
      }
      if (dir === topDir || dirname(dir) === dir) return undefined;
    }
  }

  const alwaysSkipped = ignore().add(ALWAYS_SKIPPED);
  const included = ignore().add(sync?.include ?? []);
  const excluded = ignore().add(sync?.exclude ?? []);

  return (absolutePath) => {
    if (!isInside(absolutePath, bundleRoot)) return undefined;
    const rel = toPosix(relative(bundleRoot, absolutePath));
    if (alwaysSkipped.ignores(rel)) return { rule: "always" };
    if (excluded.ignores(rel)) return { rule: "sync_exclude" };
    if (included.ignores(rel)) return undefined;
    const gitignoreFile = gitignoreMatching(absolutePath);
    return gitignoreFile ? { rule: "gitignore", gitignoreFile } : undefined;
  };
}
