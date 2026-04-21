import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs the given CLI candidate with the `--version` flag.
 *
 * This is used to verify that the candidate is a valid Databricks CLI
 * executable and to capture its version output.
 *
 * @param candidate Executable name or absolute path to the CLI binary.
 * @param timeout Maximum time to wait for the command to complete, in milliseconds. Defaults to `5000`.
 * @returns A promise resolving to the command's standard output and standard error.
 * @throws If the command cannot be executed, exits with an error, or exceeds the timeout.
 */
export async function runVersionCommand(
  candidate: string,
  timeout: number = 5_000,
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return execFileAsync(candidate, ["--version"], { timeout });
}
