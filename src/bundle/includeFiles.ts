import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "yaml";

const BUNDLE_FILE_NAMES = ["databricks.yml", "databricks.yaml"];

// The scan for resource files is a hint, so it gives up on large folders instead of
// slowing down every inspection.
const MAX_FOLDERS = 500;
const MAX_YAML_FILES = 300;
const MAX_FILE_BYTES = 1_000_000;
const SKIPPED_FOLDERS = new Set(["node_modules", "__pycache__", "dist", "build", "out", "venv", "env"]);

export interface IncludeEntry {
  entry: string;
  /** 1-based line of the entry in the bundle file, when it can be found. */
  line?: number;
}

export interface RootIncludeEntries {
  /** The bundle file the entries were read from, relative to the bundle root. */
  file?: string;
  /** The text of that file. */
  text?: string;
  entries: IncludeEntry[];
}

function bareListItem(line: string): string {
  return line
    .replace(/#.*$/, "")
    .trim()
    .replace(/^-\s*/, "")
    .replace(/^["']|["']$/g, "");
}

/** The `include` entries written in the bundle's own `databricks.yml`, with their lines. */
export function readIncludeEntries(bundleRoot: string): RootIncludeEntries {
  for (const name of BUNDLE_FILE_NAMES) {
    let text: string;
    try {
      text = readFileSync(join(bundleRoot, name), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parse(text);
    } catch {
      return { file: name, text, entries: [] };
    }
    const include = (parsed as { include?: unknown } | null)?.include;
    if (!Array.isArray(include)) return { file: name, text, entries: [] };

    const lines = text.split("\n");
    const entries = include
      .filter((value): value is string => typeof value === "string")
      .map((entry): IncludeEntry => {
        const index = lines.findIndex((line) => bareListItem(line) === entry);
        return index === -1 ? { entry } : { entry, line: index + 1 };
      });
    return { file: name, text, entries };
  }
  return { entries: [] };
}

/** Whether the bundle file names this file, even in a comment such as a commented-out include. */
function isMentioned(bundleText: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w./-])(\\./)?${escaped}($|[^\\w.-])`, "m").test(bundleText);
}

function definesResources(parsed: unknown): boolean {
  const resources = (parsed as { resources?: unknown } | null)?.resources;
  if (typeof resources !== "object" || resources === null || Array.isArray(resources)) return false;
  return Object.values(resources).some(
    (group) =>
      typeof group === "object" && group !== null && !Array.isArray(group) && Object.keys(group).length > 0,
  );
}

export interface UnloadedResourceFile {
  /** Relative to the bundle root, with `/` separators. */
  file: string;
  /** 1-based line of the `resources:` key. */
  line: number;
}

/**
 * YAML files in the bundle folder that define resources but are not among the files the
 * CLI loaded. The CLI loads only `databricks.yml` and what `include` selects, and says
 * nothing about the rest.
 *
 * Skips hidden and build folders, folders that hold another bundle, and files that the
 * bundle file mentions: a commented-out include line means the author left it out on
 * purpose. Returns nothing when the folder is too big to scan cheaply.
 */
export function findUnloadedResourceFiles(
  bundleRoot: string,
  loadedFiles: string[],
  bundleText = "",
): UnloadedResourceFile[] {
  // The CLI lists the files with the operating system's separator, which is `\` on Windows,
  // and keeps the folder casing of the pattern. Windows and macOS file systems ignore case,
  // so `Resources/a.yml` and `resources/a.yml` are the same file there.
  const loaded = new Set(loadedFiles.map((file) => posix.normalize(file.replace(/\\/g, "/")).toLowerCase()));
  const candidates: string[] = [];
  const pending = [""];
  let foldersSeen = 0;

  while (pending.length > 0) {
    const folder = pending.pop()!;
    foldersSeen += 1;
    if (foldersSeen > MAX_FOLDERS) return [];
    let entries;
    try {
      entries = readdirSync(join(bundleRoot, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    const isOtherBundle =
      folder !== "" && entries.some((entry) => entry.isFile() && BUNDLE_FILE_NAMES.includes(entry.name));
    if (isOtherBundle) continue;

    for (const entry of entries) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_FOLDERS.has(entry.name)) pending.push(relative);
      } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
        if (folder === "" && BUNDLE_FILE_NAMES.includes(entry.name)) continue;
        candidates.push(relative);
      }
    }
  }
  if (candidates.length > MAX_YAML_FILES) return [];

  const found: UnloadedResourceFile[] = [];
  for (const file of candidates.sort()) {
    if (loaded.has(file.toLowerCase()) || isMentioned(bundleText, file)) continue;
    const absolute = join(bundleRoot, file);
    try {
      if (!existsSync(absolute) || statSync(absolute).size > MAX_FILE_BYTES) continue;
      const text = readFileSync(absolute, "utf8");
      if (!definesResources(parse(text))) continue;
      const index = text.split("\n").findIndex((line) => /^resources\s*:/.test(line));
      found.push({ file, line: index === -1 ? 1 : index + 1 });
    } catch {
      // Not valid YAML: the CLI is not going to load it either.
    }
  }
  return found;
}
