import type { SourceFile } from "./jobStructure.js";
import type { YamlLocation } from "./sourceLocations.js";
import { keyLocator } from "./targetChecks.js";

/**
 * A job written only under a target. With no target picked, the structural preview leaves it
 * out of `resources`, so it isn't in the graph and none of the job checks run on it. Picking
 * the target checks it. The panel's Issues list says so; nothing else does.
 */
export interface TargetOnlyJob {
  jobKey: string;
  /** Every target that writes the job, in the order the bundle lists them. */
  targets: string[];
  /** Where the first of those targets writes the job's key. */
  location?: YamlLocation;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A picked target's output has no `targets`, so this finds nothing then. */
export function findTargetOnlyJobs(cliOutput: unknown, files: SourceFile[]): TargetOnlyJob[] {
  const bundle = record(cliOutput);
  const ownJobs = record(record(bundle.resources).jobs);
  const byJob = new Map<string, string[]>();
  for (const [target, settings] of Object.entries(record(bundle.targets))) {
    for (const jobKey of Object.keys(record(record(record(settings).resources).jobs))) {
      if (Object.hasOwn(ownJobs, jobKey)) continue;
      byJob.set(jobKey, [...(byJob.get(jobKey) ?? []), target]);
    }
  }
  const locate = keyLocator(files);
  return [...byJob].map(([jobKey, targets]) => {
    const location = locate(["targets", targets[0]!, "resources", "jobs", jobKey]);
    return { jobKey, targets, ...(location ? { location } : {}) };
  });
}
