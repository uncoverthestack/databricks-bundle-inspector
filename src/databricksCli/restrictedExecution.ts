import { createHash } from "node:crypto";
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

/** The environment every CLI call for a bundle gets, so inspecting never runs the bundle's code. */
export function restrictedCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [RESTRICTED_EXECUTION_VARIABLE]: "1" };
}

/** A folder outside the bundle for the CLI's working files: the same one for the same bundle, another per bundle. */
export function bundleTempDir(bundleDir: string, tempRoot: string = os.tmpdir()): string {
  const id = createHash("sha256").update(path.resolve(bundleDir)).digest("hex").slice(0, 16);
  return path.join(tempRoot, "databricks-bundle-inspector", id);
}

/** The environment for a CLI call on a bundle: it never runs the bundle's code and never writes into its folder. */
export function bundleCliEnv(
  bundleDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...restrictedCliEnv(base), [BUNDLE_TMP_VARIABLE]: bundleTempDir(bundleDir) };
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
