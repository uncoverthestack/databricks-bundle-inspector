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
  const line = firstLine(message);
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH - 1).trimEnd()}…` : line;
}

/**
 * The first line of a CLI message, without its "Error: " or "error: " prefix (the CLI's
 * own, or the severity the inspector puts in front).
 */
export function firstLine(message: string): string {
  const line = message.split("\n").find((part) => part.trim()) ?? "";
  return line.trim().replace(/^error:\s*/i, "");
}
