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
 * The part after `workspace.file_path` is relative to the sync root: the bundle folder, or
 * a parent of it when `sync.paths` reaches outside (CLI `sync_infer_root.go`). The output
 * doesn't say which, and neither its `sync.paths` nor `bundle.git.bundle_root_path` can
 * tell. So the sync root comes from an anchor: a path as written in the bundle's YAML,
 * resolved against the file it is written in (as the CLI does), compared with what the CLI
 * made of the same field. If no anchor is found, anchors disagree, or any rewritten path
 * is missing under the sync root, nothing is mapped and the paths stay as the CLI gave them.
 */

type PathKind = "notebook" | "file" | "directory" | "glob";

/** A path field the inspector reads, found by what it belongs to rather than by its text. */
interface PathSlot {
  /** `jobs.<key>.<task_key>[.<inner task_key>].<field>` or `pipelines.<key>.<index>.<field>`. */
  id: string;
  holder: Record<string, unknown>;
  key: string;
  kind: PathKind;
}

/** A YAML file of the bundle, as written. */
export interface SourceDocument {
  file: string;
  doc: unknown;
}

const GLOB_TAIL = /\/\*\*?(?:\/.*)?$|\/\*[^/]*$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The path fields under one `resources` mapping, written or resolved. */
function slotsIn(resources: unknown): PathSlot[] {
  const slots: PathSlot[] = [];
  const add = (id: string, holder: unknown, key: string, kind: PathKind) => {
    const h = record(holder);
    if (h && typeof h[key] === "string") slots.push({ id, holder: h, key, kind });
  };
  const task = (prefix: string, value: unknown) => {
    const t = record(value);
    if (!t || typeof t.task_key !== "string") return;
    const id = `${prefix}.${t.task_key}`;
    add(`${id}.notebook`, t.notebook_task, "notebook_path", "notebook");
    add(`${id}.python_file`, t.spark_python_task, "python_file", "file");
    add(`${id}.sql_file`, record(t.sql_task)?.file, "path", "file");
    add(`${id}.dbt_project`, t.dbt_task, "project_directory", "directory");
    task(id, record(t.for_each_task)?.task);
  };
  const r = record(resources) ?? {};
  for (const [key, job] of Object.entries(record(r.jobs) ?? {})) {
    const tasks = record(job)?.tasks;
    if (Array.isArray(tasks)) for (const t of tasks) task(`jobs.${key}`, t);
  }
  for (const [key, pipeline] of Object.entries(record(r.pipelines) ?? {})) {
    const libraries = record(pipeline)?.libraries;
    if (!Array.isArray(libraries)) continue;
    libraries.forEach((library, index) => {
      const lib = record(library);
      const id = `pipelines.${key}.${index}`;
      add(`${id}.notebook`, lib?.notebook, "path", "notebook");
      add(`${id}.file`, lib?.file, "path", "file");
      add(`${id}.glob`, lib?.glob, "include", "glob");
    });
  }
  return slots;
}

/**
 * A written path with `${var.<name>}` and `${bundle.<field>}` (such as `${bundle.target}`) filled
 * in from the CLI output, which has their final values. Undefined if anything is left
 * unresolved, such as `${workspace.file_path}`.
 */
function substituted(value: string, output: Record<string, unknown> | undefined): string | undefined {
  const filled = value.replace(/\$\{(var|bundle)\.([A-Za-z0-9_-]+)\}/g, (match, scope: string, name: string) => {
    const resolved =
      scope === "var" ? record(record(output?.variables)?.[name])?.value : record(output?.bundle)?.[name];
    return typeof resolved === "string" ? resolved : match;
  });
  return filled.includes("${") ? undefined : filled;
}

/**
 * The sync root implied by one written path: the folder that, joined with the CLI's
 * rewritten path, gives the written file. Undefined if the two don't line up.
 */
function rootFromAnchor(written: string, dir: string, rest: string, kind: PathKind): string | undefined {
  const local = path.resolve(dir, kind === "glob" ? written.replace(GLOB_TAIL, "") : written);
  const tail = (kind === "glob" ? rest.replace(GLOB_TAIL, "") : rest).split("/").filter(Boolean);
  const parts = local.split(path.sep);
  // An empty rest is the upload folder itself: only a folder (a dbt project) can be that.
  if (tail.length === 0) return kind === "directory" ? local : undefined;
  if (tail.length >= parts.length) return undefined;
  for (let i = 1; i <= tail.length; i++) {
    const want = tail[tail.length - i]!;
    const have = parts[parts.length - i]!;
    // The CLI drops a notebook's extension.
    const sameNotebook =
      i === 1 &&
      kind === "notebook" &&
      CLI_NOTEBOOK_EXTENSIONS.some((ext) => have.toLowerCase().endsWith(ext) && have.slice(0, -ext.length) === want);
    if (have !== want && !sameNotebook) return undefined;
  }
  return parts.slice(0, parts.length - tail.length).join(path.sep) || path.sep;
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
    case "notebook": {
      if (isFile(exact)) return exact;
      // The CLI drops the extension, so `nb` could be `nb.py` or `nb.sql`. Only an
      // unambiguous match is used; the CLI accepts both files existing side by side.
      const found = CLI_NOTEBOOK_EXTENSIONS.map((extension) => `${exact}${extension}`).filter(isFile);
      return found.length === 1 ? found[0] : undefined;
    }
  }
}

/**
 * Returns the CLI output with rewritten workspace paths mapped back to local paths,
 * relative to each resource's YAML folder as in the structural preview. Returns the
 * output unchanged when there is nothing to map or the sync root can't be established.
 *
 * @param sources The bundle's YAML files as written, for the anchors.
 * @param dirOf The folder of the YAML file that defines a resource.
 */
export function localizeWorkspacePaths(
  config: ParsedBundleConfig,
  sources: SourceDocument[],
  dirOf: (group: string, key: string) => string,
): ParsedBundleConfig {
  const output = record(config);
  const filePath = record(output?.workspace)?.file_path;
  if (typeof filePath !== "string" || !filePath.startsWith("/") || filePath.includes("${")) {
    return config;
  }
  const base = filePath.replace(/\/+$/, "");
  const prefix = `${base}/`;
  // A path can also be the upload folder itself, such as a dbt project written as ".".
  const isRewritten = (value: string) => value === base || value.startsWith(prefix);

  const copy = structuredClone(config);
  const rewritten = new Map(
    slotsIn(record(copy)?.resources)
      .filter((slot) => isRewritten(slot.holder[slot.key] as string))
      .map((slot) => [slot.id, slot]),
  );
  if (rewritten.size === 0) return config;
  const rest = (slot: PathSlot) => (slot.holder[slot.key] as string).slice(prefix.length);

  // Anchors: each field as written, in the resource itself or in the selected target.
  const target = record(output?.bundle)?.target;
  const roots = new Set<string>();
  /** The file each anchored path was written as, which beats guessing a notebook's extension. */
  const writtenFiles = new Map<string, Set<string>>();
  for (const { file, doc } of sources) {
    const d = record(doc);
    const written = [
      ...slotsIn(d?.resources),
      ...(typeof target === "string" ? slotsIn(record(record(record(d?.targets)?.[target]))?.resources) : []),
    ];
    for (const anchor of written) {
      const slot = rewritten.get(anchor.id);
      const value = slot && substituted(anchor.holder[anchor.key] as string, output);
      if (!slot || !value || value.startsWith("/Workspace/")) continue;
      const root = rootFromAnchor(value, path.dirname(file), rest(slot), slot.kind);
      if (!root) continue;
      roots.add(root);
      if (slot.kind === "notebook") {
        const files = writtenFiles.get(slot.id) ?? new Set<string>();
        files.add(path.resolve(path.dirname(file), value));
        writtenFiles.set(slot.id, files);
      }
    }
  }
  if (roots.size !== 1) return config;
  const [root] = [...roots];

  // Each path is mapped on its own: one that can't be matched to exactly one local file
  // stays as the CLI gave it, so its checks are skipped rather than run on a guess.
  let mapped = false;
  for (const slot of rewritten.values()) {
    const written = [...(writtenFiles.get(slot.id) ?? [])].filter((f) => existsSync(f));
    const local = written.length === 1 ? written[0] : localTarget(root!, rest(slot), slot.kind);
    if (!local) continue;
    const [group, key] = slot.id.split(".");
    const relative = path.relative(dirOf(group!, key!), local).split(path.sep).join("/") || ".";
    slot.holder[slot.key] = relative.startsWith(".") ? relative : `./${relative}`;
    mapped = true;
  }
  return mapped ? copy : config;
}

/**
 * Returns the CLI output with paths written relative to the bundle root mapped back to the
 * values written in the YAML. With a real target, the CLI rewrites each path from its YAML
 * file's folder to the bundle root before uploading it; when any path then fails its check
 * (a missing file, a notebook without its extension), the CLI stops there and leaves every
 * path in that form, without the `workspace.file_path` prefix that
 * {@link localizeWorkspacePaths} maps. The inspector reads paths from their YAML file's
 * folder, so it would look for `src/etl` in `resources/src/etl`.
 *
 * A path is only mapped when the CLI's value, read from the bundle root, and the value
 * written in the YAML, read from its own file, name the same file. So the file never
 * changes, only the folder its path is counted from. Anything else stays as the CLI gave it.
 *
 * @param sources The bundle's YAML files as written.
 * @param dirOf The folder of the YAML file that defines a resource.
 * @param bundleRoot The folder of `databricks.yml`.
 */
export function localizeBundleRootPaths(
  config: ParsedBundleConfig,
  sources: SourceDocument[],
  dirOf: (group: string, key: string) => string,
  bundleRoot: string,
): ParsedBundleConfig {
  const output = record(config);
  const copy = structuredClone(config);
  const slots = new Map(slotsIn(record(copy)?.resources).map((slot) => [slot.id, slot]));
  const target = record(output?.bundle)?.target;
  let mapped = false;
  for (const { file, doc } of sources) {
    const d = record(doc);
    const written = [
      ...slotsIn(d?.resources),
      ...(typeof target === "string" ? slotsIn(record(record(record(d?.targets)?.[target]))?.resources) : []),
    ];
    for (const anchor of written) {
      const slot = slots.get(anchor.id);
      const value = slot && substituted(anchor.holder[anchor.key] as string, output);
      const reported = slot?.holder[slot.key] as string | undefined;
      if (!slot || !value || !reported || reported === value) continue;
      if (path.isAbsolute(reported) || path.isAbsolute(value) || reported.includes("${")) continue;
      const local = path.resolve(path.dirname(file), value);
      if (path.resolve(bundleRoot, reported) !== local) continue;
      const [group, key] = slot.id.split(".");
      const relative = path.relative(dirOf(group!, key!), local).split(path.sep).join("/") || ".";
      slot.holder[slot.key] = relative.startsWith(".") ? relative : `./${relative}`;
      mapped = true;
    }
  }
  return mapped ? copy : config;
}
