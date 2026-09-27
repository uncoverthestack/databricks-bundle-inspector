import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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

export function createSyncFilter(bundleRoot: string, sync?: Sync): SyncFilter {
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
  function isGitignored(path: string): boolean {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (gitignoreIn(dir)?.ignores(toPosix(relative(dir, path)))) return true;
      if (dir === topDir || dirname(dir) === dir) return false;
    }
  }

  const alwaysSkipped = ignore().add(ALWAYS_SKIPPED);
  const included = ignore().add(sync?.include ?? []);
  const excluded = ignore().add(sync?.exclude ?? []);

  return (absolutePath) => {
    if (!isInside(absolutePath, bundleRoot)) return true;
    const rel = toPosix(relative(bundleRoot, absolutePath));
    if (alwaysSkipped.ignores(rel) || excluded.ignores(rel)) return false;
    return included.ignores(rel) || !isGitignored(absolutePath);
  };
}
