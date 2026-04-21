import { execFile } from "child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ParsedBundleConfig } from "../shared/bundleGraph.js";
import { resolveDatabricksCli } from "./validateDatabricksCli.js";
export {
  extractBundleGraph,
  extractResourceNodes,
} from "../shared/bundleGraph.js";

const execFileAsync = promisify(execFile);

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type ExecFileLike = (
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    timeout?: number;
  },
) => Promise<ExecFileResult>;

interface ValidateBundleDependencies {
  execFileAsync: ExecFileLike;
  resolveDatabricksCli: () => Promise<string | null>;
}

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

// Fix #5: Runtime schema validation with Zod.
// JSON.parse produces `unknown` at runtime; the `as ParsedBundleConfig` cast
// is a compile-time fiction. This schema validates the minimum shape required
// before we pass data into the rest of the extension.
// Zod v4 requires both key and value schemas for z.record().
const ParsedBundleConfigSchema = z
  .object({
    bundle: z
      .object({
        name: z.string(),
      })
      .loose(),
    resources: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    sync: z.unknown().optional(),
    artifacts: z.unknown().optional(),
    include: z.array(z.string()).optional(),
    workspace: z.unknown().optional(),
  })
  .passthrough();

function parseBundleConfig(
  raw: unknown,
): { ok: true; data: ParsedBundleConfig } | { ok: false; error: string } {
  const result = ParsedBundleConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  return { ok: true, data: result.data as ParsedBundleConfig };
}

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

// Fix #4: Reject DATABRICKS_CLI_PATH values that contain shell metacharacters.
// execFile already avoids shell injection, but a value like `rm -rf /; databricks`
// could still point at an unexpected executable. This is a defence-in-depth check.
function isValidExecutablePath(value: string): boolean {
  return !/[;&|`$<>]/.test(value);
}

// Fix #8: Cache the resolved CLI path so we don't spawn probe subprocesses on
// every invocation. The cache is invalidated to `undefined` on extension startup
// and can be reset explicitly if needed (e.g., after a settings change).
let cachedCliPath: string | null | undefined;

export function resetCliPathCache(): void {
  cachedCliPath = undefined;
}

export async function resolveDatabricksCli(): Promise<string | null> {
  if (cachedCliPath !== undefined) {
    return cachedCliPath;
  }

  const envPath = process.env.DATABRICKS_CLI_PATH;

  const candidates = [
    envPath,
    "/opt/homebrew/bin/databricks",
    "databricks",
  ].filter((value): value is string => {
    if (!value) {
      return false;
    }
    // Fix #4: Warn and skip paths containing shell metacharacters.
    if (!isValidExecutablePath(value)) {
      console.warn(
        "[resolveDatabricksCli] DATABRICKS_CLI_PATH contains suspicious characters and will be ignored:",
        value,
      );
      return false;
    }
    return true;
  });

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        timeout: 10_000,
      });
      console.log(
        "[resolveDatabricksCli] using",
        `${candidate} version: ${stdout.trim()}`,
      );
      cachedCliPath = candidate;
      return cachedCliPath;
    } catch (error) {
      console.log("[resolveDatabricksCli] failed", candidate, error);
    }
  }

  cachedCliPath = null;
  return null;
}

export async function isDatabricksInstalled(): Promise<boolean> {
  return (await resolveDatabricksCli()) !== null;
}

export async function validateBundle(
  bundleDir: string,
  target?: string,
): Promise<BundleResult> {
  return validateBundleWithDependencies(bundleDir, target, {
    execFileAsync,
    resolveDatabricksCli,
  });
}

export async function validateBundleWithDependencies(
  bundleDir: string,
  target: string | undefined,
  dependencies: ValidateBundleDependencies,
): Promise<BundleResult> {
  const resolvedBundleDir = path.resolve(bundleDir);
  const bundleName = path.basename(resolvedBundleDir);

  console.log("[validateBundle] running preflight check");

  const cliPath = await dependencies.resolveDatabricksCli();

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
  // TODO: revisit as we are hardcoding target, instead check if target was needed and then pass dev
  if (target) {
    args.push("--target", target);
  }

  try {
    const { stdout, stderr } = await dependencies.execFileAsync(cliPath, args, {
      cwd: resolvedBundleDir,
      timeout: 30_000,
    });

    const parsed = parseBundleConfig(JSON.parse(stdout));
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          bundleDir: resolvedBundleDir,
          bundleName,
          error: "Databricks CLI returned an unexpected bundle shape.",
          errorCode: "INVALID_BUNDLE_SHAPE",
          details: parsed.error,
        },
      };
    }

    const issues = stderr?.trim()
      ? [
          {
            code: "VALIDATION_WARNING",
            message: "Databricks CLI reported a warning during validation.",
            details: stderr.trim(),
          },
        ]
      : undefined;

    return issues
      ? { ok: true, data: parsed.data, issues }
      : { ok: true, data: parsed.data };
  } catch (error: unknown) {
    const stdout = extractStdout(error);
    const stderr = extractStderr(error);

    console.warn("[validateBundle] command exited non-zero", {
      cliPath,
      bundleDir: resolvedBundleDir,
      target,
      error: getErrorMessage(error),
      stdout,
      stderr,
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

    if (isAuthError(stderr) && stdout?.trim()) {
      try {
        const parsed = parseBundleConfig(JSON.parse(stdout));
        if (parsed.ok) {
          return {
            ok: true,
            data: parsed.data,
            issues: [
              {
                code: "AUTH_NOT_CONFIGURED",
                message: "Databricks authentication is not configured.",
                details: stderr?.trim() ?? "",
              },
            ],
          };
        }
      } catch {
        // fall through to failure
      }
    }

    // Try to parse stdout even if command failed, in case it's valid JSON with warnings
    if (stdout?.trim()) {
      try {
        const parsed = parseBundleConfig(JSON.parse(stdout));
        if (parsed.ok) {
          return {
            ok: true,
            data: parsed.data,
            issues: [
              {
                code: "CLI_WARNING",
                message: "Databricks CLI validation completed with warnings.",
                details: stderr?.trim() || getErrorMessage(error),
              },
            ],
          };
        }
      } catch {
        // stdout is not valid JSON, fall through to error
      }
    }

    return {
      ok: false,
      error: {
        bundleDir: resolvedBundleDir,
        bundleName,
        error: "Failed to validate Databricks bundle.",
        errorCode: "VALIDATION_FAILED",
        details: stderr?.trim() || getErrorMessage(error),
      },
    };
  }
}
