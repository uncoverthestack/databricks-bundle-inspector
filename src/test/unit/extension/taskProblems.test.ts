import { describe, expect, test } from "@jest/globals";
import { countsFor, problemTone, taskProblemCounts, type TaskProblemIssue } from "../../../webview/lib/taskProblems.js";

const issue = (taskId: string | undefined, severity: TaskProblemIssue["severity"]): TaskProblemIssue => ({ taskId, severity });

describe("task box problems (issue 393)", () => {
  // The kitchen-sink job: three missing files, two in for-each tasks' inner tasks (reported
  // on the for-each task), and a git source warning on the notebook task.
  const issues = [
    issue("job.tasks.t_notebook", "warning"),
    issue("job.tasks.t_spark_python", "error"),
    issue("job.tasks.t_sql_file", "error"),
    issue("job.tasks.t_dbt", "error"),
    issue("job.tasks.t_for_each", "error"),
    issue("job.tasks.t_for_each_left", "error"),
    issue(undefined, "warning"),
  ];

  test("each task gets its own problems; bundle-wide ones belong to no box", () => {
    const counts = taskProblemCounts(issues);
    expect(countsFor(counts, "job.tasks.t_for_each")).toEqual({ errors: 1, warnings: 0, infos: 0, total: 1 });
    expect(countsFor(counts, "job.tasks.t_notebook")).toEqual({ errors: 0, warnings: 1, infos: 0, total: 1 });
    expect([...counts.values()].reduce((sum, c) => sum + c.total, 0)).toBe(6);
  });

  test("the boxes add up to the job's problem count", () => {
    const counts = taskProblemCounts(issues);
    const jobProblems = issues.filter((entry) => entry.taskId).length;
    expect([...counts.values()].reduce((sum, c) => sum + c.total, 0)).toBe(jobProblems);
  });

  test("red for any error, amber for warnings only, nothing for info only or none", () => {
    expect(problemTone({ errors: 1, warnings: 2, infos: 0, total: 3 })).toBe("error");
    expect(problemTone({ errors: 0, warnings: 1, infos: 1, total: 2 })).toBe("warning");
    expect(problemTone({ errors: 0, warnings: 0, infos: 3, total: 3 })).toBe("none");
    expect(problemTone(countsFor(taskProblemCounts([]), "x"))).toBe("none");
    expect(problemTone(undefined)).toBe("none");
  });

  test("a task with several problems counts each one", () => {
    const counts = taskProblemCounts([issue("t", "error"), issue("t", "warning"), issue("t", "info")]);
    expect(countsFor(counts, "t")).toEqual({ errors: 1, warnings: 1, infos: 1, total: 3 });
  });
});
