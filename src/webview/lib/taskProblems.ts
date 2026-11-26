/**
 * What a task box on the job graph says about its problems: how many, and the colour of
 * its border. Read from the inspector's problem list, the same one Issues and the Problems
 * panel use, so the boxes always add up to the Issues count (issue 393).
 */

export interface TaskProblemIssue {
  taskId?: string | undefined;
  severity: "error" | "warning" | "info";
}

export interface TaskProblemCounts {
  errors: number;
  warnings: number;
  infos: number;
  total: number;
}

/** Red for an error, amber for warnings only, none otherwise (the UI colour rules). */
export type TaskProblemTone = "error" | "warning" | "none";

const NONE: TaskProblemCounts = { errors: 0, warnings: 0, infos: 0, total: 0 };

/** Each task's problems, by task id. A for-each task's inner task counts as the task. */
export function taskProblemCounts(issues: readonly TaskProblemIssue[]): Map<string, TaskProblemCounts> {
  const counts = new Map<string, TaskProblemCounts>();
  for (const issue of issues) {
    if (!issue.taskId) continue;
    const current = counts.get(issue.taskId) ?? { ...NONE };
    if (issue.severity === "error") current.errors++;
    else if (issue.severity === "warning") current.warnings++;
    else current.infos++;
    current.total++;
    counts.set(issue.taskId, current);
  }
  return counts;
}

export function countsFor(counts: Map<string, TaskProblemCounts>, taskId: string): TaskProblemCounts {
  return counts.get(taskId) ?? NONE;
}

/** A box's problems in words, worst first: "1 error, 2 warnings" (issue 555). */
export function problemWords(counts: { errors: number; warnings: number; infos?: number | undefined }): string {
  const part = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : "");
  return [part(counts.errors, "error"), part(counts.warnings, "warning"), part(counts.infos ?? 0, "note")].filter(Boolean).join(", ");
}

export function problemTone(counts: { errors: number; warnings: number; infos?: number | undefined; total?: number | undefined } | undefined): TaskProblemTone {
  if (!counts) return "none";
  if (counts.errors > 0) return "error";
  if (counts.warnings > 0) return "warning";
  return "none";
}
