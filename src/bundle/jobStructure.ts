import { isAlias, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";
import { parse as parseToml } from "smol-toml";
import type { Document, Node } from "yaml";
import { closestName } from "./closestName.js";
import type { YamlLocation, YamlLocationMap } from "./sourceLocations.js";

/**
 * Mistakes in a job's task graph and parameter lists that `bundle validate` accepts
 * (#135, checked on Databricks CLI 0.299.0 to 1.22.1). Deploy rejects an unknown
 * dependency and a loop; duplicate keys deploy, merged by the CLI into one.
 */
export interface JobStructureFinding {
  kind:
    | "unknown_task_dependency"
    | "task_dependency_loop"
    | "duplicate_task_key"
    | "duplicate_job_parameter"
    | "environment_version_missing"
    | "unknown_environment_key"
    | "environments_not_checked"
    | "project_environment_version_missing"
    | "project_environment_version_unsupported"
    | "excluded_from_sync"
    | "project_environment_conflict"
    | "missing_library"
    | "multiple_job_triggers"
    | "invalid_job_parameter_name"
    | "invalid_task_key"
    | "outcome_without_condition"
    | "invalid_outcome"
    | "for_each_inputs_not_array"
    | "for_each_inputs_too_long"
    | "unknown_job_parameter"
    | "job_parameter_reference_with_dot"
    | "job_parameter_in_default";
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

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** Up to ten names in full; a longer loop names its first three, so a 1000-task loop stays short. */
const quoteList = (names: string[]) => {
  if (names.length > 10) return `${names.slice(0, 3).map((n) => `"${n}"`).join(", ")} and ${names.length - 3} others`;
  return names.length <= 1
    ? `"${names[0] ?? ""}"`
    : `${names.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${names.at(-1)}"`;
};

/** A key as the CLI reads it: as written, or with its `${...}` resolved; undefined when unknown. */
export function keyOf(raw: unknown, target: string | undefined, options: JobStructureOptions): string | undefined {
  // The CLI reads `task_key: 1` as "1", and merges it with a task written `task_key: "1"`.
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (typeof raw !== "string") return undefined;
  if (!raw.includes("${")) return raw;
  const resolved = options.resolve?.(raw, target);
  return resolved !== undefined && !resolved.includes("${") ? resolved : undefined;
}

/**
 * The name a task goes by: its key as the CLI reads it, else the `${...}` text the preview
 * left, which is also the graph's name for the task. Its other settings can still be checked.
 */
export function taskIdOf(raw: unknown, target: string | undefined, options: JobStructureOptions): string | undefined {
  return keyOf(raw, target, options) ?? (typeof raw === "string" ? raw : undefined);
}

export interface JobList {
  jobKey: string;
  items: unknown[];
  /** The YAML path of the list, as segments. */
  path: (string | number)[];
  /** The target whose list this is; none for the job's own. */
  target?: string;
}

/** Every list that can define a job's tasks, parameters or environments: the job's own and each target's. */
export function* jobLists(doc: unknown, field: "tasks" | "parameters" | "environments"): Generator<JobList> {
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
export function locator(file: SourceFile): (path: (string | number)[], at?: "value" | "key") => YamlLocation | undefined {
  let parsed: { doc: Document; lineCounter: LineCounter; anchors: Map<string, Node[]> } | undefined;
  return (path, at = "value") => {
    const mapped = at === "value" ? file.locations?.get(pathKey(path)) : undefined;
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
    for (const [i, part] of path.entries()) {
      // A key written in this map, not brought in by a merge: point at the key itself.
      if (at === "key" && i === path.length - 1 && typeof part === "string") {
        const here = resolve(node);
        const pair = isMap(here) ? here.items.filter((p) => isScalar(p.key) && p.key.value === part).at(-1) : undefined;
        const offset = (pair?.key as Node | undefined)?.range?.[0];
        if (typeof offset === "number") {
          const { line, col } = lineCounter.linePos(offset);
          return { file: file.file, line, column: col };
        }
      }
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
 * `field` is the part of the dependency to point at.
 */
export function dependencyLocation(
  files: SourceFile[],
  locate: Map<SourceFile, (path: (string | number)[]) => YamlLocation | undefined>,
  jobKey: string,
  taskKey: string,
  upstream: string,
  options: JobStructureOptions,
  field: "task_key" | "outcome" = "task_key",
  /**
   * Which entry naming `upstream` to point at, counted from 0 in the order the CLI joins them:
   * the job's own list, then the picked target's. Without it, the first entry, target's first.
   */
  occurrence?: number,
): YamlLocation | undefined {
  if (occurrence !== undefined) {
    const entries: YamlLocation[] = [];
    for (const fromTarget of [false, true]) {
      for (const file of files) {
        for (const tasks of jobLists(file.doc, "tasks")) {
          if (tasks.jobKey !== jobKey || (tasks.target !== undefined) !== fromTarget) continue;
          if (fromTarget && tasks.target !== options.activeTarget) continue;
          const target = tasks.target ?? options.activeTarget;
          for (const [index, task] of tasks.items.entries()) {
            if (taskIdOf(record(task).task_key, target, options) !== taskKey) continue;
            for (const [position, dependency] of list(record(task).depends_on).entries()) {
              if (keyOf(record(dependency).task_key, target, options) !== upstream) continue;
              const base = [...tasks.path, index, "depends_on", position];
              const found = locate.get(file)!([...base, field]) ?? locate.get(file)!([...base, "task_key"]);
              if (found) entries.push(found);
            }
          }
        }
      }
    }
    if (entries[occurrence]) return entries[occurrence];
  }
  let taskLocation: YamlLocation | undefined;
  // The picked target's list first: a dependency it writes again is the one the CLI keeps.
  for (const fromTarget of [true, false]) {
    for (const file of files) {
      for (const tasks of jobLists(file.doc, "tasks")) {
        if (tasks.jobKey !== jobKey || (tasks.target !== undefined) !== fromTarget) continue;
        if (fromTarget && tasks.target !== options.activeTarget) continue;
        const target = tasks.target ?? options.activeTarget;
        for (const [index, task] of tasks.items.entries()) {
          if (taskIdOf(record(task).task_key, target, options) !== taskKey) continue;
          const dependency = list(record(task).depends_on).findIndex((d) => keyOf(record(d).task_key, target, options) === upstream);
          const found = dependency >= 0 ? locate.get(file)!([...tasks.path, index, "depends_on", dependency, field]) : undefined;
          if (found) return found;
          taskLocation ??= locate.get(file)!([...tasks.path, index, "task_key"]);
        }
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
          const value = record(item)[keyField];
          const key = keyOf(value, target ?? options.activeTarget, options);
          if (key === undefined) return;
          const raw = String(value);
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

export function located(location: YamlLocation | undefined): { location?: YamlLocation } {
  return location ? { location } : {};
}

/** The fields that give a job environment its version. Deploy accepts any one of them. */
const ENVIRONMENT_VERSION_FIELDS = ["environment_version", "client", "base_environment", "project_environment"] as const;

const isSet = (value: unknown) =>
  (typeof value === "string" && value.trim() !== "") || typeof value === "number";

/**
 * Whether a `pyproject.toml` names an environment version for Databricks. The run reads
 * `environment_version` or `base_environment` under `[tool.databricks.environment]`; TOML
 * can write that table several ways (a header, dotted keys, an inline table).
 */
export function pyprojectNamesEnvironmentVersion(text: string): boolean {
  const environment = pyprojectEnvironment(text);
  return environment !== undefined && (isSet(environment.environment_version) || isSet(environment.base_environment));
}

/** Undefined means the TOML could not be parsed, not that a version was missing. */
function pyprojectEnvironment(text: string): Record<string, unknown> | undefined {
  try {
    const doc = parseToml(text, { integersAsBigInt: "asNeeded" });
    return record(record(record(doc.tool).databricks).environment);
  } catch {
    return undefined;
  }
}

export interface EnvironmentOptions extends JobStructureOptions {
  /**
   * The text of the local file a job's `project_environment` names, or undefined when it
   * can't be read (a workspace path, a variable, a missing file).
   */
  readProjectFile?: (jobKey: string, value: string) => string | undefined;
  /** A known local project file is excluded from deploy's upload. */
  projectFileExcluded?: (jobKey: string, value: string) => boolean;
  /**
   * A local environment dependency that deploy will fail on: missing, or a glob no file
   * matches, read from the job's YAML folder (#482). Undefined when it is there, or when
   * deploy may build it first. `suggestion` is the path from the YAML folder to a file the
   * value names from the bundle root, the usual mistake (#518).
   */
  missingDependency?: (jobKey: string, value: string) => { glob: boolean; suggestion?: string; notAFile?: true; hint?: string } | undefined;
  /** Whether an environment dependency is a local file to the CLI (see localLibraries.ts). */
  isLocalDependency?: (value: string) => boolean;
}

/** Where a job's own `environments` is written: the variable, or the key whose environment can't be resolved. */
function jobEnvironmentsLocation(
  files: SourceFile[],
  locate: Map<SourceFile, ReturnType<typeof locator>>,
  jobKey: string,
): YamlLocation | undefined {
  for (const file of files) {
    const found = locate.get(file)!(["resources", "jobs", jobKey, "environments"]);
    if (found) return found;
  }
  return undefined;
}

/** Where a dependency with this value is written in a job's environment, else the environment itself. */
function environmentDependencyLocation(
  files: SourceFile[],
  locate: Map<SourceFile, (path: (string | number)[]) => YamlLocation | undefined>,
  jobKey: string,
  environmentKey: string,
  value: string,
  options: JobStructureOptions,
): YamlLocation | undefined {
  for (const file of files) {
    for (const environments of jobLists(file.doc, "environments")) {
      if (environments.jobKey !== jobKey) continue;
      if (environments.target !== undefined && environments.target !== options.activeTarget) continue;
      const target = environments.target ?? options.activeTarget;
      for (const [index, environment] of environments.items.entries()) {
        if (keyOf(record(environment).environment_key, target, options) !== environmentKey) continue;
        const dependencies = list(record(record(environment).spec).dependencies);
        const at = dependencies.findIndex((dependency) => dependency === value);
        if (at !== -1) return locate.get(file)!([...environments.path, index, "spec", "dependencies", at]);
      }
    }
  }
  return environmentLocation(files, locate, jobKey, environmentKey, ["spec", "dependencies"], options);
}

/**
 * Where a job's environment with this key is written: the job's own list first, else the
 * picked target's. Points at `field` in it when written there, else at its environment_key.
 */
function environmentLocation(
  files: SourceFile[],
  locate: Map<SourceFile, (path: (string | number)[]) => YamlLocation | undefined>,
  jobKey: string,
  environmentKey: string,
  field: (string | number)[],
  options: JobStructureOptions,
): YamlLocation | undefined {
  let keyLocation: YamlLocation | undefined;
  for (const own of [true, false]) {
    for (const file of files) {
      for (const environments of jobLists(file.doc, "environments")) {
        if (environments.jobKey !== jobKey || (environments.target === undefined) !== own) continue;
        if (!own && environments.target !== options.activeTarget) continue;
        const target = environments.target ?? options.activeTarget;
        for (const [index, environment] of environments.items.entries()) {
          if (keyOf(record(environment).environment_key, target, options) !== environmentKey) continue;
          const found = field.length ? locate.get(file)!([...environments.path, index, ...field]) : undefined;
          if (found) return found;
          keyLocation ??= locate.get(file)!([...environments.path, index, "environment_key"]);
        }
      }
    }
  }
  return keyLocation;
}

/** Whether the YAML as written sets a version field in this environment's spec, in the job's own list or the picked target's. */
function writtenVersionField(files: SourceFile[], jobKey: string, environmentKey: string, options: JobStructureOptions): boolean {
  for (const file of files) {
    for (const environments of jobLists(file.doc, "environments")) {
      if (environments.jobKey !== jobKey) continue;
      if (environments.target !== undefined && environments.target !== options.activeTarget) continue;
      const target = environments.target ?? options.activeTarget;
      for (const environment of environments.items) {
        if (keyOf(record(environment).environment_key, target, options) !== environmentKey) continue;
        const spec = record(record(environment).spec);
        if (ENVIRONMENT_VERSION_FIELDS.some((field) => isSet(spec[field]))) return true;
      }
    }
  }
  return false;
}

/**
 * Where a task's `environment_key` is written: the picked target's copy of the task
 * first (a target that changes the key), else the job's own. `inner` is a for-each
 * task's inner task.
 */
function taskEnvironmentKeyLocation(
  files: SourceFile[],
  locate: Map<SourceFile, (path: (string | number)[]) => YamlLocation | undefined>,
  jobKey: string,
  taskKey: string,
  inner: boolean,
  options: JobStructureOptions,
): YamlLocation | undefined {
  const field = inner ? ["for_each_task", "task", "environment_key"] : ["environment_key"];
  for (const fromTarget of [true, false]) {
    for (const file of files) {
      for (const tasks of jobLists(file.doc, "tasks")) {
        if (tasks.jobKey !== jobKey || (tasks.target !== undefined) !== fromTarget) continue;
        if (fromTarget && tasks.target !== options.activeTarget) continue;
        const target = tasks.target ?? options.activeTarget;
        for (const [index, task] of tasks.items.entries()) {
          if (keyOf(record(task).task_key, target, options) !== taskKey) continue;
          const found = locate.get(file)!([...tasks.path, index, ...field]);
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

/**
 * Job environments that `bundle validate` accepts and Databricks rejects (#418, tested on
 * Databricks CLI v1.26.0): an environment with no version fails `bundle deploy`, a task
 * naming an environment the job doesn't have fails `bundle deploy`, and a
 * `project_environment` whose pyproject.toml names no version fails when the job runs.
 * Checked in the jobs as the CLI resolved them, so a picked target's settings count.
 */
export function findEnvironmentProblems(
  jobs: Record<string, unknown>,
  files: SourceFile[],
  options: EnvironmentOptions = {},
): JobStructureFinding[] {
  const findings: JobStructureFinding[] = [];
  const locate = new Map(files.map((file) => [file, locator(file)]));
  const target = options.activeTarget;

  for (const [jobKey, job] of Object.entries(jobs)) {
    const environments = list(record(job).environments).map((environment) => ({
      key: keyOf(record(environment).environment_key, target, options),
      spec: record(record(environment).spec),
    }));

    for (const { key, spec } of environments) {
      if (key === undefined) continue;
      const conflicts = ["environment_version", "client", "base_environment", "image_uri", "dependencies", "java_dependencies"]
        .filter((field) => isSet(spec[field]) || (Array.isArray(spec[field]) && spec[field].length > 0));
      if (isSet(spec.project_environment) && conflicts.length > 0) {
        findings.push({
          kind: "project_environment_conflict", jobKey, subject: key,
          title: `Environment "${key}" combines project_environment with ${conflicts.join(", ")}, so deploy may fail.`,
          fixHint: "Keep project_environment as the only environment source in spec, and put its version and dependencies in pyproject.toml. Or remove project_environment and use the other fields.",
          ...located(environmentLocation(files, locate, jobKey, key, ["spec", "project_environment"], options)),
        });
        continue;
      }
      if (!ENVIRONMENT_VERSION_FIELDS.some((field) => isSet(spec[field]))) {
        // A CLI that doesn't know a field drops it from its output (project_environment
        // before v1.20.0) and warns "unknown field". The YAML does set a version then, so
        // saying it has none would be wrong; the CLI's warning names the real cause.
        if (writtenVersionField(files, jobKey, key, options)) continue;
        findings.push({
          kind: "environment_version_missing",
          jobKey,
          subject: key,
          title: `Environment "${key}" has no version. Deploy may fail.`,
          fixHint: `Deploy fails with "Either base environment, version, or project_environment must be provided for environment '${key}'". Set environment_version, base_environment or project_environment in its spec.`,
          ...located(environmentLocation(files, locate, jobKey, key, [], options)),
        });
        continue;
      }
      // Local files in dependencies: deploy checks them after building artifacts, and
      // fails on a missing one (live, CLI 1.27.0, #482): "file doesn't exist <path>", or
      // "no files match pattern: <path>" for a glob. `bundle validate` passes.
      for (const dependency of list(spec.dependencies)) {
        if (typeof dependency !== "string" || dependency.includes("${")) continue;
        if (!options.isLocalDependency?.(dependency)) continue;
        const missing = options.missingDependency?.(jobKey, dependency);
        if (!missing) continue;
        const didYouMean = missing.suggestion ? ` Did you mean "${missing.suggestion}"?` : "";
        findings.push({
          kind: "missing_library",
          jobKey,
          subject: `${key}:${dependency}`,
          title: missing.notAFile
            ? `Environment "${key}": ${dependency} contains a path that is not a regular file, so deploy may fail.`
            : missing.glob
            ? `Environment "${key}": no file matches ${dependency}, so deploy may fail.${didYouMean}`
            : `Environment "${key}": ${dependency} doesn't exist, so deploy may fail.${didYouMean}`,
          fixHint: missing.notAFile
            ? "Use a path or glob that matches only library files. Deploy cannot upload a directory as a library."
            : missing.glob
            ? `Deploy fails with "no files match pattern". Paths are read from the YAML file's folder. Build the file, or correct the path.${missing.hint ?? ""}`
            : `Deploy fails with "file doesn't exist". Paths are read from the YAML file's folder. Build the file, or correct the path.${missing.hint ?? ""}`,
          ...located(environmentDependencyLocation(files, locate, jobKey, key, dependency, options)),
        });
      }

      const project = spec.project_environment;
      // Any other version field wins: deploy refuses project_environment combined with one.
      const versioned = ENVIRONMENT_VERSION_FIELDS.some((field) => field !== "project_environment" && isSet(spec[field]));
      if (typeof project !== "string" || versioned) continue;
      const projectLocation = () => located(environmentLocation(files, locate, jobKey, key, ["spec", "project_environment"], options));
      if (options.projectFileExcluded?.(jobKey, project)) {
        findings.push({
          kind: "excluded_from_sync", jobKey, subject: key,
          title: `Environment "${key}": its project file is not uploaded. The job may fail when it runs.`,
          fixHint: "Make sure deploy uploads the project file: check .gitignore, sync.exclude, sync.include and symbolic links.",
          ...projectLocation(),
        });
      }
      const text = options.readProjectFile?.(jobKey, project);
      if (text === undefined) continue;
      const environment = pyprojectEnvironment(text);
      if (environment === undefined) continue;
      if (isSet(environment.base_environment)) continue;
      const version = environment.environment_version;
      if (isSet(version)) {
        // Only judge concrete integer versions; do not invent a runtime rule for other values.
        if (/^-?\d+$/.test(String(version)) && Number(version) < 5) {
          findings.push({
            kind: "project_environment_version_unsupported", jobKey, subject: key,
            title: `Environment "${key}": project environment version ${version} is below 5. The job may fail when it runs.`,
            fixHint: "Project environments require environment_version 5 or later. Set it under [tool.databricks.environment] in pyproject.toml, or use a base_environment.",
            ...projectLocation(),
          });
        }
        continue;
      }
      findings.push({
        kind: "project_environment_version_missing",
        jobKey,
        subject: key,
        title: `Environment "${key}": its pyproject.toml has no environment version. The job may fail when it runs.`,
        fixHint: `The run fails with "pyproject.toml must specify environment_version or base_environment under [tool.databricks.environment]". Add environment_version (for example "5") or base_environment under [tool.databricks.environment] in that file.`,
        ...projectLocation(),
      });
    }

    // A key the preview can't resolve could be any key: no task's key can be called unknown.
    // Nor can it when the whole list is a variable, `environments: ${var.envs}`: the structural
    // preview keeps a complex variable as text, so the job's environments aren't known here.
    // A note says so (#679), so that "not checked" never looks like "no problems".
    const written = record(job).environments;
    const fromVariable = written !== undefined && written !== null && !Array.isArray(written);
    if (fromVariable || environments.some(({ key }) => key === undefined)) {
      const tasks = list(record(job).tasks) as (Task & { environment_key?: unknown; for_each_task?: unknown })[];
      const usesKey = (task: { environment_key?: unknown }) => isSet(task.environment_key);
      if (target === undefined && tasks.some((task) => usesKey(task) || usesKey(record(record(task.for_each_task).task)))) {
        findings.push({
          kind: "environments_not_checked",
          jobKey,
          subject: "environments",
          title: `Not checked: job "${jobKey}"'s environments use a variable, so they aren't known yet.`,
          fixHint: "The structural preview leaves this variable unresolved, so the check that each task's environment_key names one of the job's environments doesn't run on this job.",
          ...located(jobEnvironmentsLocation(files, locate, jobKey)),
        });
      }
      continue;
    }
    const known = environments.map(({ key }) => key as string);
    const reported = new Set<string>();
    const check = (task: Task & { environment_key?: unknown }, taskKey: string, inner: boolean) => {
      if (task.environment_key === undefined || task.environment_key === null || task.environment_key === "") return;
      const used = keyOf(task.environment_key, target, options);
      if (used === undefined || known.includes(used) || reported.has(`${taskKey}\u0000${inner}`)) return;
      reported.add(`${taskKey}\u0000${inner}`);
      const suggestion = closestName(used, known);
      findings.push({
        kind: "unknown_environment_key",
        jobKey,
        taskKey,
        subject: `${used}${inner ? "#inner" : ""}`,
        title: `Environment "${used}" may not exist.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
        fixHint: `Deploy fails with "Job environment '${used}' used by task ${taskKey} is not defined in field 'environments'". Use the environment_key of one of job "${jobKey}"'s environments${known.length ? `: ${quoteList(known)}` : ", or add one"}.`,
        ...located(taskEnvironmentKeyLocation(files, locate, jobKey, taskKey, inner, options)),
      });
    };
    for (const task of list(record(job).tasks) as (Task & { environment_key?: unknown; for_each_task?: unknown })[]) {
      const taskKey = keyOf(task.task_key, target, options);
      if (taskKey === undefined) continue;
      check(task, taskKey, false);
      const innerTask = record(record(task.for_each_task).task);
      if (Object.keys(innerTask).length) check(innerTask, taskKey, true);
    }
  }
  return findings;
}
