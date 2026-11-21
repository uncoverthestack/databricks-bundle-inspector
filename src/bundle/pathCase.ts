import { readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

interface FileIdentity {
  ino: number | bigint;
  dev: number | bigint;
}

/** `Src/Jobs` becomes `sRC/jOBS`: the same folder wherever letter case is ignored. */
export function swapLetterCase(text: string): string {
  return [...text]
    .map((character) => {
      const lower = character.toLowerCase();
      return character === lower ? character.toUpperCase() : lower;
    })
    .join("");
}

/**
 * Whether the file system holding `dir` ignores letter case, as macOS and Windows do
 * by default and Linux does not. It asks the folder itself rather than guessing from
 * the operating system: a Mac disk can be case-sensitive, and Windows can make single
 * folders case-sensitive.
 *
 * @param statFile Replaced in tests, so they do not depend on the machine's file system.
 */
export async function folderIgnoresCase(
  dir: string,
  statFile: (path: string) => Promise<FileIdentity> = stat,
): Promise<boolean> {
  const respelled = swapLetterCase(dir);
  if (respelled === dir) return false;
  try {
    const [original, other] = await Promise.all([statFile(dir), statFile(respelled)]);
    return original.ino === other.ino && original.dev === other.dev;
  } catch {
    // The other spelling does not exist, so letter case matters here.
    return false;
  }
}

/**
 * `file` as the disk spells it below `anchor`, found by comparing folder names while
 * ignoring letter case, so a case-sensitive disk (Linux) finds it too. The exact spelling
 * wins when a folder holds both. Undefined when nothing matches, or `file` is not below
 * `anchor`. Names above `anchor` are left as they are, as they aren't uploaded (#477).
 */
export function spelledOnDisk(file: string, anchor: string): string | undefined {
  const rel = path.relative(anchor, file);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  let folder = anchor;
  for (const name of rel.split(path.sep)) {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return undefined;
    }
    const found = names.includes(name) ? name : names.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (found === undefined) return undefined;
    folder = path.join(folder, found);
  }
  return folder;
}

/**
 * `rawPath` with its trailing names spelled as `spelled` spells them: `./Notebooks/Main.py`
 * and `/b/notebooks/main.py` give `./notebooks/main.py`. A leading `.` or `..` stays.
 */
export function respellPath(rawPath: string, spelled: string): string {
  const written = rawPath.split(/[\\/]/);
  const real = spelled.split(path.sep);
  for (let i = written.length - 1, j = real.length - 1; i >= 0 && j >= 0; i--, j--) {
    if (written[i] === "" || written[i] === "." || written[i] === "..") break;
    written[i] = real[j]!;
  }
  return written.join("/");
}

