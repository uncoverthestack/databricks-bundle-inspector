import { stat } from "node:fs/promises";

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
