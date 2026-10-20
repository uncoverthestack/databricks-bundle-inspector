import { execFile } from "child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ParsedBundleConfig } from "./graph/bundleGraph.js";
import { resolveDatabricksCli } from "../databricksCli/validateDatabricksCli.js";
import { bundleCliEnv, explainCodeNotRun } from "../databricksCli/restrictedExecution.js";
import type {
  CliProblem,
  CliResolutionFailure,
  VerifiedDatabricksCli,
} from "../databricksCli/validateDatabricksCli.js";
import { legacyCliVersion } from "../databricksCli/parsing.js";
import {
  parseAvailableTargets,
  parseBundleDiagnostics,
} from "./parseBundleDiagnostics.js";
export {
  extractBundleGraph,
  extractResourceNodes,
} from "./graph/bundleGraph.js";
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
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ExecFileResult>;

/**
 * The most output `bundle validate` may print. Node's default is 1 MiB, which a bundle of
 * about 1,000 tasks with long descriptions already exceeds (1.3 MB, CLI 1.21.0); a
 * 10,000-task bundle prints about 13 MB. Bounded, so a runaway CLI can't use up memory.
 */
export const MAX_CLI_OUTPUT_BYTES = 64 * 1024 * 1024;

interface ValidateBundleDependencies {
  execFileAsync: ExecFileLike;
  resolveDatabricksCli: () => Promise<
    VerifiedDatabricksCli | CliResolutionFailure
  >;
}

export interface BundleError {
  bundleDir: string;
  bundleName: string;
  error: string;
  errorCode?: string;
  /** Set with `CLI_NOT_FOUND`: why no Databricks CLI could be used. */
  cliProblem?: CliProblem;
  /** With `not_databricks_cli`: what that other program printed for `--version`. */
  cliVersionOutput?: string;
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
      targetOptions?: string[];
    }
  | {
      ok: false;
      error: BundleError;
      data?: ParsedBundleConfig;
      targetOptions?: string[];
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
    targets: z.record(z.string(), z.unknown()).optional(),
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

function cliNotFoundMessage(failure: CliResolutionFailure): string {
  switch (failure.problem) {
    case "configured_path_invalid":
      return `The databricksBundleInspector.cliPath setting ("${failure.configuredPath}") is not a working Databricks CLI, and none was found on your PATH. Fix the setting or install the Databricks CLI.`;
    case "not_databricks_cli": {
      const legacy = legacyCliVersion(failure.versionOutput ?? "");
      if (legacy) {
        return `The "databricks" command on your PATH is the legacy databricks-cli pip package (${legacy}), which can't check bundles. Install the Databricks CLI.`;
      }
      const printed = failure.versionOutput?.trim().slice(0, 60);
      return `The "databricks" command on your PATH is not the Databricks CLI${printed ? ` (it printed "${printed}")` : ""}. Install the Databricks CLI.`;
    }
    case "not_installed":
      return "Databricks CLI not found. Just installed it? Restart VS Code. Otherwise, locate it.";
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function wasKilled(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { killed?: unknown }).killed === true;
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

function isExpectedProbeTargetFailure(
  target: string | undefined,
  stderr?: string,
): boolean {
  const effectiveTarget = target ?? BUNDLE_PROBE_TARGET;
  return (
    effectiveTarget === BUNDLE_PROBE_TARGET &&
    Boolean(stderr?.includes(`${BUNDLE_PROBE_TARGET}: no such target`))
  );
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
 * @param profile Optional `~/.databrickscfg` profile from extension settings, used for real targets.
 * @returns A {@link BundleResult} that is either `ok` with parsed bundle data and any
 *   diagnostics, or `!ok` with a structured error.
 */
export async function validateBundle(
  bundleDir: string,
  target?: string,
  configuredCliPath?: string,
  profile?: string,
): Promise<BundleResult> {
  return validateBundleWithDependencies(
    bundleDir,
    target,
    {
      execFileAsync,
      resolveDatabricksCli: () => resolveDatabricksCli(configuredCliPath),
    },
    profile,
  );
}

/**
 * Testable core of {@link validateBundle} with injectable dependencies.
 *
 * @param bundleDir Absolute or relative path to the directory containing `databricks.yml`.
 * @param target Deployment target to validate against. Defaults to {@link BUNDLE_PROBE_TARGET}.
 * @param dependencies Injected `execFileAsync` and `resolveDatabricksCli` implementations.
 * @param profile Optional `~/.databrickscfg` profile, passed for real targets only.
 * @returns A {@link BundleResult} that is either `ok` with parsed bundle data and any
 *   diagnostics, or `!ok` with a structured error.
 */
export async function validateBundleWithDependencies(
  bundleDir: string,
  target: string | undefined = BUNDLE_PROBE_TARGET,
  dependencies: ValidateBundleDependencies,
  profile?: string,
): Promise<BundleResult> {
  const resolvedBundleDir = path.resolve(bundleDir);
  const bundleName = path.basename(resolvedBundleDir);

  console.log("[validateBundle] running preflight check");

  const cliResult = await dependencies.resolveDatabricksCli();

  if (!cliResult.ok) {
    return {
      ok: false,
      error: {
        bundleDir: resolvedBundleDir,
        bundleName,
        error: cliNotFoundMessage(cliResult),
        errorCode: "CLI_NOT_FOUND",
        cliProblem: cliResult.problem,
        ...(cliResult.versionOutput !== undefined ? { cliVersionOutput: cliResult.versionOutput } : {}),
      },
    };
  }
  const cliPath = cliResult.candidate;
  const readDiagnostics = (stderr: string, probeTarget: string) =>
    explainCodeNotRun(parseBundleDiagnostics(stderr, probeTarget), resolvedBundleDir);
  const args = ["bundle", "validate", "--output", "json"];
  // // TODO: revisit as we are hardcoding target, instead check if target was needed and then pass dev
  if (target) {
    args.push("--target", target);
  }
  // A real target may need a login. With several profiles for the same host the CLI
  // refuses to pick one, so the user can name it. The structural preview needs none.
  const trimmedProfile = profile?.trim();
  if (target && target !== BUNDLE_PROBE_TARGET && trimmedProfile) {
    args.push("--profile", trimmedProfile);
  }

  try {
    const { stdout, stderr } = await dependencies.execFileAsync(cliPath, args, {
      cwd: resolvedBundleDir,
      timeout: 30_000,
      maxBuffer: MAX_CLI_OUTPUT_BYTES,
      // Never let the CLI run scripts or Python that the bundle defines, or write
      // its working files into the bundle folder.
      env: bundleCliEnv(resolvedBundleDir),
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

    const diagnostics = await readDiagnostics(
      stderr ?? "",
      target ?? BUNDLE_PROBE_TARGET,
    );
    const targetOptions = parseAvailableTargets(stderr ?? "");
    const issues =
      diagnostics.length > 0
        ? [
            {
              code: "BUNDLE_DIAGNOSTICS",
              message: "Databricks CLI reported bundle diagnostics.",
              diagnostics,
            },
          ]
        : undefined;

    return {
      ok: true,
      data: parsed.data,
      ...(issues ? { issues } : {}),
      ...(targetOptions.length > 0 ? { targetOptions } : {}),
    };
  } catch (error: unknown) {
    const stdout = extractStdout(error);
    const stderr = extractStderr(error);
    const expectedProbeTargetFailure = isExpectedProbeTargetFailure(
      target,
      stderr,
    );

    if (expectedProbeTargetFailure) {
      console.debug("[validateBundle] probe target unavailable; parsing stdout", {
        cliPath,
        bundleDir: resolvedBundleDir,
        target,
      });
    } else {
      console.warn("[validateBundle] command exited non-zero", {
        cliPath,
        bundleDir: resolvedBundleDir,
        target,
        error: getErrorMessage(error),
        stdout,
        stderr,
      });
    }

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

    // Node stops the CLI at the output limit; what was read is cut off, so not JSON.
    if (hasErrorCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
      return {
        ok: false,
        error: {
          bundleDir: resolvedBundleDir,
          bundleName,
          error: `The Databricks CLI's output for this bundle is larger than ${MAX_CLI_OUTPUT_BYTES / 1024 / 1024} MB, so the inspector can't read it.`,
          errorCode: "VALIDATION_OUTPUT_TOO_LARGE",
          details: getErrorMessage(error),
        },
      };
    }

    // execFile stops the CLI at the time limit by killing it: the error then has
    // `killed`, not the ETIMEDOUT code. Nothing else kills it.
    if (hasErrorCode(error, "ETIMEDOUT") || wasKilled(error)) {
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
          const diagnostics = (
            await readDiagnostics(stderr ?? "", target ?? BUNDLE_PROBE_TARGET)
          ).map((diagnostic) => ({
            ...diagnostic,
            severity: "warning" as const,
          }));
          const targetOptions = parseAvailableTargets(stderr ?? "");
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
            ...(targetOptions.length > 0 ? { targetOptions } : {}),
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
          const diagnostics = await readDiagnostics(
            stderr ?? "",
            target ?? BUNDLE_PROBE_TARGET,
          );
          const targetOptions = parseAvailableTargets(stderr ?? "");
          const issues =
            diagnostics.length > 0
              ? [
                  {
                    code: "BUNDLE_DIAGNOSTICS",
                    message: "Databricks CLI reported bundle diagnostics.",
                    diagnostics,
                  },
                ]
              : expectedProbeTargetFailure
                ? undefined
              : [
                  {
                    code: "CLI_WARNING",
                    message:
                      "Databricks CLI validation completed with warnings.",
                    details: stderr?.trim() || getErrorMessage(error),
                  },
                ];
          return {
            ok: true,
            data: parsed.data,
            ...(issues ? { issues } : {}),
            ...(targetOptions.length > 0 ? { targetOptions } : {}),
          };
        }
      } catch {
        // stdout is not valid JSON, fall through to error
      }
    }

    const probeTarget = target ?? BUNDLE_PROBE_TARGET;
    const diagnostics = await readDiagnostics(stderr ?? "", probeTarget);
    const targetOptions = parseAvailableTargets(stderr ?? "");
    const filteredStderr = (stderr ?? "")
      .split("\n")
      .filter((line) => !line.includes(`${probeTarget}: no such target`))
      .join("\n")
      .trim();
    const fallbackDetails = expectedProbeTargetFailure
      ? undefined
      : getErrorMessage(error);
    const details =
      diagnostics.length > 0
        ? diagnostics
            .map(
              (d) =>
                `${d.severity}: ${d.message}${d.path ? ` in ${d.path}:${d.line ?? 0}:${d.column ?? 0}` : ""}`,
            )
            .join("\n")
        : filteredStderr || fallbackDetails;
    const bundleError: BundleError = {
      bundleDir: resolvedBundleDir,
      bundleName,
      error: "Failed to validate Databricks bundle.",
      errorCode: "VALIDATION_FAILED",
      ...(details ? { details } : {}),
    };
    if (diagnostics.length > 0) bundleError.diagnostics = diagnostics;
    return {
      ok: false,
      error: bundleError,
      ...(targetOptions.length > 0 ? { targetOptions } : {}),
    };
  }
}
