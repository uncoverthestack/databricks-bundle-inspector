import { isAlias, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";
import type { Document, Node } from "yaml";
import { closestName } from "./closestName.js";
import type { YamlLocation, YamlLocationMap } from "./sourceLocations.js";

/**
 * Mistakes in a job's task graph and parameter lists that `bundle validate` accepts
 * (#135, checked on Databricks CLI 0.299.0 to 1.22.1). Deploy rejects an unknown
 * dependency and a loop; duplicate keys deploy, merged by the CLI into one.
 */
export interface JobStructureFinding {
  kind: "unknown_task_dependency" | "task_dependency_loop" | "duplicate_task_key" | "duplicate_job_parameter";
  /** The job's resource key, e.g. `nightly` for `resources.jobs.nightly`. */
  jobKey: string;
  /** The task the finding belongs to; none for a job parameter. */
  taskKey?: string;
  /** What tells two findings on one line apart: the missing key, the loop edge, the repeated name. */
  subject: string;
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

/** A YAML file the bundle loaded: its parsed content, its text, and the location of each YAML path. */
export interface SourceFile {
  file: string;
  doc: unknown;
  text?: string | undefined;
  locations: YamlLocationMap | undefined;
}

export interface JobStructureOptions {
  /** The target picked in the graph; none in the structural preview. */
  activeTarget?: string;
  /**
   * A key with `${...}` in it as the CLI would read it for a target, or undefined when
   * that can't be told offline. The CLI resolves variables before it merges tasks.
   */
  resolve?: (value: string, target: string | undefined) => string | undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** Up to ten names in full; a longer loop names its first three, so a 1000-task loop stays short. */
const quoteList = (names: string[]) => {
  if (names.length > 10) return `${names.slice(0, 3).map((n) => `"${n}"`).join(", ")} and ${names.length - 3} others`;
  return names.length <= 1
    ? `"${names[0] ?? ""}"`
    : `${names.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${names.at(-1)}"`;
};

/** A key as the CLI reads it: as written, or with its `${...}` resolved; undefined when unknown. */
function keyOf(raw: unknown, target: string | undefined, options: JobStructureOptions): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (!raw.includes("${")) return raw;
  const resolved = options.resolve?.(raw, target);
  return resolved !== undefined && !resolved.includes("${") ? resolved : undefined;
}

interface JobList {
  jobKey: string;
  items: unknown[];
  /** The YAML path of the list, as segments. */
  path: (string | number)[];
  /** The target whose list this is; none for the job's own. */
  target?: string;
}

/** Every list that can define a job's tasks or parameters: the job's own and each target's. */
function* jobLists(doc: unknown, field: "tasks" | "parameters"): Generator<JobList> {
  const root = record(doc);
  for (const [jobKey, job] of Object.entries(record(record(root.resources).jobs))) {
    yield { jobKey, items: list(record(job)[field]), path: ["resources", "jobs", jobKey, field] };
  }
  for (const [target, settings] of Object.entries(record(root.targets))) {
    for (const [jobKey, job] of Object.entries(record(record(record(settings).resources).jobs))) {
      yield { jobKey, items: list(record(job)[field]), path: ["targets", target, "resources", "jobs", jobKey, field], target };
    }
  }
}

const pathKey = (path: (string | number)[]) =>
  path.map((part, i) => (typeof part === "number" ? `[${part}]` : i === 0 ? part : `.${part}`)).join("");

/**
 * Where a YAML path is written in a file. Paths through an alias or a `<<` merge are
 * not in the location map, so the file is read again following them, and the location
 * is where the anchor writes the value.
 */
function locator(file: SourceFile): (path: (string | number)[]) => YamlLocation | undefined {
  let parsed: { doc: Document; lineCounter: LineCounter; anchors: Map<string, Node[]> } | undefined;
  return (path) => {
    const mapped = file.locations?.get(pathKey(path));
    if (mapped) return mapped;
    if (file.text === undefined) return undefined;
    if (!parsed) {
      const lineCounter = new LineCounter();
      const doc = parseDocument(file.text, { lineCounter, uniqueKeys: false });
      const anchors = new Map<string, Node[]>();
      visit(doc, (_key, node) => {
        if (isNode(node) && node.anchor) anchors.set(node.anchor, [...(anchors.get(node.anchor) ?? []), node]);
      });
      parsed = { doc, lineCounter, anchors };
    }
    const { doc, lineCounter, anchors } = parsed;
    const resolve = (node: unknown): unknown => {
      let current = node;
      for (let hops = 0; isAlias(current) && hops < 100; hops++) {
        const at = (current as Node).range?.[0] ?? Infinity;
        current = anchors.get((current as { source: string }).source)?.filter((n) => (n.range?.[0] ?? Infinity) < at).at(-1);
      }
      return current;
    };
    const child = (node: unknown, part: string | number, depth = 0): unknown => {
      const here = resolve(node);
      if (typeof part === "number") return isSeq(here) ? here.items[part] : undefined;
      if (!isMap(here) || depth > 20) return undefined;
      // The map's own key wins over a merged one; the last of a repeated key wins.
      const own = here.items.filter((pair) => isScalar(pair.key) && pair.key.value === part).at(-1);
      if (own) return own.value;
      for (const pair of [...here.items].reverse()) {
        if (!(isScalar(pair.key) && pair.key.value === "<<")) continue;
        const merged = resolve(pair.value);
        for (const source of isSeq(merged) ? [...merged.items].reverse() : [merged]) {
          const found = child(source, part, depth + 1);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    let node: unknown = doc.contents;
    for (const part of path) {
      node = child(node, part);
      if (node === undefined) return undefined;
    }
    const target = resolve(node) as Node | undefined;
    const offset = (node as Node | undefined)?.range?.[0] ?? target?.range?.[0];
    if (typeof offset !== "number") return undefined;
    const { line, col } = lineCounter.linePos(offset);
    return { file: file.file, line, column: col };
  };
}

/**
 * Where a task's dependency on `upstream` is written: in the job's own list or the picked
 * target's, never another target's, and in whichever copy of a repeated task key has it.
 */
function dependencyLocation(
  files: SourceFile[],
  locate: Map<SourceFile, (path: (string | number)[]) => YamlLocation | undefined>,
  jobKey: string,
  taskKey: string,
  upstream: string,
  options: JobStructureOptions,
): YamlLocation | undefined {
  let taskLocation: YamlLocation | undefined;
  for (const file of files) {
    for (const tasks of jobLists(file.doc, "tasks")) {
      if (tasks.jobKey !== jobKey || (tasks.target !== undefined && tasks.target !== options.activeTarget)) continue;
      const target = tasks.target ?? options.activeTarget;
      for (const [index, task] of tasks.items.entries()) {
        if (keyOf(record(task).task_key, target, options) !== taskKey) continue;
        const dependency = list(record(task).depends_on).findIndex((d) => keyOf(record(d).task_key, target, options) === upstream);
        const found = dependency >= 0 ? locate.get(file)!([...tasks.path, index, "depends_on", dependency, "task_key"]) : undefined;
        if (found) return found;
        taskLocation ??= locate.get(file)!([...tasks.path, index, "task_key"]);
      }
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
export function findDependencyProblems(
  jobs: Record<string, unknown>,
  files: SourceFile[],
  options: JobStructureOptions = {},
): JobStructureFinding[] {
  const findings: JobStructureFinding[] = [];
  const locate = new Map(files.map((file) => [file, locator(file)]));
  const target = options.activeTarget;
  const keysOf = (job: unknown) => list(record(job).tasks).map((task) => keyOf((task as Task).task_key, target, options));
  const taskKeysByJob = new Map(Object.entries(jobs).map(([jobKey, job]) => [jobKey, keysOf(job)]));

  for (const [jobKey, maybeKeys] of taskKeysByJob) {
    // A task key the preview can't resolve could be any key: nothing can be called unknown.
    const keysKnown = maybeKeys.every((key) => key !== undefined);
    const keys = maybeKeys.filter((key): key is string => key !== undefined);
    const known = new Set(keys);
    const dependsOn = new Map<string, string[]>();
    // A task key listed twice is one task to the CLI: report each missing key once.
    const reported = new Set<string>();
    for (const task of list(record(jobs[jobKey]).tasks) as Task[]) {
      const taskKey = keyOf(task.task_key, target, options);
      if (taskKey === undefined) continue;
      const upstream = list(task.depends_on).flatMap((d) => {
        const key = keyOf((d as Dependency).task_key, target, options);
        return key === undefined ? [] : [key];
      });
      dependsOn.set(taskKey, [...(dependsOn.get(taskKey) ?? []), ...upstream]);
      if (!keysKnown) continue;
      for (const missing of new Set(upstream.filter((key) => !known.has(key)))) {
        if (reported.has(`${taskKey}\u0000${missing}`)) continue;
        reported.add(`${taskKey}\u0000${missing}`);
        const owner = [...taskKeysByJob].find(([other, otherKeys]) => other !== jobKey && otherKeys.includes(missing))?.[0];
        const suggestion = owner ? undefined : closestName(missing, keys.filter((key) => key !== taskKey));
        findings.push({
          kind: "unknown_task_dependency",
          jobKey,
          taskKey,
          subject: missing,
          title: owner
            ? `Task "${taskKey}" depends on "${missing}", which is a task of job "${owner}", not of job "${jobKey}".`
            : `Task "${taskKey}" depends on "${missing}", but job "${jobKey}" has no task with that key.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
          fixHint: owner
            ? `A task can only depend on tasks in its own job; deploy fails with "Invalid dependency graph". To run after job "${owner}", trigger it or use a run_job_task.`
            : `Deploy fails with "Invalid dependency graph". Use the task_key of a task in this job.`,
          ...located(dependencyLocation(files, locate, jobKey, taskKey, missing, options)),
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
      const inLoop = new Set(loop);
      for (const taskKey of loop) {
        const upstreamInLoop = (dependsOn.get(taskKey) ?? []).find((key) => inLoop.has(key))!;
        findings.push({
          kind: "task_dependency_loop",
          jobKey,
          taskKey,
          subject: upstreamInLoop,
          title: self
            ? `Task "${taskKey}" depends on itself, so it can never start.`
            : `Tasks ${quoteList(loop)} depend on each other in a loop, so none of them can start.`,
          fixHint: self
            ? `Deploy fails with "task '${taskKey}' can not reference itself". Remove "${taskKey}" from its own depends_on.`
            : `Deploy fails with "circular dependencies are not allowed". Remove one of the depends_on entries that close the loop.`,
          ...located(dependencyLocation(files, locate, jobKey, taskKey, upstreamInLoop, options)),
        });
      }
    }
  }
  return findings;
}

/**
 * Task keys and job parameter names written twice in one list, in each file the bundle
 * loaded, compared as the CLI reads them (variables resolved). The CLI merges them into
 * one, the later settings winning, so fewer tasks run than listed. Only within one list:
 * a target listing a job's task key again is the intended way to override that task.
 */
export function findDuplicateKeys(files: SourceFile[], options: JobStructureOptions = {}): JobStructureFinding[] {
  const findings: JobStructureFinding[] = [];
  for (const file of files) {
    const locate = locator(file);
    for (const field of ["tasks", "parameters"] as const) {
      for (const { jobKey, items, path, target } of jobLists(file.doc, field)) {
        const keyField = field === "tasks" ? "task_key" : "name";
        const first = new Map<string, { position: number; raw: string }>();
        const where = target ? `In target "${target}", job "${jobKey}"` : `Job "${jobKey}"`;
        items.forEach((item, position) => {
          const raw = record(item)[keyField];
          const key = keyOf(raw, target ?? options.activeTarget, options);
          if (key === undefined || typeof raw !== "string") return;
          const earlier = first.get(key);
          if (!earlier) {
            first.set(key, { position, raw });
            return;
          }
          const firstLine = locate([...path, earlier.position, keyField])?.line;
          const firstIs = firstLine ? ` The first is on line ${firstLine}.` : "";
          const written = [earlier.raw, raw].filter((r) => r !== key);
          const resolution = written.length ? ` (${written.map((r) => `"${r}"`).join(" and ")} resolves to "${key}")` : "";
          findings.push(
            field === "tasks"
              ? {
                  kind: "duplicate_task_key",
                  jobKey,
                  taskKey: key,
                  subject: `${key}#${position}`,
                  title: `${where} lists the task key "${key}" twice${resolution}. The CLI merges tasks that share a key into one, later settings overriding earlier ones, so fewer tasks run than listed.`,
                  fixHint: `Give each task its own task_key, or merge the two by hand.${firstIs}`,
                  ...located(locate([...path, position, keyField])),
                }
              : {
                  kind: "duplicate_job_parameter",
                  jobKey,
                  subject: `${key}#${position}`,
                  title: `${where} declares the parameter "${key}" twice${resolution}. The CLI keeps one, with the later default.`,
                  fixHint: `Remove one of them.${firstIs}`,
                  ...located(locate([...path, position, keyField])),
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
