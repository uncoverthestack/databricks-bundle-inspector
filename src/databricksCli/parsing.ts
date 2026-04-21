/**
 * Extracts the Databricks CLI semantic version from command output.
 *
 * Expects output that may contain a version string such as `v0.295.0`.
 *
 * @param stdout Standard output produced by the Databricks CLI version command.
 * @returns The matched version string if found, otherwise `undefined`.
 */
export function extractDatabricksVersion(stdout: string): string | undefined {
  const match = stdout.match(/v\d+\.\d+\.\d+/);
  return match ? match[0] : undefined;
}

/**
 * Checks whether version command output appears to come from the Databricks CLI.
 *
 * @param output Combined command output to inspect, usually stdout or stdout plus stderr.
 * @returns `true` if the output contains `Databricks CLI`; otherwise `false`.
 */
export function isDatabricksCliVersionOutput(output: string): boolean {
  return output.includes("Databricks CLI");
}
