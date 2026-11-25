import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import { findJobSettingProblems, forEachInputsProblem } from "../../../bundle/jobSettings.js";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";
import type { JobStructureOptions } from "../../../bundle/jobStructure.js";

// Cases from the live tests in #237 (Databricks CLI v1.28.0, 2026-11-25): each passes
// `bundle validate`; the ones reported fail `bundle deploy`, the others deploy.

const sourceFile = (text: string, file = "/b/databricks.yml") => ({
  file,
  doc: parse(text, { merge: true }),
  text,
  locations: parseYamlLocations(file, text),
});
/** Checks `jobs` (as the CLI resolved them) against the YAML as written. */
const check = (text: string, options: JobStructureOptions = {}, jobs?: Record<string, unknown>) => {
  const file = sourceFile(text);
  return findJobSettingProblems(jobs ?? (file.doc as any).resources.jobs, [file], options);
};
const summary = (findings: { kind: string; title: string; location?: { line: number } }[]) =>
  findings.map((f) => `${f.kind} @${f.location?.line ?? "-"}: ${f.title}`);
const kinds = (findings: { kind: string }[]) => findings.map((f) => f.kind);

const NB = "notebook_task: { notebook_path: ./nb.py }";
const SCHEDULE = 'schedule: { quartz_cron_expression: "0 0 1 * * ?", timezone_id: UTC }';
const TRIGGER = "trigger: { periodic: { interval: 1, unit: DAYS } }";
const CONTINUOUS = "continuous: { pause_status: PAUSED }";

describe("multiple_job_triggers", () => {
  test.each([
    ["schedule and trigger", [SCHEDULE, TRIGGER], "schedule and trigger"],
    ["schedule and continuous", [SCHEDULE, CONTINUOUS], "schedule and continuous"],
    ["trigger and continuous", [TRIGGER, CONTINUOUS], "trigger and continuous"],
    ["all three", [SCHEDULE, TRIGGER, CONTINUOUS], "schedule, trigger and continuous"],
    ["an empty schedule beside a trigger", ["schedule: {}", TRIGGER], "schedule and trigger"],
  ])("%s fails deploy", (_case, fields, named) => {
    const findings = check(`resources:\n  jobs:\n    j:\n${fields.map((f) => `      ${f}\n`).join("")}`);
    expect(summary(findings)).toEqual([
      `multiple_job_triggers @${3 + fields.length}: Keep only one of ${named} on job "j": a job can have one, so deploy may fail.`,
    ]);
    expect(findings[0]!.fixHint).toContain("Invalid trigger settings. One of 'schedule', 'trigger' or 'continuous' can be set.");
  });

  test.each([
    ["one alone", [SCHEDULE]],
    ["an empty `schedule:` beside a trigger (deploys)", ["schedule:", TRIGGER]],
    ["a schedule from a variable the preview leaves unresolved", ["schedule: ${var.schedule}", TRIGGER]],
  ])("%s is not reported", (_case, fields) => {
    expect(check(`resources:\n  jobs:\n    j:\n${fields.map((f) => `      ${f}\n`).join("")}`)).toEqual([]);
  });

  test("points at the key of the one written last", () => {
    const findings = check(`resources:\n  jobs:\n    j:\n      trigger:\n        periodic: { interval: 1, unit: DAYS }\n      schedule:\n        quartz_cron_expression: "0 0 1 * * ?"\n`);
    expect(findings[0]!.location?.line).toBe(6);
  });

  test("a trigger the picked target adds points at the target's", () => {
    const text = `
resources:
  jobs:
    j:
      ${SCHEDULE}
targets:
  prod:
    resources:
      jobs:
        j:
          ${TRIGGER}
`;
    const resolved = { j: { schedule: {}, trigger: {} } };
    expect(summary(check(text, { activeTarget: "prod" }, resolved))).toEqual([
      'multiple_job_triggers @11: Keep only one of schedule and trigger on job "j": a job can have one, so deploy may fail.',
    ]);
  });
});

describe("invalid_job_parameter_name", () => {
  const job = (name: string) => `resources:\n  jobs:\n    j:\n      parameters:\n        - name: ${name}\n          default: x\n`;

  test.each([["a space", "'bad name'"], ["a dollar", "'a$b'"], ["an accented letter", "café"]])("%s fails deploy", (_case, name) => {
    const findings = check(job(name));
    expect(kinds(findings)).toEqual(["invalid_job_parameter_name"]);
    expect(findings[0]!.location?.line).toBe(5);
    expect(findings[0]!.fixHint).toContain("only alphanumeric, -, _ and . characters are permitted");
  });

  test.each([["letters, digits, - _ .", "a_b-c.d"], ["a leading dot", "'.a'"], ["a number", "1"], ["a variable", "${var.name}"]])(
    "%s deploys",
    (_case, name) => expect(check(job(name))).toEqual([]),
  );

  test("a name from a variable is checked as it resolves", () => {
    const findings = check(job("${var.name}"), { resolve: (value) => (value === "${var.name}" ? "bad name" : undefined) });
    expect(summary(findings)).toEqual([
      'invalid_job_parameter_name @5: Rename job parameter "bad name": names can only use letters, digits, "-", "_" and ".", so deploy may fail.',
    ]);
  });

  test("a name the picked target declares points at the target's list", () => {
    const text = `
resources:
  jobs:
    j:
      parameters: [{ name: ok, default: x }]
targets:
  prod:
    resources:
      jobs:
        j:
          parameters:
            - name: bad name
`;
    const resolved = { j: { parameters: [{ name: "ok" }, { name: "bad name" }] } };
    expect(check(text, { activeTarget: "prod" }, resolved)[0]!.location?.line).toBe(12);
  });
});

describe("invalid_task_key", () => {
  const job = (key: string) => `resources:\n  jobs:\n    j:\n      tasks:\n        - task_key: ${key}\n          ${NB}\n`;

  test.each([["a trailing space", "'load '"], ["a dot", "lo.ad"], ["an accented letter", "café"]])("%s fails deploy", (_case, key) => {
    const findings = check(job(key));
    expect(kinds(findings)).toEqual(["invalid_task_key"]);
    expect(findings[0]!.location?.line).toBe(5);
    expect(findings[0]!.fixHint).toContain("Only alphanumeric, - and _ characters are permitted.");
  });

  test.each([["letters, digits, - and _", "lo-ad_1"], ["only a dash", "'-'"], ["a number", "1"], ["a variable", "${var.key}"]])(
    "%s deploys",
    (_case, key) => expect(check(job(key))).toEqual([]),
  );

  test("a for-each task's inner task is checked, and belongs to the outer task", () => {
    const findings = check(`
resources:
  jobs:
    j:
      tasks:
        - task_key: loop
          for_each_task:
            inputs: "[1]"
            task:
              task_key: in ner
              ${NB}
`);
    expect(findings.map((f) => [f.kind, f.taskKey, f.location?.line])).toEqual([["invalid_task_key", "loop", 10]]);
    expect(findings[0]!.title).toContain('Rename task "in ner"');
  });
});

describe("outcome_without_condition and invalid_outcome", () => {
  const job = (outcome: string, upstream = "condition_task: { op: EQUAL_TO, left: x, right: x }") => `
resources:
  jobs:
    j:
      tasks:
        - task_key: up
          ${upstream}
        - task_key: down
          depends_on:
            - task_key: up
              outcome: ${outcome}
          ${NB}
`;

  test("an outcome on a task that is not a condition fails deploy", () => {
    const findings = check(job('"true"', NB));
    expect(summary(findings)).toEqual([
      'outcome_without_condition @11: Remove outcome "true" from the dependency on "up": only an if/else condition task has an outcome, so deploy may fail.',
    ]);
    expect(findings[0]!.fixHint).toContain("Outcomes can only be specified for if/else condition dependencies.");
  });

  test.each([["maybe", '"maybe"'], ["a capital letter", '"True"']])("%s on a condition task fails deploy", (_case, outcome) => {
    const findings = check(job(outcome));
    expect(kinds(findings)).toEqual(["invalid_outcome"]);
    expect(findings[0]!.fixHint).toContain('Valid values are "true" and "false"');
  });

  test.each([
    ['"true"', '"true"'],
    ['"false"', '"false"'],
    ["unquoted true (the CLI reads it as \"true\")", "true"],
    ["a variable", "${var.outcome}"],
  ])("%s on a condition task deploys", (_case, outcome) => expect(check(job(outcome))).toEqual([]));

  test("a variable or an unknown upstream task is not judged", () => {
    expect(check(job("${var.outcome}", NB))).toEqual([]);
    expect(check(job('"true"').replace("task_key: up\n          condition", "task_key: other\n          condition"))).toEqual([]);
  });
});

describe("for_each_inputs_not_array", () => {
  test.each([
    ["not json", "is not valid JSON"],
    ['{"a": 1}', "is not a JSON array"],
    ['"a"', "is not a JSON array"],
    ["[[1, 2]]", "has a list inside the list"],
    ['[[1, 2], {"a": 1}]', "has a list inside the list"],
    ["[null]", "has null in the list"],
    ["[null, 1]", "has null in the list"],
    ['["a", {"k": "v"}]', "mixes objects with plain values"],
    ['["a", 1, 2.5, {"k": "v"}]', "mixes objects with plain values"],
  ])("%s fails deploy", (inputs, problem) => expect(forEachInputsProblem(inputs)).toBe(problem));

  test.each([
    "[1, 2]",
    "[]",
    "  [1, 2]  ",
    "[true, false]",
    '["a", 1]',
    "[1, 2.5]",
    '["a", true]',
    '[{"a": 1}, {"b": [1, 2]}]',
    '[{"a": null}]',
  ])("%s deploys", (inputs) => expect(forEachInputsProblem(inputs)).toBeUndefined());

  const job = (inputs: string) =>
    `resources:\n  jobs:\n    j:\n      tasks:\n        - task_key: loop\n          for_each_task:\n            inputs: '${inputs}'\n            task: { task_key: i, ${NB} }\n`;

  test("is reported at the inputs line", () => {
    expect(summary(check(job("not json")))).toEqual([
      'for_each_inputs_not_array @7: Make the inputs of task "loop" a JSON array, like ["a", "b"]: it is not valid JSON, so deploy may fail.',
    ]);
  });

  test.each(["{{job.parameters.items}}", "{{tasks.up.values.items}}", "${var.items}"])("%s is filled in later, not judged", (inputs) =>
    expect(check(job(inputs))).toEqual([]),
  );
});
