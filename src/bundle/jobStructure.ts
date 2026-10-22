import { closestName } from "./closestName.js";
import type { YamlLocation, YamlLocationMap } from "./sourceLocations.js";

/**
 * Mistakes in a job's task graph and parameter lists that `bundle validate` accepts
 * (#135, checked on Databricks CLI 0.299.0 to 1.21.0). Deploy rejects an unknown
 * dependency and a loop; duplicate keys deploy, merged by the CLI into one.
 */
export interface JobStructureFinding {
  kind: "unknown_task_dependency" | "task_dependency_loop" | "duplicate_task_key" | "duplicate_job_parameter";
  /** The job's resource key, e.g. `nightly` for `resources.jobs.nightly`. */
  jobKey: string;
  /** The task the finding belongs to; none for a job parameter. */
  taskKey?: string;
  title: string;
  fixHint: string;
  location?: YamlLocation;
}

interface Dependency {
  task_key?: unknown;
}

interface Task {
  task_key?: unknown;
  depends_on?: unknown;
}

/** A YAML file the bundle loaded: its parsed content and the location of each YAML path. */
export interface SourceFile {
  doc: unknown;
  locations: YamlLocationMap | undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const quoteList = (names: string[]) =>
  names.length <= 1
    ? `"${names[0] ?? ""}"`
    : `${names.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${names.at(-1)}"`;

/** Every `tasks:` list that can define a job's tasks, with its YAML path: the job's own and each target's. */
function* jobLists(doc: unknown, field: "tasks" | "parameters"): Generator<{ jobKey: string; items: unknown[]; path: string }> {
  const root = record(doc);
  for (const [jobKey, job] of Object.entries(record(record(root.resources).jobs))) {
    yield { jobKey, items: list(record(job)[field]), path: `resources.jobs.${jobKey}.${field}` };
  }
  for (const [target, settings] of Object.entries(record(root.targets))) {
    for (const [jobKey, job] of Object.entries(record(record(record(settings).resources).jobs))) {
      yield { jobKey, items: list(record(job)[field]), path: `targets.${target}.resources.jobs.${jobKey}.${field}` };
    }
  }
}

/** Where a task's dependency on `upstream` is written: the first list entry naming it, in any file. */
function dependencyLocation(files: SourceFile[], jobKey: string, taskKey: string, upstream: string): YamlLocation | undefined {
  let taskLocation: YamlLocation | undefined;
  for (const { doc, locations } of files) {
    for (const tasks of jobLists(doc, "tasks")) {
      if (tasks.jobKey !== jobKey) continue;
      const index = tasks.items.findIndex((task) => record(task).task_key === taskKey);
      if (index < 0) continue;
      const dependency = list(record(tasks.items[index]).depends_on).findIndex((d) => record(d).task_key === upstream);
      const found = dependency >= 0 ? locations?.get(`${tasks.path}[${index}].depends_on[${dependency}].task_key`) : undefined;
      if (found) return found;
      taskLocation ??= locations?.get(`${tasks.path}[${index}].task_key`);
    }
  }
  return taskLocation;
}

/**
 * The loops in a job's dependencies, as the tasks in each, by Tarjan's algorithm
 * without recursion: a job can have 1000 tasks.
 */
function dependencyLoops(dependsOn: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const loops: string[][] = [];
  let next = 0;
  for (const start of dependsOn.keys()) {
    if (index.has(start)) continue;
    const work: { task: string; edge: number }[] = [{ task: start, edge: 0 }];
    index.set(start, next);
    lowLink.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const upstream = dependsOn.get(frame.task) ?? [];
      if (frame.edge < upstream.length) {
        const to = upstream[frame.edge++]!;
        if (!dependsOn.has(to)) continue;
        if (!index.has(to)) {
          index.set(to, next);
          lowLink.set(to, next++);
          stack.push(to);
          onStack.add(to);
          work.push({ task: to, edge: 0 });
        } else if (onStack.has(to)) {
          lowLink.set(frame.task, Math.min(lowLink.get(frame.task)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowLink.set(parent.task, Math.min(lowLink.get(parent.task)!, lowLink.get(frame.task)!));
      if (lowLink.get(frame.task) !== index.get(frame.task)) continue;
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.task);
      const selfLoop = members.length === 1 && (dependsOn.get(members[0]!) ?? []).includes(members[0]!);
      if (members.length > 1 || selfLoop) loops.push(members.reverse());
    }
  }
  return loops;
}

/**
 * Dependencies on a task the job doesn't have, and loops, in the jobs as the CLI
 * resolved them, so a real target's merged tasks are what is checked.
 */
export function findDependencyProblems(jobs: Record<string, unknown>, files: SourceFile[]): JobStructureFinding[] {
  const findings: JobStructureFinding[] = [];
  const taskKeysByJob = new Map(
    Object.entries(jobs).map(([jobKey, job]) => [
      jobKey,
      list(record(job).tasks).flatMap((task) => (typeof (task as Task).task_key === "string" ? [(task as Task).task_key as string] : [])),
    ]),
  );

  for (const [jobKey, keys] of taskKeysByJob) {
    const known = new Set(keys);
    const dependsOn = new Map<string, string[]>();
    // A task key listed twice is one task to the CLI: report each missing key once.
    const reported = new Set<string>();
    for (const task of list(record(jobs[jobKey]).tasks) as Task[]) {
      if (typeof task.task_key !== "string") continue;
      const taskKey = task.task_key;
      const upstream = list(task.depends_on).flatMap((d) => {
        const key = (d as Dependency).task_key;
        return typeof key === "string" ? [key] : [];
      });
      dependsOn.set(taskKey, [...(dependsOn.get(taskKey) ?? []), ...upstream]);
      for (const missing of new Set(upstream.filter((key) => !known.has(key)))) {
        if (reported.has(`${taskKey}\u0000${missing}`)) continue;
        reported.add(`${taskKey}\u0000${missing}`);
        const owner = [...taskKeysByJob].find(([other, otherKeys]) => other !== jobKey && otherKeys.includes(missing))?.[0];
        const suggestion = owner ? undefined : closestName(missing, keys.filter((key) => key !== taskKey));
        findings.push({
          kind: "unknown_task_dependency",
          jobKey,
          taskKey,
          title: owner
            ? `Task "${taskKey}" depends on "${missing}", which is a task of job "${owner}", not of job "${jobKey}".`
            : `Task "${taskKey}" depends on "${missing}", but job "${jobKey}" has no task with that key.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
          fixHint: owner
            ? `A task can only depend on tasks in its own job; deploy fails with "Invalid dependency graph". To run after job "${owner}", trigger it or use a run_job_task.`
            : `Deploy fails with "Invalid dependency graph". Use the task_key of a task in this job.`,
          ...located(dependencyLocation(files, jobKey, taskKey, missing)),
        });
      }
    }

    // Name a loop's tasks in the order the job lists them.
    const position = new Map<string, number>();
    keys.forEach((key, i) => position.has(key) || position.set(key, i));
    for (const loop of dependencyLoops(dependsOn).map((members) =>
      members.sort((x, y) => position.get(x)! - position.get(y)!),
    )) {
      const self = loop.length === 1;
      for (const taskKey of loop) {
        const upstreamInLoop = (dependsOn.get(taskKey) ?? []).find((key) => loop.includes(key))!;
        findings.push({
          kind: "task_dependency_loop",
          jobKey,
          taskKey,
          title: self
            ? `Task "${taskKey}" depends on itself, so it can never start.`
            : `Tasks ${quoteList(loop)} depend on each other in a loop, so none of them can start.`,
          fixHint: self
            ? `Deploy fails with "task '${taskKey}' can not reference itself". Remove "${taskKey}" from its own depends_on.`
            : `Deploy fails with "circular dependencies are not allowed". Remove one of the depends_on entries that close the loop.`,
          ...located(dependencyLocation(files, jobKey, taskKey, upstreamInLoop)),
        });
      }
    }
  }
  return findings;
}

/**
 * Task keys and job parameter names written twice in one list, in each file the bundle
 * loaded. The CLI merges them into one, the later settings winning, so fewer tasks run
 * than listed. Only within one list: a target listing a job's task key again is the
 * intended way to override that task.
 */
export function findDuplicateKeys(files: SourceFile[]): JobStructureFinding[] {
  const findings: JobStructureFinding[] = [];
  for (const { doc, locations } of files) {
    for (const field of ["tasks", "parameters"] as const) {
      for (const { jobKey, items, path } of jobLists(doc, field)) {
        const keyField = field === "tasks" ? "task_key" : "name";
        const first = new Map<string, number>();
        items.forEach((item, position) => {
          const key = record(item)[keyField];
          if (typeof key !== "string") return;
          const earlier = first.get(key);
          if (earlier === undefined) {
            first.set(key, position);
            return;
          }
          const firstLine = locations?.get(`${path}[${earlier}].${keyField}`)?.line;
          const where = firstLine ? ` The first is on line ${firstLine}.` : "";
          findings.push(
            field === "tasks"
              ? {
                  kind: "duplicate_task_key",
                  jobKey,
                  taskKey: key,
                  title: `Job "${jobKey}" lists the task key "${key}" twice. The CLI merges tasks that share a key into one, later settings overriding earlier ones, so fewer tasks run than listed.`,
                  fixHint: `Give each task its own task_key, or merge the two by hand.${where}`,
                  ...located(locations?.get(`${path}[${position}].${keyField}`)),
                }
              : {
                  kind: "duplicate_job_parameter",
                  jobKey,
                  title: `Job "${jobKey}" declares the parameter "${key}" twice. The CLI keeps one, with the later default.`,
                  fixHint: `Remove one of them.${where}`,
                  ...located(locations?.get(`${path}[${position}].${keyField}`)),
                },
          );
        });
      }
    }
  }
  return findings;
}

function located(location: YamlLocation | undefined): { location?: YamlLocation } {
  return location ? { location } : {};
}
