export interface BundleDiagnostic {
  severity: "warning" | "error";
  message: string;
  path?: string;
  line?: number;
  column?: number;
}

const LOCATION_RE = /^\s+in (.+):(\d+):(\d+)$/;

/**
 * Parses the stderr output of `databricks bundle validate` into structured
 * diagnostics, filtering out the expected probe-target error.
 *
 * Each diagnostic in stderr looks like:
 *   Warning: unknown field: includ
 *     in databricks.yml:4:1
 *
 * The probe target produces a "no such target" error that is not a real
 * bundle problem and is always filtered out.
 *
 * @param stderr The full stderr string from `databricks bundle validate`.
 * @param probeTarget The synthetic target name used to trigger validate without auth
 *   (e.g. `"__bundle_inspector_probe__"`). Lines referencing this target are filtered out.
 * @returns Structured diagnostics with severity, message, and optional file location.
 */
export function parseBundleDiagnostics(
  stderr: string,
  probeTarget: string,
): BundleDiagnostic[] {
  const lines = stderr.split("\n");
  const diagnostics: BundleDiagnostic[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    let severity: "warning" | "error" | undefined;
    let message: string | undefined;

    if (trimmed.startsWith("Warning: ")) {
      severity = "warning";
      message = trimmed.slice("Warning: ".length);
    } else if (trimmed.startsWith("Error: ")) {
      severity = "error";
      message = trimmed.slice("Error: ".length);
    } else {
      continue;
    }

    if (severity === "error" && message.includes(`${probeTarget}: no such target`)) {
      continue;
    }

    const diagnostic: BundleDiagnostic = { severity, message };

    const nextLine = lines[i + 1] ?? "";
    const locationMatch = LOCATION_RE.exec(nextLine);
    if (locationMatch?.[1] !== undefined) {
      diagnostic.path = locationMatch[1];
      diagnostic.line = parseInt(locationMatch[2] ?? "0", 10);
      diagnostic.column = parseInt(locationMatch[3] ?? "0", 10);
      i++;
    }

    diagnostics.push(diagnostic);
  }

  return diagnostics;
}
