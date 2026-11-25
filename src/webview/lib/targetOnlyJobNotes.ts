import type { TargetOnlyJob } from "../../bundle/targetOnlyJobs.js";
import type { TaskIssue } from "./taskIssues.js";

/** The panel's note for each job: `Job "nightly" is only in target "prod": pick prod to check it.` */
export function targetOnlyJobNotes(jobs: readonly TargetOnlyJob[] | undefined): TaskIssue[] {
  return (jobs ?? []).map(({ jobKey, targets, location }) => {
    const named = targets.map((target) => `"${target}"`);
    const listed = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
    const title =
      targets.length === 1
        ? `Job "${jobKey}" is only in target ${listed}: pick ${targets[0]} to check it.`
        : `Job "${jobKey}" is only in targets ${listed}: pick one to check it.`;
    return {
      id: `target-only-job:${jobKey}`,
      kind: "job_only_in_target",
      severity: "info",
      title,
      ...(location ? { file: location.file, line: location.line, column: location.column } : {}),
    };
  });
}
