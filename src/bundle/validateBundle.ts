import { execFile } from "child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ParsedBundleConfig } from "./bundleGraph.js";
import { resolveDatabricksCli } from "../databricksCli/validateDatabricksCli.js";
import type { DatabricksCliVerificationResult } from "../databricksCli/validateDatabricksCli.js";
import { parseBundleDiagnostics } from "./parseBundleDiagnostics.js";
export { extractBundleGraph, extractResourceNodes } from "./bundleGraph.js";
export type { BundleDiagnostic } from "./parseBundleDiagnostics.js";

export const BUNDLE_PROBE_TARGET = "__bundle_inspector_probe__";

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
  resolveDatabricksCli: () => Promise<
    DatabricksCliVerificationResult | undefined
  >;
}

export interface BundleError {
  bundleDir: string;
  bundleName: string;
  error: string;
  errorCode?: string;
  details?: string;
  diagnostics?: import("./parseBundleDiagnostics.js").BundleDiagnostic[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  details?: string;
  diagnostics?: import("./parseBundleDiagnostics.js").BundleDiagnostic[];
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


/**
 * Returns whether a working Databricks CLI can be resolved on this machine.
 *
 * @param configuredCliPath Optional user-configured CLI path from extension settings.
 * @returns `true` if a Databricks CLI executable could be located and verified.
 */
export async function isDatabricksInstalled(
  configuredCliPath?: string,
): Promise<boolean> {
  return (await resolveDatabricksCli(configuredCliPath)) !== null;
}

/**
 * Validates a Databricks bundle by running `databricks bundle validate --output json`.
 *
 * Uses a synthetic probe target by default so the CLI produces bundle JSON without
 * requiring valid workspace authentication.
 *
 * @param bundleDir Absolute or relative path to the directory containing `databricks.yml`.
 * @param target Deployment target to validate against. Defaults to the probe target.
 * @param configuredCliPath Optional user-configured CLI path from extension settings.
 * @returns A {@link BundleResult} that is either `ok` with parsed bundle data and any
 *   diagnostics, or `!ok` with a structured error.
 */
export async function validateBundle(
  bundleDir: string,
  target?: string,
  configuredCliPath?: string,
): Promise<BundleResult> {
  return validateBundleWithDependencies(bundleDir, target, {
    execFileAsync,
    resolveDatabricksCli: () => resolveDatabricksCli(configuredCliPath),
  });
}

/**
 * Testable core of {@link validateBundle} with injectable dependencies.
 *
 * @param bundleDir Absolute or relative path to the directory containing `databricks.yml`.
 * @param target Deployment target to validate against. Defaults to {@link BUNDLE_PROBE_TARGET}.
 * @param dependencies Injected `execFileAsync` and `resolveDatabricksCli` implementations.
 * @returns A {@link BundleResult} that is either `ok` with parsed bundle data and any
 *   diagnostics, or `!ok` with a structured error.
 */
export async function validateBundleWithDependencies(
  bundleDir: string,
  target: string | undefined = BUNDLE_PROBE_TARGET,
  dependencies: ValidateBundleDependencies,
): Promise<BundleResult> {
  const resolvedBundleDir = path.resolve(bundleDir);
  const bundleName = path.basename(resolvedBundleDir);

  console.log("[validateBundle] running preflight check");

  const cliResult = await dependencies.resolveDatabricksCli();
  const cliPath = cliResult?.candidate;

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
  // // TODO: revisit as we are hardcoding target, instead check if target was needed and then pass dev
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

    const diagnostics = parseBundleDiagnostics(stderr ?? "", target ?? BUNDLE_PROBE_TARGET);
    const issues = diagnostics.length > 0
      ? [{ code: "BUNDLE_DIAGNOSTICS", message: "Databricks CLI reported bundle diagnostics.", diagnostics }]
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
          const diagnostics = parseBundleDiagnostics(stderr ?? "", target ?? BUNDLE_PROBE_TARGET);
          return {
            ok: true,
            data: parsed.data,
            issues: [
              {
                code: "AUTH_NOT_CONFIGURED",
                message: "Databricks authentication is not configured.",
                details: stderr?.trim() ?? "",
                diagnostics,
              },
            ],
          };
        }
      } catch {
        // fall through to failure
      }
    }

    // Try to parse stdout even if command failed — probe target always exits non-zero
    if (stdout?.trim()) {
      try {
        const parsed = parseBundleConfig(JSON.parse(stdout));
        if (parsed.ok) {
          const diagnostics = parseBundleDiagnostics(stderr ?? "", target ?? BUNDLE_PROBE_TARGET);
          const issues = diagnostics.length > 0
            ? [{ code: "BUNDLE_DIAGNOSTICS", message: "Databricks CLI reported bundle diagnostics.", diagnostics }]
            : [{ code: "CLI_WARNING", message: "Databricks CLI validation completed with warnings.", details: stderr?.trim() || getErrorMessage(error) }];
          return { ok: true, data: parsed.data, issues };
        }
      } catch {
        // stdout is not valid JSON, fall through to error
      }
    }

    const probeTarget = target ?? BUNDLE_PROBE_TARGET;
    const diagnostics = parseBundleDiagnostics(stderr ?? "", probeTarget);
    const filteredStderr = (stderr ?? "")
      .split("\n")
      .filter((line) => !line.includes(`${probeTarget}: no such target`))
      .join("\n")
      .trim();
    const bundleError: BundleError = {
      bundleDir: resolvedBundleDir,
      bundleName,
      error: "Failed to validate Databricks bundle.",
      errorCode: "VALIDATION_FAILED",
      details: diagnostics.length > 0
        ? diagnostics.map((d) => `${d.severity}: ${d.message}${d.path ? ` in ${d.path}:${d.line ?? 0}:${d.column ?? 0}` : ""}`).join("\n")
        : filteredStderr || getErrorMessage(error),
    };
    if (diagnostics.length > 0) bundleError.diagnostics = diagnostics;
    return { ok: false, error: bundleError };
  }
}
