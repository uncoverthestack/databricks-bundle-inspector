import type { SourceFile } from "./jobStructure.js";
import type { YamlLocation } from "./sourceLocations.js";
import { keyLocator } from "./targetChecks.js";

/**
 * A resource key with a dot in it (#511). `bundle validate` accepts it, and deploy fails on
 * every CLI from v0.299.2 to v1.28.0, for jobs, pipelines and schemas alike (live,
 * 2026-11-25): the Terraform engine with "Invalid resource name", the direct engine with
 * a crash. Nothing in the bundle deploys, not even the resources next to it. On a bundle
 * deployed before, the direct engine uploads the files first, so an existing job ran the new
 * code with its old settings (live, CLI v1.28.0, 2026-11-27, #577).
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
  // The target being inspected comes first, so a key in several targets points at its own line.
  const selected = record(bundle.bundle).target;
  const writtenTargets = [
    ...new Set([
      ...(typeof selected === "string" ? [selected] : []),
      ...targets,
      ...files.flatMap((file) => Object.keys(record(record(file.doc).targets))),
    ]),
  ];
  const findings: ResourceKeyFinding[] = [];
  // The structural preview keeps a target's own resources under the target; a real
  // target's output has them merged into `resources`.
  const seen = new Set<string>();
  const keys = [bundle.resources, ...targets.map((target) => record(record(bundle.targets)[target]).resources)].flatMap(
    (resources) => Object.entries(record(resources)).flatMap(([group, entries]) => Object.keys(record(entries)).map((key) => [group, key] as const)),
  );
  // A key must be unique across every resource type and script (the CLI's unique_resource_keys),
  // so a suggested name skips the keys the bundle has and the names already suggested.
  const taken = new Set([
    ...keys.map(([, key]) => key),
    ...files.flatMap((file) => Object.keys(record(record(file.doc).scripts))),
    ...Object.keys(record(bundle.scripts)),
  ]);
  const suggest = (key: string) => {
    const base = key.replace(/\./g, "_");
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    return name;
  };
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
      fixHint: `Rename it to "${suggest(key)}" and update any \${resources.${group}.${key}...} references. Otherwise deploy crashes, and jobs deployed before may run the new code with their old settings.`,
      ...(location ? { location } : {}),
    });
  }
  return findings;
}
