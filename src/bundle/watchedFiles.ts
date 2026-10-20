import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { BundleGraph, ParsedBundleConfig } from "./graph/bundleGraph.js";
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
        if (ref.isLocal && ref.resolvedPath) files.add(ref.resolvedPath);
      }
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
    includes: ignore().add([...includePatterns]),
    isSynced: createSyncFilter(bundleRoot, config.sync),
    ignoresCase: options.ignoresCase ?? false,
  };
}

interface ComparableSpec {
  root: string;
  files: ReadonlySet<string>;
  folders: readonly string[];
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
  const { root, files, folders } = comparable(spec);
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

  if (isYaml && insideRoot) {
    const rel = toPosix(relative(root, changed));
    if (spec.includes.ignores(rel)) return "config";
  }

  // A notebook referenced without its extension, created as `name.py` or `name.ipynb`.
  if (files.has(withoutExtension(changed))) return "source";

  // A `.gitignore` edit changes which files are deployed.
  if (basename(changedPath) === ".gitignore" && insideRoot && spec.isSynced(forSyncRules)) {
    return "source";
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

  return undefined;
}

/** Files outside the bundle root that the bundle points at, which need their own watchers. */
export function filesOutsideRoot(spec: BundleWatchSpec): string[] {
  return [...spec.files].filter((file) => !isInside(file, spec.bundleRoot));
}
