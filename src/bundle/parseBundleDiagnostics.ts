export interface BundleDiagnostic {
  severity: "warning" | "error";
  message: string;
  path?: string;
  line?: number;
  column?: number;
  /** Bundle config path the diagnostic applies to, e.g. `resources.jobs.my_job`. */
  yamlPath?: string;
}

const YAML_PATH_RE = /^\s+at (\S+)$/;
const LOCATION_RE = /^\s+in (.+):(\d+):(\d+)$/;
const AVAILABLE_TARGETS_RE = /Available targets:\s*(.+)$/i;

export function parseAvailableTargets(stderr: string): string[] {
  const targets = new Set<string>();

  for (const line of stderr.split("\n")) {
    const match = AVAILABLE_TARGETS_RE.exec(line);
    if (!match?.[1]) continue;

    for (const target of match[1].split(",")) {
      const normalized = target.trim();
      if (normalized) targets.add(normalized);
    }
  }

  return [...targets];
}

/**
 * Parses the stderr output of `databricks bundle validate` into structured
 * diagnostics, filtering out the expected probe-target error.
 *
 * Each diagnostic is a message line followed by indented detail lines:
 *   Warning: unknown field: bogus_field
 *     at resources.jobs.my_job
 *     in resources/jobs.yml:5:7
 *        resources/other.yml:4:7
 *
 * The `at` line is only present for diagnostics scoped to a config path.
 * When several locations are listed, the first one is used.
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

    // Consume the indented detail block that belongs to this diagnostic.
    while (/^\s+\S/.test(lines[i + 1] ?? "")) {
      const detail = lines[++i] ?? "";
      const yamlPathMatch = YAML_PATH_RE.exec(detail);
      if (yamlPathMatch?.[1] !== undefined && diagnostic.yamlPath === undefined) {
        diagnostic.yamlPath = yamlPathMatch[1];
        continue;
      }
      const locationMatch = LOCATION_RE.exec(detail);
      if (locationMatch?.[1] !== undefined && diagnostic.path === undefined) {
        diagnostic.path = locationMatch[1];
        diagnostic.line = parseInt(locationMatch[2] ?? "0", 10);
        diagnostic.column = parseInt(locationMatch[3] ?? "0", 10);
      }
    }

    diagnostics.push(diagnostic);
  }

  return diagnostics;
}
