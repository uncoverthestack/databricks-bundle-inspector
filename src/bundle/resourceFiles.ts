import path from "node:path";
import { isMap, LineCounter, parseDocument } from "yaml";

/**
 * The job a resource file's graph opens on: the one whose definition holds the cursor,
 * otherwise the first job in the file. `undefined` when the file defines no job.
 *
 * @param text The file's YAML.
 * @param cursorLine The cursor's 0-based line.
 */
export function jobKeyAtLine(text: string, cursorLine: number): string | undefined {
  const lineCounter = new LineCounter();
  let jobs: { key: string; firstLine: number; lastLine: number }[];
  try {
    const document = parseDocument(text, { lineCounter });
    if (document.errors.length > 0) return undefined;
    const resources = isMap(document.contents) ? document.contents.get("resources", true) : undefined;
    const jobMap = isMap(resources) ? resources.get("jobs", true) : undefined;
    if (!isMap(jobMap)) return undefined;
    jobs = jobMap.items.flatMap((item) => {
      const key = (item.key as { value?: unknown } | null)?.value;
      const offset = (item.key as { range?: [number, number, number] } | null)?.range?.[0];
      const end = (item.value as { range?: [number, number, number] } | null)?.range?.[2]
        ?? (item.key as { range?: [number, number, number] } | null)?.range?.[2];
      return typeof key === "string" && typeof offset === "number" && typeof end === "number"
        ? [{ key, firstLine: lineCounter.linePos(offset).line - 1, lastLine: lineCounter.linePos(Math.max(offset, end - 1)).line - 1 }]
        : [];
    });
  } catch {
    return undefined;
  }
  // A later section (pipelines, variables, etc.) is outside the last job too.
  const holding = jobs.find((job) => job.firstLine <= cursorLine && cursorLine <= job.lastLine);
  return (holding ?? jobs[0])?.key;
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
