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

/** The oldest Databricks CLI the inspector is tested with (see .github/workflows/cli-compat.yml). */
export const MIN_SUPPORTED_CLI_VERSION = "v0.299.0";

function versionParts(version: string): number[] | undefined {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/**
 * Whether a Databricks CLI version is older than {@link MIN_SUPPORTED_CLI_VERSION}.
 *
 * @param version A version such as `v0.250.0`, as returned by {@link extractDatabricksVersion}.
 * @returns `false` when the version is missing or can't be read, so nothing is claimed.
 */
export function isOlderThanSupported(version: string | undefined): boolean {
  const parts = version ? versionParts(version) : undefined;
  const minimum = versionParts(MIN_SUPPORTED_CLI_VERSION)!;
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== minimum[i]!) return parts[i]! < minimum[i]!;
  }
  return false;
}
