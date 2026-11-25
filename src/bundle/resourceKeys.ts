import type { SourceFile } from "./jobStructure.js";
import type { YamlLocation } from "./sourceLocations.js";
import { keyLocator } from "./targetChecks.js";

/**
 * A resource key with a dot in it (#511). `bundle validate` accepts it, and deploy fails on
 * every CLI from v0.299.2 to v1.28.0, for jobs, pipelines and schemas alike (live,
 * 2026-11-25): the Terraform engine with "Invalid resource name", the direct engine with
 * a crash. Nothing in the bundle deploys, not even the resources next to it.
 * The CLI reports it with no target either, so it is checked in both.
 */
export interface ResourceKeyFinding {
  group: string;
  key: string;
  title: string;
  fixHint: string;
  location?: YamlLocation;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function findResourceKeyProblems(cliOutput: unknown, files: SourceFile[]): ResourceKeyFinding[] {
  const bundle = record(cliOutput);
  const locate = keyLocator(files);
  const targets = Object.keys(record(bundle.targets));
  // A real target's output has no targets; the YAML files still say where each one is written.
  const writtenTargets = [...new Set([...targets, ...files.flatMap((file) => Object.keys(record(record(file.doc).targets)))])];
  const findings: ResourceKeyFinding[] = [];
  // The structural preview keeps a target's own resources under the target; a real
  // target's output has them merged into `resources`.
  const seen = new Set<string>();
  const keys = [bundle.resources, ...targets.map((target) => record(record(bundle.targets)[target]).resources)].flatMap(
    (resources) => Object.entries(record(resources)).flatMap(([group, entries]) => Object.keys(record(entries)).map((key) => [group, key] as const)),
  );
  for (const [group, key] of keys) {
    const id = `${group}.${key}`;
    if (!key.includes(".") || seen.has(id)) continue;
    seen.add(id);
    // Written in the bundle's resources, or only in a target's.
    const location =
      locate(["resources", group, key]) ??
      writtenTargets.map((target) => locate(["targets", target, "resources", group, key])).find(Boolean);
    findings.push({
      group,
      key,
      title: `The resource key "${key}" has a dot, which deploy doesn't accept, so deploy may fail.`,
      fixHint: `Use letters, digits, _ or - in the key, for example "${key.replace(/\./g, "_")}", and update any \${resources.${group}.${key}...} references. Deploy stops before it creates anything, with "Invalid resource name" or a Databricks CLI crash.`,
      ...(location ? { location } : {}),
    });
  }
  return findings;
}
