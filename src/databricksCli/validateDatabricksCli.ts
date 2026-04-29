import { runVersionCommand } from "./processRunner.js";
import {
  isDatabricksCliVersionOutput,
  extractDatabricksVersion,
} from "./parsing.js";

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
    };

const AUTO_DETECT_CACHE_KEY = "__auto_detect__";
const resolveCliPromises = new Map<
  string,
  Promise<DatabricksCliVerificationResult | undefined>
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
 * Automatically detects the Databricks CLI on the current host machine.
 * Requires `databricks` to be on the system PATH.
 * @returns A verified Databricks CLI executable name or path, or `undefined` if none could be found.
 */
export async function autoDetectDatabricksCli(): Promise<
  DatabricksCliVerificationResult | undefined
> {
  const result = await verifyCliPath("databricks");
  if (result.ok) {
    console.log(
      `[DatabricksBundleInspector] auto-detected Databricks CLI: databricks`,
    );
    return result;
  }

  console.warn(
    "[DatabricksBundleInspector] could not auto-detect Databricks CLI — ensure 'databricks' is on your PATH",
  );
  return undefined;
}

/**
 * Resolves the Databricks CLI path for the current host machine.
 *
 * The resolution order is:
 * 1. Use the user-configured `cliPath` from VS Code settings, if present.
 * 2. Verify that configured path by running the CLI with `--version`.
 * 3. If the configured path is missing or invalid, fall back to auto-detection.
 *
 * @param config The VS Code workspace configuration for the extension.
 * @returns A verification result for a working Databricks CLI candidate, or `undefined` if none could be found.
 */
export async function resolveDatabricksCli(
  configuredPath?: string,
): Promise<DatabricksCliVerificationResult | undefined> {
  const cacheKey = cliCacheKey(configuredPath);
  let resolveCliPromise = resolveCliPromises.get(cacheKey);

  if (!resolveCliPromise) {
    resolveCliPromise = resolveCliInternal(configuredPath).then(
      (result) => {
        if (!result) {
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
  configuredPath?: string,
): Promise<DatabricksCliVerificationResult | undefined> {
  if (configuredPath) {
    const result = await verifyCliPath(configuredPath);
    if (result.ok) {
      return result;
    }
    console.warn(
      `[DatabricksBundleInspector] configured cliPath is invalid: ${configuredPath}. Reason: ${result.reason ?? "unknown"}`,
    );
  }
  return autoDetectDatabricksCli();
}
