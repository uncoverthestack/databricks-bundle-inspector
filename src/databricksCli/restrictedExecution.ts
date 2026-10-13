import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The Databricks CLI runs code a bundle defines while it loads the bundle, even for
 * `bundle validate`: shell commands under `experimental.scripts`, and Python under the
 * `python` section. With this variable set it refuses to, and reports an error instead.
 */
export const RESTRICTED_EXECUTION_VARIABLE = "DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION";

/** The environment every CLI call for a bundle gets, so inspecting never runs the bundle's code. */
export function restrictedCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [RESTRICTED_EXECUTION_VARIABLE]: "1" };
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
