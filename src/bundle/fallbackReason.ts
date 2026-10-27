/** What a failed real-target check left for the graph's note. */
export interface TargetFallback {
  /** The CLI's whole message, shown on hover and read for the profile choice. */
  message: string;
  /** A short reason for the note, such as "you're not logged in to Databricks". */
  reason: string;
}

/** The longest CLI line the note shows when no shorter reason is known. */
const MAX_REASON_LENGTH = 100;

/**
 * Why a real target fell back to the structural preview, from its failed check. Known CLI
 * errors get a short plain reason; anything else shows the CLI's first line, cut short.
 */
export function targetFallback(error: { error: string; errorCode?: string; details?: string }): TargetFallback {
  // A timeout's details are Node's "Command failed: ..." text, which says nothing useful.
  const message = error.errorCode === "VALIDATION_TIMEOUT" ? error.error : error.details ?? error.error;
  return { message, reason: shortReason(error.errorCode, message) };
}

function shortReason(errorCode: string | undefined, message: string): string {
  if (errorCode === "VALIDATION_TIMEOUT") {
    const seconds = /after (\d+) seconds/.exec(message)?.[1];
    return seconds ? `the workspace didn't answer within ${seconds} seconds` : "the workspace didn't answer";
  }
  if (errorCode === "AUTH_NOT_CONFIGURED") return "you're not logged in to Databricks";
  const missingProfile = /has no (\S+) profile configured/.exec(message);
  if (missingProfile) return `there's no login profile named "${missingProfile[1]}"`;
  if (/multiple profiles matched/.test(message)) return "several login profiles match this workspace";
  if (/host in the profile .* match the host configured in the bundle/.test(message)) {
    return "the login profile is for a different workspace";
  }
  if (/: no such target\b/.test(message)) return "the bundle has no such target";
  const login = loginReason(message);
  if (login) return login;
  const line = firstLine(message);
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…` : line;
}

/**
 * A saved Databricks login the CLI couldn't use, as the Go SDK words it (checked in
 * databricks-sdk-go 0.128.0 and 0.188.0, used by CLI 0.299.0 and 1.21.0):
 *
 * - `error getting token: ...` wraps every OAuth login failure.
 * - `token refresh: Post "https://.../oidc/v1/token": ...` means the login had expired
 *   and the request to renew it got no answer: no network, a VPN, a proxy or a firewall.
 *   When Databricks answers and turns the renewal down, the SDK says why instead
 *   ("Refresh token is invalid", "(error code: invalid_grant)").
 * - `no cached credentials` (CLI 1.x): no saved login for that workspace at all.
 */
function loginReason(message: string): string | undefined {
  if (!/error getting token:/.test(message)) return undefined;
  if (/token refresh: Post "/.test(message)) {
    return "your Databricks login needed renewing, but Databricks couldn't be reached (check your network, VPN or proxy)";
  }
  if (/no cached credentials/.test(message)) {
    return 'you\'re not logged in to this workspace. Run "databricks auth login" to log in';
  }
  if (/Refresh token is invalid|invalid_grant|cached token has no refresh token/.test(message)) {
    return 'your Databricks login has expired. Run "databricks auth login" to log in again';
  }
  return "your Databricks login couldn't be used";
}

/**
 * The first line of a CLI message, without its "Error: " or "error: " prefix (the CLI's
 * own, or the severity the inspector puts in front).
 */
export function firstLine(message: string): string {
  const line = message.split("\n").find((part) => part.trim()) ?? "";
  return line.trim().replace(/^error:\s*/i, "");
}
