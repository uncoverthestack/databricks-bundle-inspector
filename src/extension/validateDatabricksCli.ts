import * as vscode from "vscode";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

/**
 * Result of verifying whether a candidate executable is the Databricks CLI.
 */
type DatabricksCliVerificationResult =
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

let cacheDatabricksCliResult: DatabricksCliVerificationResult | undefined;

/**
 * Gets the VS Code workspace configuration section for the `databricksBundleInspector` extension
 *
 * @returns The `databricksBundleInspector` from the VS Code workspace configuration
 */
function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("databricksBundleInspector");
}

/**
 * Gets the user-configured Databricks CLI path from extension settings.
 *
 * @param config The workspace configuration section for the extension.
 * @returns The configured CLI path, or `undefined` if not set.
 */
function getConfiguredDatabricksCliPath(
  config: vscode.WorkspaceConfiguration,
): string | undefined {
  return config.get<string>("cliPath");
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
    const { stdout, stderr } = await execFileAsync(candidate, ["--version"], {
      timeout: 10_000,
    });

    const output = `${stdout}\n${stderr}`.trim();
    const isDatabricksCli = output.includes("Databricks CLI");

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

    const databricksVersionMatch = stdout.match(/v\d+\.\d+\.\d+/);
    const databricksVersion = databricksVersionMatch
      ? databricksVersionMatch[0]
      : undefined;

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
 * @returns A verified Databricks CLI executable name or path, or `undefined` if none could be found.
 */
export async function autoDetectDatabricksCli(): Promise<
  DatabricksCliVerificationResult | undefined
> {
  const candidates = ["databricks"];

  for (const candidate of candidates) {
    const result = await verifyCliPath(candidate);
    if (result.ok) {
      console.log(
        `[DatabricksBundleInspector] auto-detected Databricks CLI: ${candidate}`,
      );
      return result;
    }
  }

  console.warn(
    "[DatabricksBundleInspector] could not auto-detect Databricks CLI",
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
  config: vscode.WorkspaceConfiguration = getConfiguration(),
): Promise<DatabricksCliVerificationResult | undefined> {
  if (cacheDatabricksCliResult?.ok) {
    return cacheDatabricksCliResult;
  }
  const configuredPath = getConfiguredDatabricksCliPath(config);

  if (configuredPath) {
    const result = await verifyCliPath(configuredPath);
    if (result.ok) {
      cacheDatabricksCliResult = result;
      return result;
    }

    console.warn(
      `[DatabricksBundleInspector] configured cliPath is invalid: ${configuredPath}. Reason: ${result.reason ?? "unknown"}`,
    );
  }

  return await autoDetectDatabricksCli();
}
