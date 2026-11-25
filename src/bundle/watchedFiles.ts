import { existsSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { BundleGraph, ParsedBundleConfig } from "./graph/bundleGraph.js";
import { hasGlobCharacters, matchGoSegment } from "./goGlob.js";
import { CLI_NOTEBOOK_EXTENSIONS } from "./notebookFiles.js";
import { unquote } from "./runTargets.js";
import { createSyncFilter, type SyncFilter } from "./syncRules.js";

/**
 * The local files a bundle's checks depend on, so the inspector can re-check when
 * one of them is created, changed or deleted, not only when bundle YAML is saved.
 */
export interface BundleWatchSpec {
  bundleRoot: string;
  /** Files the bundle points at, whether or not they exist yet. */
  files: ReadonlySet<string>;
  /** Folders whose contents are checked (pipeline globs, directory references). */
  folders: readonly string[];
  /**
   * Absolute Go glob patterns the checks match files with: library and environment
   * dependency globs such as `dist/*.whl` (#590). Not subject to the sync rules: deploy
   * uploads libraries even when `.gitignore` skips their folder.
   */
  patterns: readonly string[];
  /** The bundle's `include` patterns, matched against YAML files under the root. */
  includes: Ignore;
  isSynced: SyncFilter;
  /**
   * Whether the file system ignores letter case here. The file watcher can then report
   * a file under another spelling than the one the bundle was opened with (`C:\Proj`
   * for `c:\proj`), and both mean the same file.
   */
  ignoresCase: boolean;
}

export type BundleChange = "config" | "source";

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  // ".." or "../x" leaves `dir`; a child named "..data" doesn't.
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** A notebook path without its extension, so `task.py` matches a reference to `task`. */
function withoutExtension(path: string): string {
  const extension = extname(path);
  return extension ? path.slice(0, -extension.length) : path;
}

/**
 * Collects the files and folders a bundle points at from the last check's result.
 *
 * @param includePatterns The raw `include` patterns from `databricks.yml`, so YAML files
 *   added later are picked up (the CLI's `include` output lists only files that matched).
 */
export function collectWatchSpec(
  graph: BundleGraph,
  config: ParsedBundleConfig,
  bundleRoot: string,
  includePatterns: readonly string[],
  options: { ignoresCase?: boolean } = {},
): BundleWatchSpec {
  const files = new Set<string>([
    join(bundleRoot, "databricks.yml"),
    join(bundleRoot, "databricks.yaml"),
  ]);
  const folders: string[] = [];
  const patterns: string[] = [];
  // A path with glob characters is matched as a pattern; any other is watched as a file.
  const addPath = (path: string) => (hasGlobCharacters(path) ? patterns.push(path) : files.add(path));

  // project_environment files and local environment dependencies (#590).
  for (const path of graph.environmentPaths ?? []) addPath(path);

  for (const included of config.include ?? []) {
    files.add(isAbsolute(included) ? included : join(bundleRoot, included));
  }

  for (const node of graph.nodes) {
    const taskData = node.taskData;
    const checked = taskData
      ? taskData.nestedTask
        ? [taskData, taskData.nestedTask]
        : [taskData]
      : [];
    for (const data of checked) {
      for (const ref of data.fileReferences) {
        if (!ref.resolvedPath) continue;
        if (ref.referenceType === "directory" || ref.referenceType === "dbt_project") {
          folders.push(ref.resolvedPath);
        } else {
          files.add(ref.resolvedPath);
        }
      }
      for (const ref of data.libraryReferences) {
        if (ref.isLocal && ref.resolvedPath) addPath(ref.resolvedPath);
      }
    }
    // Notebooks a task's notebook runs with %run or dbutils.notebook.run: their widgets and
    // whether they exist change what the checks find.
    const usage = node.data?.widgetUsage as { runFiles?: unknown } | undefined;
    for (const file of Array.isArray(usage?.runFiles) ? usage.runFiles : []) {
      if (typeof file === "string") files.add(file);
    }
    const runTargets = node.data?.runTargets;
    for (const run of Array.isArray(runTargets) ? (runTargets as Array<{ target?: unknown; file?: unknown }>) : []) {
      if (typeof run.target !== "string" || typeof run.file !== "string") continue;
      const written = unquote(run.target);
      if (written.startsWith("./") || written.startsWith("../")) files.add(join(dirname(run.file), written));
    }
    for (const ref of node.pipelineLibraries ?? []) {
      if (!ref.checked || !ref.resolvedPath) continue;
      if (ref.kind === "glob") folders.push(ref.resolvedPath);
      else files.add(ref.resolvedPath);
    }
  }

  return {
    bundleRoot,
    files,
    folders,
    patterns,
    includes: ignore().add([...includePatterns]),
    isSynced: createSyncFilter(bundleRoot, config.sync),
    ignoresCase: options.ignoresCase ?? false,
  };
}

interface ComparableSpec {
  root: string;
  files: ReadonlySet<string>;
  folders: readonly string[];
  patterns: readonly string[];
}

/**
 * Whether `path` matches an absolute Go glob `pattern`, one path segment at a time as
 * `filepath.Glob` does: `*` never crosses a separator, and there is no `**`.
 */
export function matchesGlobPattern(pattern: string, path: string): boolean {
  const patternParts = pattern.split(sep);
  const pathParts = path.split(sep);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) =>
    hasGlobCharacters(part) ? matchGoSegment(part, pathParts[index]!) === true : part === pathParts[index],
  );
}

/** The part of a glob pattern before its first segment with glob characters: the folder to watch. */
export function patternFolder(pattern: string): string {
  const parts = pattern.split(sep);
  const first = parts.findIndex((part) => hasGlobCharacters(part));
  return first <= 0 ? dirname(pattern) : parts.slice(0, first).join(sep) || sep;
}

const comparableSpecs = new WeakMap<BundleWatchSpec, ComparableSpec>();

/** The spec's paths in the form they are compared in: lower case where case is ignored. */
function comparable(spec: BundleWatchSpec): ComparableSpec {
  let cached = comparableSpecs.get(spec);
  if (!cached) {
    const key = (path: string) => (spec.ignoresCase ? path.toLowerCase() : path);
    cached = {
      root: key(spec.bundleRoot),
      files: new Set([...spec.files].map(key)),
      folders: spec.folders.map(key),
      patterns: spec.patterns.map(key),
    };
    comparableSpecs.set(spec, cached);
  }
  return cached;
}

/**
 * Whether a created, changed or deleted file affects the bundle's checks, and whether
 * it is bundle config (so targets and includes may have changed) or a source file.
 */
export function classifyChange(
  spec: BundleWatchSpec,
  changedPath: string,
): BundleChange | undefined {
  const { root, files, folders, patterns } = comparable(spec);
  const changed = spec.ignoresCase ? changedPath.toLowerCase() : changedPath;
  const isYaml = /\.ya?ml$/i.test(changedPath);
  const insideRoot = isInside(changed, root);
  // The sync rules read `.gitignore` files below the root, so they get the root as the
  // bundle spells it. A spelling that differs only in case has the same length.
  const forSyncRules =
    insideRoot && changedPath.length >= spec.bundleRoot.length
      ? spec.bundleRoot + changedPath.slice(spec.bundleRoot.length)
      : changedPath;

  if (files.has(changed)) return isYaml ? "config" : "source";

  // A file a library or dependency glob matches, such as a wheel built into `dist/` (#590).
  if (patterns.some((pattern) => matchesGlobPattern(pattern, changed))) return "source";

  if (isYaml && insideRoot) {
    const rel = toPosix(relative(root, changed));
    if (spec.includes.ignores(rel)) return "config";
  }

  // A notebook referenced without its extension, created as `name.py` or `name.ipynb`.
  if (files.has(withoutExtension(changed))) return "source";

  // A `.gitignore` edit changes which files are deployed. Its rules apply even when it
  // skips itself (`.gitignore` listed in it), so what counts is that its folder is read:
  // the root always is, and a folder the rules skip is not (#590).
  if (basename(changedPath) === ".gitignore" && insideRoot) {
    const folder = dirname(forSyncRules);
    if (folder === spec.bundleRoot || spec.isSynced(folder, true)) return "source";
  }

  if (
    folders.some((folder) => changed === folder || isInside(changed, folder)) &&
    spec.isSynced(forSyncRules)
  ) {
    return "source";
  }

  // A deleted or renamed folder that holds referenced files.
  if (changed === root || !insideRoot) {
    return undefined;
  }
  let holdsSource = false;
  for (const file of files) {
    if (!isInside(file, changed)) continue;
    if (/\.ya?ml$/i.test(file)) return "config";
    holdsSource = true;
  }
  if (holdsSource) return "source";
  for (const folder of folders) {
    if (isInside(folder, changed)) return "source";
  }

  // Any uploaded file or folder, referenced or not, can take the workspace path of another
  // (same_workspace_path, #370): `a.py` and `a.sql` both deploy to `a`, and so does a folder `a`.
  if (spec.isSynced(forSyncRules) && sharesWorkspacePath(changedPath)) return "source";

  return undefined;
}

/**
 * Whether something else on disk could deploy to the same workspace path as `changedPath`:
 * the same name with another notebook extension, with none, or a folder of that name. Checked
 * on disk, so a create, an edit (a notebook header added) and a delete of either one count.
 */
function sharesWorkspacePath(changedPath: string): boolean {
  const extension = extname(changedPath).toLowerCase();
  const stem = CLI_NOTEBOOK_EXTENSIONS.includes(extension) ? changedPath.slice(0, -extension.length) : changedPath;
  return [stem, ...CLI_NOTEBOOK_EXTENSIONS.map((other) => stem + other)].some(
    (candidate) => candidate !== changedPath && existsSync(candidate),
  );
}

/** Files outside the bundle root that the bundle points at, which need their own watchers. */
export function filesOutsideRoot(spec: BundleWatchSpec): string[] {
  return [...spec.files].filter((file) => !isInside(file, spec.bundleRoot));
}

/**
 * Folders outside the bundle root whose contents are checked: pipeline globs such as
 * `../external/**`, and the folders of glob patterns. Each needs a watcher for all files
 * below it (#590).
 */
export function foldersOutsideRoot(spec: BundleWatchSpec): string[] {
  const outside = [...spec.folders, ...spec.patterns.map(patternFolder)].filter(
    (folder) => folder !== spec.bundleRoot && !isInside(folder, spec.bundleRoot),
  );
  return [...new Set(outside)];
}
