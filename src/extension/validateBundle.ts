import { execFile } from "child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ParsedBundleConfig } from "../shared/bundleGraph.js";
export {
  extractBundleGraph,
  extractResourceNodes,
} from "../shared/bundleGraph.js";

const execFileAsync = promisify(execFile);

export interface BundleError {
  bundleDir: string;
  bundleName: string;
  error: string;
  errorCode?: string;
  details?: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  details?: string;
}

export type BundleResult =
  | {
      ok: true;
      data: ParsedBundleConfig;
      issues?: ValidationIssue[];
    }
  | {
      ok: false;
      error: BundleError;
      data?: ParsedBundleConfig;
    };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function extractStdout(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "stdout" in error &&
    typeof (error as { stdout?: unknown }).stdout === "string"
  ) {
    return (error as { stdout: string }).stdout;
  }
  return undefined;
}

function extractStderr(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof (error as { stderr?: unknown }).stderr === "string"
  ) {
    return (error as { stderr: string }).stderr;
  }
  return undefined;
}

function isAuthError(stderr?: string): boolean {
  return Boolean(stderr?.includes("cannot configure default credentials"));
}

async function resolveDatabricksCli(): Promise<string | null> {
  const candidates = [
    process.env.DATABRICKS_CLI_PATH,
    "/opt/homebrew/bin/databricks",
    "databricks",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 10_000 });
      console.log("[resolveDatabricksCli] using", candidate);
      return candidate;
    } catch (error) {
      console.log("[resolveDatabricksCli] failed", candidate, error);
    }
  }

  return null;
}

export async function isDatabricksInstalled(): Promise<boolean> {
  return (await resolveDatabricksCli()) !== null;
}

export async function validateBundle(
  bundleDir: string,
  target?: string,
): Promise<BundleResult> {
  const resolvedBundleDir = path.resolve(bundleDir);
  const bundleName = path.basename(resolvedBundleDir);

  console.log("[validateBundle] running preflight check");

  const cliPath = await resolveDatabricksCli();

  if (!cliPath) {
    return {
      ok: false,
      error: {
        bundleDir: resolvedBundleDir,
        bundleName,
        error:
          "Databricks CLI was not found. Install the Databricks CLI and ensure it is available on your PATH.",
        errorCode: "CLI_NOT_FOUND",
      },
    };
  }

  const args = ["bundle", "validate", "--output", "json"];
  if (target) {
    args.push("--target", target);
  }

  try {
    const { stdout, stderr } = await execFileAsync(cliPath, args, {
      cwd: resolvedBundleDir,
      timeout: 30_000,
    });

    const data = JSON.parse(stdout) as ParsedBundleConfig;
    const issues = stderr?.trim()
      ? [
          {
            code: "VALIDATION_WARNING",
            message: "Databricks CLI reported a warning during validation.",
            details: stderr.trim(),
          },
        ]
      : undefined;

    return issues ? { ok: true, data, issues } : { ok: true, data };
  } catch (error: unknown) {
    console.warn("[validateBundle] command exited non-zero", {
      cliPath,
      bundleDir: resolvedBundleDir,
      target,
      error,
    });

    if (hasErrorCode(error, "ENOENT")) {
      return {
        ok: false,
        error: {
          bundleDir: resolvedBundleDir,
          bundleName,
          error: "Databricks CLI could not be executed from the resolved path.",
          errorCode: "CLI_NOT_EXECUTABLE",
          details: getErrorMessage(error),
        },
      };
    }

    if (hasErrorCode(error, "ETIMEDOUT")) {
      return {
        ok: false,
        error: {
          bundleDir: resolvedBundleDir,
          bundleName,
          error: "Databricks bundle validation timed out.",
          errorCode: "VALIDATION_TIMEOUT",
          details: getErrorMessage(error),
        },
      };
    }

    const stdout = extractStdout(error);
    const stderr = extractStderr(error);

    if (isAuthError(stderr) && stdout?.trim()) {
      try {
        const data = JSON.parse(stdout) as ParsedBundleConfig;

        return {
          ok: true,
          data,
          issues: [
            {
              code: "AUTH_NOT_CONFIGURED",
              message: "Databricks authentication is not configured.",
              details: stderr?.trim() ?? "",
            },
          ],
        };
      } catch {
        // fall through to failure
      }
    }

    return {
      ok: false,
      error: {
        bundleDir: resolvedBundleDir,
        bundleName,
        error: "Failed to validate Databricks bundle.",
        errorCode: "VALIDATION_FAILED",
        details: getErrorMessage(error),
      },
    };
  }
}
