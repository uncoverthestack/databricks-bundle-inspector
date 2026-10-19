import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ParsedBundleConfig } from "./graph/bundleGraph.js";
import { CLI_NOTEBOOK_EXTENSIONS } from "./notebookFiles.js";

/**
 * When the Databricks CLI fully resolves a real target, it rewrites local paths to where
 * `bundle deploy` uploads them: `./src/load.py` becomes
 * `/Workspace/Users/<user>/.bundle/<bundle>/<target>/files/src/load` (a notebook loses its
 * extension). The inspector reads files from disk, so it maps those paths back.
 *
 * Files are uploaded from the sync root: the bundle folder, or a parent of it when
 * `sync.paths` reaches outside (CLI `sync_infer_root.go`). The CLI output doesn't say
 * which, so the sync root is the closest folder, from the bundle folder up, under which
 * every rewritten path exists. A full resolve only succeeds when they do (the CLI refuses
 * a missing notebook or file). If no folder fits, nothing is mapped and the paths stay as
 * the CLI gave them.
 */

type PathKind = "notebook" | "file" | "directory" | "glob";

interface PathSlot {
  /** The object that holds the path, and its key. */
  holder: Record<string, unknown>;
  key: string;
  kind: PathKind;
  /** The folder the inspector resolves this resource's relative paths from. */
  baseDir: string;
}

const GLOB_TAIL = /\/\*\*?(?:\/.*)?$|\/\*[^/]*$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function taskSlots(task: unknown, baseDir: string, slots: PathSlot[]): void {
  const t = record(task);
  if (!t) return;
  const add = (holder: unknown, key: string, kind: PathKind) => {
    const h = record(holder);
    if (h && typeof h[key] === "string") slots.push({ holder: h, key, kind, baseDir });
  };
  add(t.notebook_task, "notebook_path", "notebook");
  add(t.spark_python_task, "python_file", "file");
  add(record(t.sql_task)?.file, "path", "file");
  add(t.dbt_task, "project_directory", "directory");
  // A for_each task's inner task.
  taskSlots(record(t.for_each_task)?.task, baseDir, slots);
}

function pathSlots(
  config: ParsedBundleConfig,
  dirOf: (group: string, key: string) => string,
): PathSlot[] {
  const slots: PathSlot[] = [];
  const resources = record(config.resources) ?? {};
  for (const [key, job] of Object.entries(record(resources.jobs) ?? {})) {
    const tasks = record(job)?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) taskSlots(task, dirOf("jobs", key), slots);
  }
  for (const [key, pipeline] of Object.entries(record(resources.pipelines) ?? {})) {
    const libraries = record(pipeline)?.libraries;
    if (!Array.isArray(libraries)) continue;
    const baseDir = dirOf("pipelines", key);
    for (const library of libraries) {
      const lib = record(library);
      const add = (holder: unknown, key: string, kind: PathKind) => {
        const h = record(holder);
        if (h && typeof h[key] === "string") slots.push({ holder: h, key, kind, baseDir });
      };
      add(lib?.notebook, "path", "notebook");
      add(lib?.file, "path", "file");
      add(lib?.glob, "include", "glob");
    }
  }
  return slots;
}

/** The local file or folder a rewritten path points at under `root`, if it exists. */
function localTarget(root: string, rest: string, kind: PathKind): string | undefined {
  const exact = path.join(root, ...rest.split("/"));
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  switch (kind) {
    case "directory":
      return isDir(exact) ? exact : undefined;
    case "glob": {
      const base = rest.replace(GLOB_TAIL, "");
      return isDir(path.join(root, ...base.split("/"))) ? exact : undefined;
    }
    case "file":
      return isFile(exact) ? exact : undefined;
    case "notebook":
      if (isFile(exact)) return exact;
      return CLI_NOTEBOOK_EXTENSIONS.map((extension) => `${exact}${extension}`).find(isFile);
  }
}

function ancestors(dir: string): string[] {
  const out = [path.resolve(dir)];
  for (let parent = path.dirname(out[0]!); parent !== out[out.length - 1]; parent = path.dirname(parent)) {
    out.push(parent);
  }
  return out;
}

/**
 * Returns the CLI output with rewritten workspace paths mapped back to local paths,
 * relative to each resource's YAML folder as in the structural preview. Returns the
 * output unchanged when it has no rewritten paths, or when they can't all be found.
 *
 * @param dirOf The folder of the YAML file that defines a resource.
 */
export function localizeWorkspacePaths(
  config: ParsedBundleConfig,
  bundleRoot: string,
  dirOf: (group: string, key: string) => string,
): ParsedBundleConfig {
  const filePath = record(record(config)?.workspace)?.file_path;
  if (typeof filePath !== "string" || !filePath.startsWith("/") || filePath.includes("${")) {
    return config;
  }
  const prefix = `${filePath.replace(/\/+$/, "")}/`;

  const copy = structuredClone(config);
  const slots = pathSlots(copy, dirOf).filter((slot) =>
    (slot.holder[slot.key] as string).startsWith(prefix),
  );
  if (slots.length === 0) return config;

  for (const root of ancestors(bundleRoot)) {
    const targets = slots.map((slot) =>
      localTarget(root, (slot.holder[slot.key] as string).slice(prefix.length), slot.kind),
    );
    if (targets.some((target) => target === undefined)) continue;
    slots.forEach((slot, index) => {
      const relative = path.relative(slot.baseDir, targets[index]!).split(path.sep).join("/");
      slot.holder[slot.key] = relative.startsWith(".") ? relative : `./${relative}`;
    });
    return copy;
  }
  return config;
}
