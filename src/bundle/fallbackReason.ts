/** Why a real target fell back, as a fixed word telemetry can count. Never the message. */
export type FallbackCode =
  | "timeout"
  | "not_logged_in"
  | "no_profile"
  | "several_profiles"
  | "other_workspace"
  | "no_such_target"
  | "login_unreachable"
  | "login_expired"
  | "login_other"
  | "other";

/** The reasons signing in can fix, so the graph offers the sign-in terminal for them. */
export const SIGN_IN_CODES: ReadonlySet<FallbackCode> = new Set(["not_logged_in", "login_expired", "no_profile"]);

/** What a failed real-target check left for the graph's note. */
export interface TargetFallback {
  /** The CLI's whole message, shown on hover and read for the profile choice. */
  message: string;
  /** A short reason for the note, such as "you're not signed in to Databricks". */
  reason: string;
  code: FallbackCode;
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
  return { message, ...shortReason(error.errorCode, message) };
}

type Reason = Pick<TargetFallback, "reason" | "code">;

function shortReason(errorCode: string | undefined, message: string): Reason {
  if (errorCode === "VALIDATION_TIMEOUT") {
    const seconds = /after (\d+) seconds/.exec(message)?.[1];
    const reason = seconds ? `the workspace didn't answer within ${seconds} seconds` : "the workspace didn't answer";
    return { reason, code: "timeout" };
  }
  if (errorCode === "AUTH_NOT_CONFIGURED") return { reason: "you're not signed in to Databricks", code: "not_logged_in" };
  const missingProfile = /has no (\S+) profile configured/.exec(message);
  if (missingProfile) return { reason: `there's no sign-in profile named "${missingProfile[1]}"`, code: "no_profile" };
  if (/multiple profiles matched/.test(message)) {
    return { reason: "several sign-in profiles match this workspace", code: "several_profiles" };
  }
  if (/host in the profile .* match the host configured in the bundle/.test(message)) {
    return { reason: "the sign-in profile is for a different workspace", code: "other_workspace" };
  }
  if (/: no such target\b/.test(message)) return { reason: "the bundle has no such target", code: "no_such_target" };
  const login = loginReason(message);
  if (login) return login;
  const line = firstLine(message);
  const reason = line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…` : line;
  return { reason, code: "other" };
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
 * - `no cached credentials` (CLI 1.x) and `cache: token not found` (CLI 0.299.0): no
 *   saved sign-in for that workspace at all.
 */
function loginReason(message: string): Reason | undefined {
  if (!/error getting token:/.test(message)) return undefined;
  if (/token refresh: Post "/.test(message)) {
    return {
      reason: "your Databricks sign-in needed renewing, but Databricks couldn't be reached (check your network, VPN or proxy)",
      code: "login_unreachable",
    };
  }
  if (/no cached credentials|cache: token not found/.test(message)) {
    return { reason: "you're not signed in to this workspace", code: "not_logged_in" };
  }
  if (/Refresh token is invalid|invalid_grant|cached token has no refresh token/.test(message)) {
    return { reason: "your Databricks sign-in has expired", code: "login_expired" };
  }
  return { reason: "your Databricks sign-in couldn't be used", code: "login_other" };
}

/**
 * The first line of a CLI message, without its "Error: " or "error: " prefix (the CLI's
 * own, or the severity the inspector puts in front).
 */
export function firstLine(message: string): string {
  const line = message.split("\n").find((part) => part.trim()) ?? "";
  return line.trim().replace(/^error:\s*/i, "");
}
