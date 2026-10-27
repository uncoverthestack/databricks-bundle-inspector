import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What the lookup reads from the machine; replaced in tests. */
export interface CliLookupEnvironment {
  platform: NodeJS.Platform;
  /** VS Code's own PATH, as it was when VS Code started. */
  pathValue: string | undefined;
  env: NodeJS.ProcessEnv;
  isFile: (file: string) => boolean;
  /** Windows only: the `reg query ... /v Path` output for a key, or undefined if it could not be read. */
  readRegistryPath: (key: string) => Promise<string | undefined>;
  /** CLIs other extensions ship, such as the Databricks extension's. */
  extraCandidates: () => string[];
}

/** The keys Windows stores the system and the user `Path` under (Microsoft Learn, "Environment Variables"; checked on a real machine). */
export const WINDOWS_PATH_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
];

/** The CLI's file name. On Windows only `.exe`: Node does not run `.bat` or `.cmd` files without a shell. */
export function cliFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "databricks.exe" : "databricks";
}

/** The folders in a PATH value: trimmed, unquoted, without empty or repeated entries. */
export function pathEntries(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  const separator = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of (pathValue ?? "").split(separator)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!entry) continue;
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/** Every `databricks` (or `databricks.exe`) in the folders of a PATH value, in PATH order. */
export function cliFilesOnPath(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  isFile: (file: string) => boolean,
): string[] {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return pathEntries(pathValue, platform)
    .map((entry) => join(entry, cliFileName(platform)))
    .filter((file) => isFile(file));
}

/**
 * The file that running `databricks` by name starts, from {@link cliFilesOnPath}'s list: the
 * first one the OS can run. On macOS and Linux a file without the execute permission is
 * skipped, as the OS skips it; Windows has no such permission, so the first file runs.
 */
export function fileRunByName(
  files: readonly string[],
  platform: NodeJS.Platform,
  canRun: (file: string) => boolean = isExecutable,
): string | undefined {
  return platform === "win32" ? files[0] : files.find((file) => canRun(file));
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The value of `Path` in `reg query <key> /v Path` output. Checked on a real machine:
 * `    Path    REG_EXPAND_SZ    C:\...` for the system key, `REG_SZ` for the user key.
 */
export function parseRegQueryPath(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (match) return match[1]!.trim();
  }
  return undefined;
}

/** `%NAME%` replaced by the environment's value, ignoring letter case as Windows does. Unknown names stay as they are. */
export function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv): string {
  const byName = new Map(Object.entries(env).map(([name, val]) => [name.toLowerCase(), val]));
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => byName.get(name.toLowerCase()) ?? whole);
}

/** The system `Path` then the user `Path` that Windows has stored, which every new terminal starts from. */
export async function storedWindowsPath(lookup: CliLookupEnvironment): Promise<string> {
  const values: string[] = [];
  for (const key of WINDOWS_PATH_KEYS) {
    const output = await lookup.readRegistryPath(key);
    const value = output ? parseRegQueryPath(output) : undefined;
    if (value) values.push(expandWindowsVariables(value, lookup.env));
  }
  return values.join(";");
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `reg.exe` by its full path, never by name, so a program called `reg` elsewhere on PATH can't stand in for it. */
async function readRegistryPath(key: string): Promise<string | undefined> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) return undefined;
  try {
    const { stdout } = await execFileAsync(
      path.win32.join(systemRoot, "System32", "reg.exe"),
      ["query", key, "/v", "Path"],
      { timeout: 5_000, windowsHide: true },
    );
    return stdout;
  } catch {
    // Missing key, blocked by policy, or anything else: skip this step.
    return undefined;
  }
}

let lookupOptions: { extraCandidates: () => string[]; readStoredPath: boolean } = {
  extraCandidates: () => [],
  readStoredPath: true,
};

/**
 * Set by the extension at start: the CLIs other extensions ship, and whether to read
 * the `Path` Windows has stored (only turned off by the e2e suite that needs no CLI found).
 */
export function configureCliLookup(options: typeof lookupOptions): void {
  lookupOptions = options;
}

export function realLookupEnvironment(): CliLookupEnvironment {
  const { extraCandidates, readStoredPath } = lookupOptions;
  return {
    platform: process.platform,
    pathValue: process.env.PATH ?? process.env.Path,
    env: process.env,
    isFile,
    readRegistryPath: readStoredPath ? readRegistryPath : async () => undefined,
    extraCandidates,
  };
}

/**
 * Full paths to try when `databricks` on VS Code's PATH did not work, best first:
 * 1. every other `databricks` on that PATH, for when the first is another program such as the legacy pip CLI;
 * 2. on Windows, the ones on the `Path` Windows has stored, which a new install updates
 *    but VS Code only reads at start (so no restart is needed);
 * 3. the CLIs other extensions ship, such as the Databricks extension's.
 * Each appears once, and only if the file exists.
 */
export async function moreCliCandidates(lookup: CliLookupEnvironment): Promise<string[]> {
  const { platform } = lookup;
  const found = [...cliFilesOnPath(lookup.pathValue, platform, lookup.isFile)];
  if (platform === "win32") {
    found.push(...cliFilesOnPath(await storedWindowsPath(lookup), platform, lookup.isFile));
  }
  found.push(...lookup.extraCandidates().filter((file) => lookup.isFile(file)));

  const seen = new Set<string>();
  return found.filter((file) => {
    const key = platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
