import { runVersionCommand } from "./processRunner.js";
import {
  isDatabricksCliVersionOutput,
  extractDatabricksVersion,
} from "./parsing.js";
import {
  cliOnPath,
  moreCliCandidates,
  realLookupEnvironment,
  type CliLookupEnvironment,
} from "./cliCandidates.js";

/**
 * Result of verifying whether a candidate executable is the Databricks CLI.
 */
export type DatabricksCliVerificationResult =
  | {
      /** The candidate was successfully identified as Databricks CLI. */
      ok: true;
      /** The executable path or command name that was checked. */
      candidate: string;
      /** Parsed version string, if detected from version output. */
      versionOutput: string | undefined;
    }
  | {
      /** The candidate did not verify as Databricks CLI. */
      ok: false;
      /** The executable path or command name that was checked. */
      candidate: string;
      /** Optional explanation for the failed verification. */
      reason?: string;
      /** Set when the candidate ran but is some other program, e.g. the legacy pip `databricks-cli`: what it printed. */
      otherProgramOutput?: string;
    };

/** A candidate verified as the Databricks CLI. */
export type VerifiedDatabricksCli = Extract<DatabricksCliVerificationResult, { ok: true }>;

/** Why no Databricks CLI could be used. Also sent as the `cli_problem` telemetry value. */
export type CliProblem =
  | "not_installed"
  | "configured_path_invalid"
  | "not_databricks_cli";

/** Returned by {@link resolveDatabricksCli} when no working Databricks CLI was found. */
export interface CliResolutionFailure {
  ok: false;
  problem: CliProblem;
  /** The configured `cliPath`, when that is what failed. */
  configuredPath?: string;
  /** What the non-Databricks `databricks` command printed for `--version`. */
  versionOutput?: string;
}

const INSTALL_DOCS = "https://docs.databricks.com/aws/en/dev-tools/cli/install";

/** The install docs, opened at the section for this OS. WSL and SSH remotes report `linux`, which is where the CLI must go. */
export function databricksCliInstallUrl(platform: NodeJS.Platform): string {
  if (platform === "darwin") return `${INSTALL_DOCS}#homebrew-installation-for-macos`;
  if (platform === "win32") return `${INSTALL_DOCS}#winget-installation-for-windows`;
  if (platform === "linux") return `${INSTALL_DOCS}#curl-installation-for-linux-macos-and-windows`;
  return INSTALL_DOCS;
}

/** The update docs, opened at the section for this OS. */
export function databricksCliUpdateUrl(platform: NodeJS.Platform): string {
  if (platform === "darwin") return `${INSTALL_DOCS}#homebrew-update-for-linux-or-macos`;
  if (platform === "win32") return `${INSTALL_DOCS}#winget-update-for-windows`;
  if (platform === "linux") return `${INSTALL_DOCS}#curl-update-for-linux-macos-and-windows`;
  return INSTALL_DOCS;
}

const AUTO_DETECT_CACHE_KEY = "__auto_detect__";
const resolveCliPromises = new Map<
  string,
  Promise<VerifiedDatabricksCli | CliResolutionFailure>
>();

function cliCacheKey(configuredPath?: string): string {
  const trimmedPath = configuredPath?.trim();
  return trimmedPath ? trimmedPath : AUTO_DETECT_CACHE_KEY;
}

export function invalidateDatabricksCliCache(configuredPath?: string): void {
  if (configuredPath === undefined) {
    resolveCliPromises.clear();
    return;
  }

  resolveCliPromises.delete(cliCacheKey(configuredPath));
}

/**
 * Verifies that the candidate executable is the Databricks CLI.
 *
 * @param candidate path or executable name to verify
 * @returns A verification result describing whether the candidate appears to be the Databricks CLI.
 */
export async function verifyCliPath(
  candidate: string,
): Promise<DatabricksCliVerificationResult> {
  try {
    const { stdout, stderr } = await runVersionCommand(candidate);

    const output = `${stdout}\n${stderr}`.trim();
    const isDatabricksCli = isDatabricksCliVersionOutput(output);

    if (!isDatabricksCli) {
      console.warn(
        `[DatabricksBundleInspector] candidate responded to --version but does not appear to be Databricks CLI: ${candidate} (${output})`,
      );

      return {
        ok: false,
        candidate,
        reason: `Candidate responded to --version but did not identify itself as Databricks CLI: ${output}`,
        otherProgramOutput: output,
      };
    }

    console.log(
      `[DatabricksBundleInspector] verified CLI path: ${candidate} (${output})`,
    );

    const databricksVersion = extractDatabricksVersion(stdout);

    return {
      ok: true,
      candidate,
      versionOutput: databricksVersion,
    };
  } catch (error) {
    console.warn(
      `[DatabricksBundleInspector] failed to verify CLI path: ${candidate}`,
      error,
    );
    return {
      ok: false,
      candidate,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Automatically detects the Databricks CLI on the current host machine: the `databricks`
 * that running it by name would start, kept as its full path so that every later run starts
 * that same file, whatever folder it runs in (#459).
 * @returns The verification result for that file, or a failure when PATH has none.
 */
export async function autoDetectDatabricksCli(
  lookup: CliLookupEnvironment = realLookupEnvironment(),
): Promise<DatabricksCliVerificationResult> {
  const file = cliOnPath(lookup);
  if (!file) {
    console.warn("[DatabricksBundleInspector] no databricks file found on the PATH");
    return { ok: false, candidate: "databricks", reason: "No databricks file on the PATH." };
  }
  const result = await verifyCliPath(file);
  if (result.ok) {
    console.log(
      `[DatabricksBundleInspector] auto-detected Databricks CLI: ${file}`,
    );
    return result;
  }

  console.warn(
    "[DatabricksBundleInspector] could not auto-detect Databricks CLI — ensure 'databricks' is on your PATH",
  );
  return result;
}

/**
 * Resolves the Databricks CLI path for the current host machine.
 *
 * The resolution order is:
 * 1. Use the user-configured `cliPath` from VS Code settings, if present.
 * 2. Verify that configured path by running the CLI with `--version`.
 * 3. If the configured path is missing or invalid, fall back to auto-detection.
 * 4. If that fails too, try the other places a CLI may be (see {@link moreCliCandidates}).
 *
 * @param config The VS Code workspace configuration for the extension.
 * @returns A verified Databricks CLI, or a {@link CliResolutionFailure} saying why none could be used.
 */
export async function resolveDatabricksCli(
  configuredPath?: string,
  lookup: CliLookupEnvironment = realLookupEnvironment(),
): Promise<VerifiedDatabricksCli | CliResolutionFailure> {
  const cacheKey = cliCacheKey(configuredPath);
  let resolveCliPromise = resolveCliPromises.get(cacheKey);

  if (!resolveCliPromise) {
    resolveCliPromise = resolveCliInternal(configuredPath, lookup).then(
      (result) => {
        if (!result.ok) {
          resolveCliPromises.delete(cacheKey);
        }
        return result;
      },
      (error: unknown) => {
        resolveCliPromises.delete(cacheKey);
        throw error;
      },
    );
    resolveCliPromises.set(cacheKey, resolveCliPromise);
  }

  return resolveCliPromise;
}

async function resolveCliInternal(
  configuredPath: string | undefined,
  lookup: CliLookupEnvironment,
): Promise<VerifiedDatabricksCli | CliResolutionFailure> {
  let configuredPathFailed = false;
  if (configuredPath) {
    const result = await verifyCliPath(configuredPath);
    if (result.ok) {
      return result;
    }
    configuredPathFailed = true;
    console.warn(
      `[DatabricksBundleInspector] configured cliPath is invalid: ${configuredPath}. Reason: ${result.reason ?? "unknown"}`,
    );
  }
  const detected = await autoDetectDatabricksCli(lookup);
  if (detected.ok) {
    return detected;
  }
  // Only reached when the lookup above failed, so nothing changes where it works.
  const tried = lookup.platform === "win32" ? detected.candidate.toLowerCase() : detected.candidate;
  for (const candidate of await moreCliCandidates(lookup)) {
    if ((lookup.platform === "win32" ? candidate.toLowerCase() : candidate) === tried) continue;
    const result = await verifyCliPath(candidate);
    if (result.ok) {
      return result;
    }
  }
  // A wrong setting is the likelier fix than whatever sits on the PATH, so report it first.
  if (configuredPath && configuredPathFailed) {
    return { ok: false, problem: "configured_path_invalid", configuredPath };
  }
  if (detected.otherProgramOutput !== undefined) {
    return { ok: false, problem: "not_databricks_cli", versionOutput: detected.otherProgramOutput };
  }
  return { ok: false, problem: "not_installed" };
}
