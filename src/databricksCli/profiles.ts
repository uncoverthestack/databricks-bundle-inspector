import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A profile from `~/.databrickscfg`, as `databricks auth profiles` lists it. */
export interface DatabricksProfile {
  name: string;
  host?: string;
  authType?: string;
}

/**
 * When several profiles in `~/.databrickscfg` point at a target's workspace, the CLI
 * refuses to choose (CLI 0.299.0 and 1.21.0):
 * `resolve: https://host: multiple profiles matched: DEFAULT, Community: please set ...`.
 * Returns the workspace and the profile names the CLI listed, or undefined.
 */
export function parseAmbiguousProfiles(
  message: string,
): { host: string; names: string[] } | undefined {
  const match = /resolve: (\S+?): multiple profiles matched: (.+?): please set/.exec(message);
  if (!match) return undefined;
  return { host: match[1]!, names: match[2]!.split(", ").filter(Boolean) };
}

/** The profiles in `databricks auth profiles --skip-validate -o json` output. */
export function parseProfileList(json: string): DatabricksProfile[] {
  try {
    const parsed = JSON.parse(json) as { profiles?: unknown };
    if (!Array.isArray(parsed.profiles)) return [];
    return parsed.profiles.flatMap((p: Record<string, unknown>) =>
      typeof p?.name === "string"
        ? [{
            name: p.name,
            ...(typeof p.host === "string" ? { host: p.host } : {}),
            ...(typeof p.auth_type === "string" ? { authType: p.auth_type } : {}),
          }]
        : [],
    );
  } catch {
    return [];
  }
}

const normalizeHost = (host: string) => host.trim().replace(/\/+$/, "").toLowerCase();

/** The profiles that point at `host`. */
export function profilesForHost(profiles: DatabricksProfile[], host: string): DatabricksProfile[] {
  return profiles.filter((p) => p.host !== undefined && normalizeHost(p.host) === normalizeHost(host));
}

/**
 * Lists the profiles in `~/.databrickscfg` (or `DATABRICKS_CONFIG_FILE`). With
 * `--skip-validate` the CLI reads the file only and contacts no workspace.
 */
export async function listProfiles(cliPath: string): Promise<DatabricksProfile[]> {
  try {
    const { stdout } = await execFileAsync(
      cliPath,
      ["auth", "profiles", "--skip-validate", "--output", "json"],
      { timeout: 10_000 },
    );
    return parseProfileList(stdout);
  } catch {
    return [];
  }
}
