import path from "node:path";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";

/** A job or pipeline the graph can open on. */
export interface GraphResource {
  group: "jobs" | "pipelines";
  key: string;
}

/**
 * The job or pipeline a resource file's graph opens on: the one whose definition holds
 * the cursor, otherwise the file's first job, otherwise its first pipeline. `undefined`
 * when the file defines neither.
 *
 * @param text The file's YAML.
 * @param cursorLine The cursor's 0-based line.
 */
export function resourceAtLine(text: string, cursorLine: number): GraphResource | undefined {
  const lineCounter = new LineCounter();
  let found: (GraphResource & { firstLine: number; lastLine: number })[];
  try {
    const document = parseDocument(text, { lineCounter });
    if (document.errors.length > 0) return undefined;
    const resources = isMap(document.contents) ? document.contents.get("resources", true) : undefined;
    if (!isMap(resources)) return undefined;
    found = (["jobs", "pipelines"] as const).flatMap((group) => {
      const groupMap = resources.get(group, true);
      if (!isMap(groupMap)) return [];
      return groupMap.items.flatMap((item) => {
        const value = isScalar(item.key) ? (item.key.value ?? item.key.source) : undefined;
        // The CLI preserves null-like keys as written, but rejects numeric/boolean keys.
        const key = typeof value === "string" ? value : undefined;
        const offset = (item.key as { range?: [number, number, number] } | null)?.range?.[0];
        const end = (item.value as { range?: [number, number, number] } | null)?.range?.[2]
          ?? (item.key as { range?: [number, number, number] } | null)?.range?.[2];
        return typeof key === "string" && typeof offset === "number" && typeof end === "number"
          ? [{ group, key, firstLine: lineCounter.linePos(offset).line - 1, lastLine: lineCounter.linePos(Math.max(offset, end - 1)).line - 1 }]
          : [];
      });
    });
  } catch {
    return undefined;
  }
  // Outside every definition (variables, a comment, the `resources:` line), jobs come first.
  const holding = found.find((item) => item.firstLine <= cursorLine && cursorLine <= item.lastLine);
  const chosen = holding ?? found.find((item) => item.group === "jobs") ?? found[0];
  return chosen ? { group: chosen.group, key: chosen.key } : undefined;
}

/** One spelling of a path, for comparing paths on a file system that ignores case. */
function comparable(filePath: string, ignoresCase: boolean): string {
  const normalized = path.normalize(filePath);
  return ignoresCase ? normalized.toLowerCase() : normalized;
}

/**
 * The bundle whose last check loaded this file, from the CLI's own list of the files it
 * read. The deepest bundle wins when nested bundles both load it.
 *
 * @param loadedFiles Per bundle root: the bundle file and the files `include` loaded.
 * @param ignoresCase Per bundle root: whether its folder ignores letter case.
 */
export function bundleThatLoaded(
  filePath: string,
  loadedFiles: ReadonlyMap<string, ReadonlySet<string>>,
  ignoresCase: (bundleRoot: string) => boolean,
): string | undefined {
  let found: string | undefined;
  for (const [root, files] of loadedFiles) {
    const caseless = ignoresCase(root);
    const wanted = comparable(filePath, caseless);
    const loaded = [...files].some((file) => comparable(file, caseless) === wanted);
    if (loaded && (!found || root.length > found.length)) found = root;
  }
  return found;
}
