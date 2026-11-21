import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The Databricks CLI runs code a bundle defines while it loads the bundle, even for
 * `bundle validate`: shell commands under `experimental.scripts`, and Python under the
 * `python` section. With this variable set it refuses to, and reports an error instead.
 */
export const RESTRICTED_EXECUTION_VARIABLE = "DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION";

/**
 * Where the CLI keeps its working files. By default that is `<bundle>/.databricks`,
 * which `bundle validate` creates (with a `.gitignore`) for a real target with a login.
 * Set to another folder, nothing is written into the bundle folder.
 */
export const BUNDLE_TMP_VARIABLE = "DATABRICKS_BUNDLE_TMP";

/** The bundle explicitly selected by the inspector, rather than one the CLI discovers above it. */
export const BUNDLE_ROOT_VARIABLE = "DATABRICKS_BUNDLE_ROOT";

/** The environment every CLI call for a bundle gets, so inspecting never runs the bundle's code. */
export function restrictedCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [RESTRICTED_EXECUTION_VARIABLE]: "1" };
}

/** A folder outside the bundle for the CLI's working files: the same one for the same bundle, another per bundle. */
export function bundleTempDir(bundleDir: string, tempRoot: string = os.tmpdir()): string {
  const id = createHash("sha256").update(path.resolve(bundleDir)).digest("hex").slice(0, 16);
  return path.join(tempRoot, "databricks-bundle-inspector", id);
}

/**
 * Whether a folder can be handed to the CLI: a real folder, not a link, owned by this user,
 * that no one else can write to. Windows (no `getuid`) gives each user their own temp folder.
 */
export function isPrivateFolder(folder: string, uid: number | undefined = process.getuid?.()): boolean {
  if (uid === undefined) return true;
  try {
    const stats = lstatSync(folder);
    return stats.isDirectory() && stats.uid === uid && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** The folder used instead when the usual one isn't private, per usual folder, for this session. */
const fallbackTempDirs = new Map<string, string>();

/**
 * {@link bundleTempDir}, created with owner-only permissions if it is missing. On a machine
 * whose temp folder every user shares (`/tmp` on Linux), another user could make that
 * folder, whose name can be worked out, first, or a link to somewhere else, and the CLI
 * would use it as it is (#469). When it or its parent isn't private, a new private folder
 * is used for this session instead.
 */
export function privateBundleTempDir(
  bundleDir: string,
  tempRoot: string = os.tmpdir(),
  uid: number | undefined = process.getuid?.(),
): string {
  const dir = bundleTempDir(bundleDir, tempRoot);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Checked next: something else is there.
  }
  if (isPrivateFolder(path.dirname(dir), uid) && isPrivateFolder(dir, uid)) return dir;
  let fallback = fallbackTempDirs.get(dir);
  if (!fallback || !isPrivateFolder(fallback, uid)) {
    fallback = mkdtempSync(path.join(tempRoot, "databricks-bundle-inspector-"));
    fallbackTempDirs.set(dir, fallback);
  }
  return fallback;
}

/** Uses the selected bundle, without running its code or writing into its folder. */
export function bundleCliEnv(
  bundleDir: string,
  base: NodeJS.ProcessEnv = process.env,
  tempDir: string = bundleTempDir(bundleDir),
): NodeJS.ProcessEnv {
  const root = path.resolve(bundleDir);
  return {
    ...restrictedCliEnv(base),
    [BUNDLE_TMP_VARIABLE]: tempDir,
    [BUNDLE_ROOT_VARIABLE]: root,
    // The CLI also accepts this older name. Neither inherited value may select another bundle.
    BUNDLE_ROOT: root,
  };
}

interface NotRunDiagnostic {
  severity: "warning" | "error";
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

const NOT_RUN = [
  {
    cliError: /running scripts is not allowed when DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION is set/i,
    message:
      "This bundle's scripts (experimental.scripts) were not run. The inspector never runs code from a bundle, so what it shows may differ from a deploy.",
    key: /^\s*scripts\s*:/,
  },
  {
    cliError: /running python code is not allowed when DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION is set/i,
    message:
      "This bundle's Python code (the python section) was not run. The inspector never runs code from a bundle, so resources defined in Python are missing here.",
    key: /^\s*python\s*:/,
  },
];

/**
 * Rewrites the CLI's "not allowed when ... is set" errors, which name a variable the user
 * never set, into a warning that says what happened, placed on the line of the bundle
 * file that asks for the code to run (its first line when that is in another file).
 */
export async function explainCodeNotRun<T extends NotRunDiagnostic>(
  diagnostics: T[],
  bundleDir: string,
): Promise<T[]> {
  if (!diagnostics.some((d) => NOT_RUN.some((rule) => rule.cliError.test(d.message)))) {
    return diagnostics;
  }
  let bundleFile = "databricks.yml";
  let lines: string[] = [];
  for (const fileName of ["databricks.yml", "databricks.yaml"]) {
    try {
      lines = (await readFile(path.join(bundleDir, fileName), "utf8")).split("\n");
      bundleFile = fileName;
      break;
    } catch {
      // Try the alternate bundle filename.
    }
  }
  return diagnostics.map((diagnostic) => {
    const rule = NOT_RUN.find((candidate) => candidate.cliError.test(diagnostic.message));
    if (!rule) return diagnostic;
    const index = lines.findIndex((line) => rule.key.test(line));
    const line = Math.max(index, 0);
    return {
      ...diagnostic,
      severity: "warning",
      message: rule.message,
      path: bundleFile,
      line: line + 1,
      column: (lines[line]?.search(/\S/) ?? 0) + 1,
    };
  });
}
