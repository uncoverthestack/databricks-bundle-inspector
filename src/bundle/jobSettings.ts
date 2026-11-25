import type { YamlLocation } from "./sourceLocations.js";
import { closestName } from "./closestName.js";
import {
  dependencyLocation,
  jobLists,
  keyOf,
  list,
  located,
  locator,
  record,
  taskIdOf,
  type JobStructureFinding,
  type JobStructureOptions,
  type SourceFile,
} from "./jobStructure.js";

/**
 * Job settings that `bundle validate` accepts and the Jobs service rejects at `bundle deploy`
 * (#237). Each was deployed on Databricks CLI v1.28.0 (2026-11-25), broken and working, as a
 * new job and as an edit of a deployed one. Checked in the jobs as the CLI resolved them, so a
 * picked target's settings count; a value the preview leaves as `${...}` is not judged.
 */

type Locate = Map<SourceFile, ReturnType<typeof locator>>;

const TRIGGER_FIELDS = ["schedule", "trigger", "continuous"] as const;
/** Deploy refuses any other character, letters outside A-Z included ("café" fails). */
const TASK_KEY = /^[A-Za-z0-9_-]+$/;
const PARAMETER_NAME = /^[A-Za-z0-9_.-]+$/;
const OUTCOMES = ["true", "false"];

const unresolved = (value: string) => value.includes("${");
const quoted = (names: readonly string[]) =>
  names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A scalar as the CLI reads it, or undefined when it isn't one. */
const scalar = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;

/**
 * Where a job's field is written: the picked target's copy first, else the job's own. A job
 * field written in several places points at the target's, since that is the one added last.
 */
function jobFieldLocation(
  files: SourceFile[],
  locate: Locate,
  jobKey: string,
  field: string,
  options: JobStructureOptions,
): { location: YamlLocation; fromTarget: boolean } | undefined {
  const target = options.activeTarget;
  for (const fromTarget of target ? [true, false] : [false]) {
    for (const file of files) {
      const path = fromTarget
        ? ["targets", target!, "resources", "jobs", jobKey, field]
        : ["resources", "jobs", jobKey, field];
      const location = locate.get(file)!(path, "key");
      if (location) return { location, fromTarget };
    }
  }
  return undefined;
}

/** Where a task's field is written: the picked target's copy of the task first, else the job's own. */
function taskFieldLocation(
  files: SourceFile[],
  locate: Locate,
  jobKey: string,
  taskKey: string,
  field: (string | number)[],
  options: JobStructureOptions,
): YamlLocation | undefined {
  for (const fromTarget of [true, false]) {
    for (const file of files) {
      for (const tasks of jobLists(file.doc, "tasks")) {
        if (tasks.jobKey !== jobKey || (tasks.target !== undefined) !== fromTarget) continue;
        if (fromTarget && tasks.target !== options.activeTarget) continue;
        const target = tasks.target ?? options.activeTarget;
        for (const [index, task] of tasks.items.entries()) {
          if (taskIdOf(record(task).task_key, target, options) !== taskKey) continue;
          const found = locate.get(file)!([...tasks.path, index, ...field]);
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

/** Where a job parameter's `field` is written: the picked target's list first, else the job's own. */
function parameterLocation(
  files: SourceFile[],
  locate: Locate,
  jobKey: string,
  name: string,
  options: JobStructureOptions,
  field: "name" | "default" = "name",
): YamlLocation | undefined {
  for (const fromTarget of [true, false]) {
    for (const file of files) {
      for (const parameters of jobLists(file.doc, "parameters")) {
        if (parameters.jobKey !== jobKey || (parameters.target !== undefined) !== fromTarget) continue;
        if (fromTarget && parameters.target !== options.activeTarget) continue;
        const target = parameters.target ?? options.activeTarget;
        const index = parameters.items.findIndex((item) => keyOf(record(item).name, target, options) === name);
        const found = index >= 0 ? locate.get(file)!([...parameters.path, index, field]) : undefined;
        if (found) return found;
      }
    }
  }
  return undefined;
}

/**
 * Why a `for_each_task.inputs` string is not what deploy accepts, or undefined when it is.
 * Deploy takes a JSON array of plain values (strings, numbers, true or false, mixed freely)
 * or of objects, not both; a `null` item or a list inside the list is refused. `[]` deploys.
 */
export function forEachInputsProblem(inputs: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputs);
  } catch {
    return "is not valid JSON";
  }
  if (!Array.isArray(parsed)) return "is not a JSON array";
  if (parsed.some((item) => Array.isArray(item))) return "has a list inside the list";
  if (parsed.some((item) => item === null)) return "has null in the list";
  const objects = parsed.filter((item) => typeof item === "object").length;
  if (objects > 0 && objects < parsed.length) return "mixes objects with plain values";
  return undefined;
}

/**
 * `{{job.parameters.x}}` and `{{job.parameters.[x]}}`, spaces inside the braces allowed. The
 * name is what deploy looks up; a dot in it, even in brackets, is never found.
 */
const JOB_PARAMETER_REFERENCE = /\{\{\s*job\.parameters\.(?:\[([^\]]*)\]|([A-Za-z0-9_.-]+))\s*\}\}/g;

/** The job parameter names a text refers to, in order. */
export function jobParameterReferences(text: string): string[] {
  return [...text.matchAll(JOB_PARAMETER_REFERENCE)].map((match) => match[1] ?? match[2]!);
}

/**
 * The task fields deploy checks for `{{job.parameters.x}}`, as seen live (CLI v1.28.0). A
 * run_job_task's `job_parameters` and a task's `description` deploy with any name, so they,
 * and fields not tested, are left out: a missing finding beats a wrong one.
 */
function referenceFields(task: Record<string, unknown>): { path: (string | number)[]; text: string }[] {
  const fields: { path: (string | number)[]; text: string }[] = [];
  const add = (path: (string | number)[], value: unknown) => {
    if (typeof value === "string") fields.push({ path, text: value });
  };
  const listOf = (path: [string, string]) =>
    list(record(task[path[0]])[path[1]]).forEach((value, index) => add([...path, index], value));
  const mapOf = (path: [string, string]) =>
    Object.entries(record(record(task[path[0]])[path[1]])).forEach(([key, value]) => add([...path, key], value));
  mapOf(["notebook_task", "base_parameters"]);
  add(["condition_task", "left"], record(task.condition_task).left);
  add(["condition_task", "right"], record(task.condition_task).right);
  listOf(["spark_python_task", "parameters"]);
  listOf(["python_wheel_task", "parameters"]);
  mapOf(["python_wheel_task", "named_parameters"]);
  mapOf(["sql_task", "parameters"]);
  listOf(["dbt_task", "commands"]);
  add(["for_each_task", "inputs"], record(task.for_each_task).inputs);
  return fields;
}

const quotedList = (names: string[]) => names.map((name) => `"${name}"`).join(", ");

export function findJobSettingProblems(
  jobs: Record<string, unknown>,
  files: SourceFile[],
  options: JobStructureOptions = {},
): JobStructureFinding[] {
  const findings: JobStructureFinding[] = [];
  const locate: Locate = new Map(files.map((file) => [file, locator(file)]));
  const target = options.activeTarget;

  for (const [jobKey, job] of Object.entries(jobs)) {
    const settings = record(job);

    // An empty `schedule: {}` counts: deploy still refuses it beside a trigger. A value the
    // preview leaves as a variable could resolve to nothing, so only a written map counts.
    const triggers = TRIGGER_FIELDS.filter((field) => {
      const value = settings[field];
      return typeof value === "object" && value !== null && !Array.isArray(value);
    });
    if (triggers.length > 1) {
      const places = triggers.flatMap((field) => {
        const found = jobFieldLocation(files, locate, jobKey, field, options);
        return found ? [found] : [];
      });
      // Point at the setting that made it two: a target's, else the one written last.
      const fromTarget = places.filter((place) => place.fromTarget);
      const at = (fromTarget.length ? fromTarget : places).sort((a, b) => a.location.line - b.location.line).at(-1);
      findings.push({
        kind: "multiple_job_triggers",
        jobKey,
        subject: triggers.join("+"),
        title: `Keep only one of ${quoted(triggers)} on job "${jobKey}": a job can have one, so deploy may fail.`,
        fixHint: `Deploy fails with "Invalid trigger settings. One of 'schedule', 'trigger' or 'continuous' can be set." Remove all but one of them.`,
        ...located(at?.location),
      });
    }

    const reportedNames = new Set<string>();
    for (const parameter of list(settings.parameters)) {
      const name = keyOf(record(parameter).name, target, options);
      if (name === undefined || name === "" || PARAMETER_NAME.test(name) || reportedNames.has(name)) continue;
      reportedNames.add(name);
      findings.push({
        kind: "invalid_job_parameter_name",
        jobKey,
        subject: name,
        title: `Rename job parameter "${name}": names can only use letters, digits, "-", "_" and ".", so deploy may fail.`,
        fixHint: `Deploy fails with "The specified parameter name contains an invalid character, only alphanumeric, -, _ and . characters are permitted." Letters are A to Z only; spaces and accented letters are refused.`,
        ...located(parameterLocation(files, locate, jobKey, name, options)),
      });
    }

    const parameterNames = list(settings.parameters).map((parameter) => keyOf(record(parameter).name, target, options));
    // A name the preview can't resolve could be any name: no reference can be called unknown.
    const namesKnown = parameterNames.every((name) => name !== undefined);
    const known = parameterNames.filter((name): name is string => name !== undefined);

    for (const parameter of list(settings.parameters).map(record)) {
      const name = keyOf(parameter.name, target, options);
      const used = typeof parameter.default === "string" ? jobParameterReferences(parameter.default) : [];
      if (name === undefined || used.length === 0) continue;
      findings.push({
        kind: "job_parameter_in_default",
        jobKey,
        subject: name,
        title: `Remove {{job.parameters.${used[0]}}} from the default of job parameter "${name}": a default can't use another job parameter, so deploy may fail.`,
        fixHint: `Deploy fails with "Invalid reference in job parameter '${name}': 'job.parameters.${used[0]}' is not allowed." Other references, such as {{job.id}}, are allowed.`,
        ...located(parameterLocation(files, locate, jobKey, name, options, "default") ?? parameterLocation(files, locate, jobKey, name, options)),
      });
    }

    const tasks = list(settings.tasks).map(record);
    // A task whose key the preview leaves as `${...}` goes by that text, so its other
    // settings are still checked; only its own key is not judged.
    const keyed = new Map<string, Record<string, unknown>>();
    for (const task of tasks) {
      const taskKey = taskIdOf(task.task_key, target, options);
      if (taskKey !== undefined && !keyed.has(taskKey)) keyed.set(taskKey, task);
    }

    for (const [taskKey, task] of keyed) {
      const ownKey = keyOf(task.task_key, target, options);
      const inner = record(record(task.for_each_task).task);
      const innerKey = keyOf(inner.task_key, target, options);
      for (const [key, field] of [
        ...(ownKey !== undefined ? [[ownKey, ["task_key"]] as const] : []),
        ...(innerKey !== undefined ? [[innerKey, ["for_each_task", "task", "task_key"]] as const] : []),
      ] as const) {
        if (key === "" || TASK_KEY.test(key)) continue;
        findings.push({
          kind: "invalid_task_key",
          jobKey,
          taskKey,
          subject: field.length > 1 ? `${key}#inner` : key,
          title: `Rename task "${key}": task keys can only use letters, digits, "-" and "_", so deploy may fail.`,
          fixHint: `Deploy fails with "Task key '${key}' contains an invalid character. Only alphanumeric, - and _ characters are permitted." Letters are A to Z only; spaces, dots and accented letters are refused.`,
          ...located(taskFieldLocation(files, locate, jobKey, taskKey, [...field], options)),
        });
      }

      for (const dependency of list(task.depends_on).map(record)) {
        const upstream = keyOf(dependency.task_key, target, options);
        const outcome = scalar(dependency.outcome);
        if (upstream === undefined || outcome === undefined || outcome === "" || unresolved(outcome)) continue;
        const upstreamTask = keyed.get(upstream);
        // A dependency on a task the job doesn't have is unknown_task_dependency's finding.
        if (!upstreamTask) continue;
        const where = (field: "task_key" | "outcome") => dependencyLocation(files, locate, jobKey, taskKey, upstream, options, field);
        const location = where("outcome") ?? where("task_key");
        if (upstreamTask.condition_task === undefined || upstreamTask.condition_task === null) {
          findings.push({
            kind: "outcome_without_condition",
            jobKey,
            taskKey,
            subject: upstream,
            title: `Remove outcome "${outcome}" from the dependency on "${upstream}": only an if/else condition task has an outcome, so deploy may fail.`,
            fixHint: `Deploy fails with "The dependency on a non-if/else condition "${upstream}" specifies an outcome "${outcome}". Outcomes can only be specified for if/else condition dependencies."`,
            ...located(location),
          });
        } else if (!OUTCOMES.includes(outcome)) {
          findings.push({
            kind: "invalid_outcome",
            jobKey,
            taskKey,
            subject: upstream,
            title: `Change outcome "${outcome}" to "true" or "false": deploy may fail with any other value.`,
            fixHint: `Deploy fails with "The dependency on task "${upstream}" specifies invalid outcome "${outcome}". Valid values are "true" and "false"".`,
            ...located(location),
          });
        }
      }

      const inputs = record(task.for_each_task).inputs;
      // `{{job.parameters.x}}` and `{{tasks.x.values.y}}` are filled in when the job runs.
      if (typeof inputs === "string" && !unresolved(inputs) && !inputs.includes("{{")) {
        const problem = forEachInputsProblem(inputs);
        if (problem) {
          findings.push({
            kind: "for_each_inputs_not_array",
            jobKey,
            taskKey,
            subject: "inputs",
            title: `Make the inputs of task "${taskKey}" a JSON array, like ["a", "b"]: it ${problem}, so deploy may fail.`,
            fixHint: `Deploy fails with "The JSON string in the inputs field should be an array of primitives or objects." Use all plain values (text, numbers, true or false) or all objects, with no null and no list inside.`,
            ...located(taskFieldLocation(files, locate, jobKey, taskKey, ["for_each_task", "inputs"], options)),
          });
        }
      }

      // A for-each task's inner task is checked too; deploy names the inner task.
      const checked = [
        { prefix: [] as string[], fields: referenceFields(task), name: ownKey ?? taskKey },
        ...(Object.keys(inner).length
          ? [{ prefix: ["for_each_task", "task"], fields: referenceFields(inner).filter((f) => f.path[0] !== "for_each_task"), name: innerKey ?? taskKey }]
          : []),
      ];
      const reported = new Set<string>();
      for (const { prefix, fields, name: inTask } of checked) {
        for (const { path, text } of fields) {
          for (const name of jobParameterReferences(text)) {
            const dotted = name.includes(".");
            if (!dotted && (!namesKnown || known.includes(name))) continue;
            const kind = dotted ? "job_parameter_reference_with_dot" : "unknown_job_parameter";
            if (reported.has(`${kind}\u0000${name}\u0000${prefix.length}`)) continue;
            reported.add(`${kind}\u0000${name}\u0000${prefix.length}`);
            const location = located(taskFieldLocation(files, locate, jobKey, taskKey, [...prefix, ...path], options));
            if (dotted) {
              findings.push({
                kind,
                jobKey,
                taskKey,
                subject: `${name}${prefix.length ? "#inner" : ""}`,
                title: `Use a job parameter name without a dot in {{job.parameters.${name}}}: Databricks can't read the dot, so deploy may fail.`,
                fixHint: `Deploy fails with "Invalid reference: 'job.parameters.${name}'. 'parameters' is unknown.", even when a parameter named "${name}" exists, and in brackets too. Rename the parameter, for example to "${name.replace(/\./g, "_")}".`,
                ...location,
              });
              continue;
            }
            const suggestion = closestName(name, known);
            findings.push({
              kind,
              jobKey,
              taskKey,
              subject: `${name}${prefix.length ? "#inner" : ""}`,
              title: `Job parameter "${name}" may not exist.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
              fixHint: `Deploy fails with "Reference 'job.parameters.${name}' in task '${inTask}' refers to an undefined job parameter '${name}'". Add "${name}" to job "${jobKey}"'s parameters${known.length ? `, or use one of ${quotedList(known)}` : ""}. Letter case counts.`,
              ...location,
            });
          }
        }
      }
    }
  }
  return findings;
}
