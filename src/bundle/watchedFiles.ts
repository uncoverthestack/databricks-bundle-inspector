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
}

export type BundleChange = "config" | "source";

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
  };
}

/**
 * Whether a created, changed or deleted file affects the bundle's checks, and whether
 * it is bundle config (so targets and includes may have changed) or a source file.
 */
export function classifyChange(
  spec: BundleWatchSpec,
  changedPath: string,
): BundleChange | undefined {
  const { bundleRoot } = spec;
  const isYaml = /\.ya?ml$/i.test(changedPath);

  if (spec.files.has(changedPath)) return isYaml ? "config" : "source";

  if (isYaml && isInside(changedPath, bundleRoot)) {
    const rel = toPosix(relative(bundleRoot, changedPath));
    if (spec.includes.ignores(rel)) return "config";
  }

  // A notebook referenced without its extension, created as `name.py` or `name.ipynb`.
  if (spec.files.has(withoutExtension(changedPath))) return "source";

  // A `.gitignore` edit changes which files are deployed.
  if (
    basename(changedPath) === ".gitignore" &&
    isInside(changedPath, bundleRoot) &&
    spec.isSynced(changedPath)
  ) {
    return "source";
  }

  if (
    spec.folders.some(
      (folder) => changedPath === folder || isInside(changedPath, folder),
    ) &&
    spec.isSynced(changedPath)
  ) {
    return "source";
  }

  // A deleted or renamed folder that holds referenced files.
  if (changedPath === bundleRoot || !isInside(changedPath, bundleRoot)) {
    return undefined;
  }
  let holdsSource = false;
  for (const file of spec.files) {
    if (!isInside(file, changedPath)) continue;
    if (/\.ya?ml$/i.test(file)) return "config";
    holdsSource = true;
  }
  if (holdsSource) return "source";
  for (const folder of spec.folders) {
    if (isInside(folder, changedPath)) return "source";
  }

  return undefined;
}

/** Files outside the bundle root that the bundle points at, which need their own watchers. */
export function filesOutsideRoot(spec: BundleWatchSpec): string[] {
  return [...spec.files].filter((file) => !isInside(file, spec.bundleRoot));
}
