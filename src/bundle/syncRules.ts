import { existsSync, lstatSync, readFileSync } from "node:fs";
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
 * - Symbolic links are skipped, files and folders alike, whatever `sync.include` says:
 *   the CLI's walk keeps only regular files and folders (`libs/fileset/fileset.go`,
 *   v1.24.0, "Skip non-regular files (e.g. symlinks)"). Checked on a workspace
 *   2026-11-06: a task on a symlinked notebook deploys, then fails with "Unable to
 *   access the notebook" (#372).
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
  /** `link` is the file itself, or with `folder`, the folder above it that is a link. */
  | { rule: "symlink"; link: string; folder: boolean }
  | { rule: "gitignore"; gitignoreFile: string }
  | { rule: "sync_exclude" }
  | { rule: "always" };

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

  const linkByPath = new Map<string, boolean>();
  function isLink(path: string): boolean {
    let link = linkByPath.get(path);
    if (link === undefined) {
      try {
        link = lstatSync(path).isSymbolicLink();
      } catch {
        link = false;
      }
      linkByPath.set(path, link);
    }
    return link;
  }
  /** The file, or a folder between it and the bundle root, that is a symbolic link. */
  function linkOnTheWay(path: string): string | undefined {
    for (let current = path; isInside(current, bundleRoot); current = dirname(current)) {
      if (isLink(current)) return current;
    }
    return undefined;
  }

  return (absolutePath) => {
    if (!isInside(absolutePath, bundleRoot)) return undefined;
    const link = linkOnTheWay(absolutePath);
    if (link) return { rule: "symlink", link, folder: link !== absolutePath };
    const rel = toPosix(relative(bundleRoot, absolutePath));
    if (alwaysSkipped.ignores(rel)) return { rule: "always" };
    if (excluded.ignores(rel)) return { rule: "sync_exclude" };
    if (included.ignores(rel)) return undefined;
    const gitignoreFile = gitignoreMatching(absolutePath);
    return gitignoreFile ? { rule: "gitignore", gitignoreFile } : undefined;
  };
}
