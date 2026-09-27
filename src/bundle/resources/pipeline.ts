import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { checkNotebookPath, type NotebookPathProblem } from "../notebookFiles.js";
import {
  containsTemplate,
  isRemotePath,
  resolveLocalPath,
  type SourceLocationResolver,
} from "./task.js";

/**
 * A local source a pipeline's `libraries` points at. The CLI does not check
 * these when validating against the probe target, so a missing file would
 * otherwise only surface on `bundle deploy`.
 */
export interface PipelineLibraryReference {
  kind: "notebook" | "file" | "glob";
  path: string;
  resolvedPath: string | undefined;
  exists: boolean;
  /** False when the path could not be checked locally (workspace path, variable, complex glob). */
  checked: boolean;
  /** Set when the path breaks the CLI's notebook rules (see notebookFiles.ts). */
  notebookProblem?: NotebookPathProblem;
  sourceFile: string;
  sourceLine: number;
  sourceColumn?: number;
  yamlPath: string;
}

// `folder/**` (any file below) and `folder/*` (any file directly inside) are the
// forms checked. Anything else with wildcard characters is left unchecked rather
// than guessed at.
const GLOB_SUFFIX = /\/(\*\*|\*)$/;
const GLOB_CHARS = /[*?[\]{}]/;

function hasFile(dir: string, recursive: boolean): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    // Hidden files (.gitkeep, .DS_Store) are not pipeline sources.
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) return true;
    if (recursive && entry.isDirectory() && hasFile(resolve(dir, entry.name), true)) {
      return true;
    }
  }
  return false;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function checkGlob(
  pattern: string,
  sourceFileDir: string,
  bundleRoot: string,
): Pick<PipelineLibraryReference, "resolvedPath" | "exists" | "checked"> {
  const suffix = GLOB_SUFFIX.exec(pattern);
  const base = suffix ? pattern.slice(0, suffix.index) : pattern;
  if (!base || GLOB_CHARS.test(base)) {
    return { resolvedPath: undefined, exists: false, checked: false };
  }
  if (!suffix) {
    // No wildcard: a plain file or folder path.
    const { resolvedPath, exists } = resolveLocalPath(base, sourceFileDir, bundleRoot);
    return { resolvedPath, exists, checked: true };
  }
  const recursive = suffix[1] === "**";
  for (const dir of new Set([sourceFileDir, bundleRoot])) {
    const candidate = resolve(dir, base);
    if (isDirectory(candidate) && hasFile(candidate, recursive)) {
      return { resolvedPath: candidate, exists: true, checked: true };
    }
  }
  return { resolvedPath: resolve(sourceFileDir, base), exists: false, checked: true };
}

/**
 * Local notebook, file and glob sources in a pipeline's `libraries`, resolved
 * relative to the YAML file that declares the pipeline (then the bundle root).
 */
export function getPipelineLibraryReferences(
  pipeline: Record<string, unknown>,
  sourceFile: string,
  sourceFileDir: string,
  bundleRoot: string,
  resolveSourceLocation?: SourceLocationResolver,
): PipelineLibraryReference[] {
  const libraries = Array.isArray(pipeline.libraries) ? pipeline.libraries : [];
  const refs: PipelineLibraryReference[] = [];

  libraries.forEach((library: unknown, index) => {
    if (typeof library !== "object" || library === null) return;
    const entry = library as Record<string, Record<string, unknown> | undefined>;

    const candidates: Array<[PipelineLibraryReference["kind"], unknown, string]> = [
      ["notebook", entry.notebook?.path, "notebook.path"],
      ["file", entry.file?.path, "file.path"],
      ["glob", entry.glob?.include, "glob.include"],
    ];
    for (const [kind, rawPath, subPath] of candidates) {
      if (typeof rawPath !== "string" || !rawPath) continue;
      const yamlPath = `libraries[${index}].${subPath}`;
      const location = resolveSourceLocation?.(yamlPath);
      const local = !isRemotePath(rawPath) && !containsTemplate(rawPath);
      const result = !local
        ? { resolvedPath: undefined, exists: false, checked: false }
        : kind === "glob"
          ? checkGlob(rawPath, sourceFileDir, bundleRoot)
          : {
              // No extension guessing: the CLI requires a notebook path's extension.
              ...resolveLocalPath(rawPath, sourceFileDir, bundleRoot),
              checked: true,
            };
      const notebookProblem =
        kind !== "glob" && result.resolvedPath
          ? checkNotebookPath(rawPath, result.resolvedPath, kind === "notebook" ? "notebook" : "file")
          : undefined;
      refs.push({
        kind,
        path: rawPath,
        ...result,
        ...(notebookProblem ? { notebookProblem } : {}),
        sourceFile,
        sourceLine: location?.line ?? 0,
        ...(location ? { sourceColumn: location.column } : {}),
        yamlPath,
      });
    }
  });

  return refs;
}
