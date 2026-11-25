import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import { findJobSettingProblems, forEachInputsProblem, jobParameterReferences } from "../../../bundle/jobSettings.js";
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

  test.each([
    ["letters, digits, - and _", "lo-ad_1"],
    ["only a dash", "'-'"],
    ["a number", "1"],
    ["a variable", "${var.key}"],
    ["100 characters", "k".repeat(100)],
  ])(
    "%s deploys",
    (_case, key) => expect(check(job(key))).toEqual([]),
  );

  test("an empty key fails deploy", () => {
    const findings = check(job('""'));
    expect(summary(findings)).toEqual(['invalid_task_key @5: Give the task in job "j" a task key: deploy may fail when it is empty.']);
    expect(findings[0]!.fixHint).toContain("Missing required field: settings.tasks.task_key.");
  });

  test("a key over 100 characters fails deploy", () => {
    const findings = check(job("k".repeat(101)));
    expect(summary(findings)).toEqual([
      `invalid_task_key @5: Shorten task key "${"k".repeat(24)}…": it has 101 characters and the limit is 100, so deploy may fail.`,
    ]);
    expect(findings[0]!.fixHint).toContain("exceeds the maximum allowed length of 100 characters.");
  });

  test("a key from a variable keeps the graph's name for the task", () => {
    // The graph names the task `${var.key}`, as the structural preview prints it; the check uses the value.
    const findings = check(job("${var.key}"), { resolve: (value) => (value === "${var.key}" ? "bad key" : undefined) });
    expect(findings.map((f) => [f.kind, f.taskKey, f.title])).toEqual([
      ["invalid_task_key", "${var.key}", 'Rename task "bad key": task keys can only use letters, digits, "-" and "_", so deploy may fail.'],
    ]);
  });

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

  test("a task whose key the preview leaves as a variable still has its other settings checked", () => {
    // The structural preview prints `task_key: ${var.key}` as written; the graph names the task by that text.
    const findings = check(`
resources:
  jobs:
    j:
      tasks:
        - task_key: \${var.key}
          for_each_task:
            inputs: 'not json'
            task:
              task_key: bad key
              ${NB}
`);
    expect(findings.map((f) => [f.kind, f.taskKey, f.location?.line])).toEqual([
      ["invalid_task_key", "${var.key}", 10],
      ["for_each_inputs_not_array", "${var.key}", 8],
    ]);
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

  test("an outcome the picked target writes again points at the target's, not the job's valid one", () => {
    const text = `
resources:
  jobs:
    j:
      tasks:
        - task_key: up
          condition_task: { op: EQUAL_TO, left: x, right: x }
        - task_key: down
          depends_on: [{ task_key: up, outcome: "true" }]
          ${NB}
targets:
  prod:
    resources:
      jobs:
        j:
          tasks:
            - task_key: down
              depends_on: [{ task_key: up, outcome: "True" }]
`;
    // As `bundle validate -t prod` printed it on CLI v1.28.0: the target's entry is added after the job's.
    const resolved = {
      j: {
        tasks: [
          { task_key: "up", condition_task: {} },
          { task_key: "down", depends_on: [{ task_key: "up", outcome: "true" }, { task_key: "up", outcome: "True" }] },
        ],
      },
    };
    const findings = check(text, { activeTarget: "prod" }, resolved);
    expect(findings.map((f) => [f.kind, f.location?.line])).toEqual([["invalid_outcome", 18]]);
  });

  const twice = (first: string, second: string) => `
resources:
  jobs:
    j:
      tasks:
        - task_key: up
          condition_task: { op: EQUAL_TO, left: x, right: x }
        - task_key: down
          depends_on:
            - { task_key: up, outcome: ${first} }
            - { task_key: up, outcome: ${second} }
          ${NB}
`;

  test("a second dependency on the same task points at its own line", () => {
    expect(check(twice('"true"', '"True"')).map((f) => [f.kind, f.location?.line])).toEqual([["invalid_outcome", 11]]);
  });

  test("two wrong outcomes on the same task are two findings, told apart", () => {
    const findings = check(twice('"TRUE"', '"True"'));
    expect(findings.map((f) => [f.kind, f.location?.line])).toEqual([
      ["invalid_outcome", 10],
      ["invalid_outcome", 11],
    ]);
    expect(new Set(findings.map((f) => f.subject)).size).toBe(2);
  });

  test("a variable or an unknown upstream task is not judged", () => {
    expect(check(job("${var.outcome}", NB))).toEqual([]);
    expect(check(job('"true"').replace("task_key: up\n          condition", "task_key: other\n          condition"))).toEqual([]);
  });
});

describe("tasks that share a key", () => {
  // The CLI merges them into one task, the later settings winning (CLI v1.28.0: deploy fails
  // with the later inputs "not json", and deploys with the later inputs "[1]").
  const tasks = (first: string, second: string) => `
resources:
  jobs:
    j:
      tasks:
        - task_key: loop
          for_each_task: { inputs: '${first}', task: { task_key: i, ${NB} } }
        - task_key: loop
          for_each_task: { inputs: '${second}', task: { task_key: i, ${NB} } }
`;

  test("the later task's inputs are the ones checked, at its line", () => {
    expect(check(tasks("[1]", "not json")).map((f) => [f.kind, f.location?.line])).toEqual([["for_each_inputs_not_array", 9]]);
  });

  test("a later task that fixes the inputs leaves no error", () => {
    expect(check(tasks("not json", "[1]"))).toEqual([]);
  });

  test("their dependencies are joined", () => {
    const findings = check(`
resources:
  jobs:
    j:
      tasks:
        - task_key: up
          condition_task: { op: EQUAL_TO, left: x, right: x }
        - task_key: down
          depends_on: [{ task_key: up, outcome: "true" }]
        - task_key: down
          depends_on: [{ task_key: up, outcome: "True" }]
          ${NB}
`);
    expect(findings.map((f) => [f.kind, f.location?.line])).toEqual([["invalid_outcome", 11]]);
  });
});

describe("for_each_inputs_too_long", () => {
  const job = (inputs: string) =>
    `resources:\n  jobs:\n    j:\n      tasks:\n        - task_key: loop\n          for_each_task:\n            inputs: '${inputs}'\n            task: { task_key: i, ${NB} }\n`;
  // ["xxx…"]: 4 characters around the text.
  const list = (length: number) => JSON.stringify(["x".repeat(length - 4)]);

  test("over 5000 characters fails deploy", () => {
    const findings = check(job(list(5001)));
    expect(summary(findings)).toEqual([
      'for_each_inputs_too_long @7: Shorten the inputs of task "loop": they have 5001 characters and the limit is 5000, so deploy may fail.',
    ]);
    expect(findings[0]!.fixHint).toContain("Invalid inputs: cannot exceed 5000 characters");
  });

  test("5000 characters deploys", () => expect(check(job(list(5000)))).toEqual([]));

  test("text that is long and not an array is reported once, as not an array", () => {
    expect(kinds(check(job("x".repeat(5001))))).toEqual(["for_each_inputs_not_array"]);
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
    expect(kinds(check(job(inputs))).filter((kind) => kind === "for_each_inputs_not_array")).toEqual([]),
  );
});

describe("job parameter references", () => {
  test.each([
    ["{{job.parameters.env}}", ["env"]],
    ["{{ job.parameters.env }}", ["env"]],
    ["{{job.parameters.[env]}}", ["env"]],
    ["{{job.parameters.a-b}}", ["a-b"]],
    ["{{job.parameters.a.b}}", ["a.b"]],
    ["{{job.parameters.[a.b]}}", ["a.b"]],
    ["pre-{{job.parameters.a}}-{{job.parameters.b}}-post", ["a", "b"]],
    ["{{job.id}} {{tasks.up.values.x}}", []],
    ["${job.parameters.env}", []],
  ])("%s refers to %j", (text, names) => expect(jobParameterReferences(text)).toEqual(names));

  const job = (task: string, parameters = "[{ name: env, default: dev }]") =>
    `resources:\n  jobs:\n    j:\n      parameters: ${parameters}\n      tasks:\n        - task_key: a\n${task}`;
  const REF = '"{{job.parameters.nope}}"';

  test.each([
    ["notebook base_parameters", `          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF} } }\n`],
    ["condition left", `          condition_task: { op: EQUAL_TO, left: ${REF}, right: x }\n`],
    ["condition right", `          condition_task: { op: EQUAL_TO, left: x, right: ${REF} }\n`],
    ["Python script parameters", `          spark_python_task: { python_file: ./main.py, parameters: [${REF}] }\n`],
    ["wheel parameters", `          python_wheel_task: { package_name: p, entry_point: e, parameters: [${REF}] }\n`],
    ["wheel named_parameters", `          python_wheel_task: { package_name: p, entry_point: e, named_parameters: { p: ${REF} } }\n`],
    ["SQL parameters", `          sql_task: { warehouse_id: w, file: { path: ./q.sql }, parameters: { p: ${REF} } }\n`],
    ["dbt commands", `          dbt_task: { commands: ["dbt run --vars {{job.parameters.nope}}"] }\n`],
    ["for-each inputs", `          for_each_task: { inputs: ${REF}, task: { task_key: i, ${NB} } }\n`],
    ["the for-each inner task", `          for_each_task: { inputs: "[1]", task: { task_key: i, notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF} } } } }\n`],
  ])("an unknown name in %s fails deploy", (_case, task) => {
    const findings = check(job(task));
    expect(summary(findings)).toEqual(['unknown_job_parameter @7: Job parameter "nope" may not exist.']);
    expect(findings[0]!.fixHint).toContain("refers to an undefined job parameter 'nope'");
    expect(findings[0]!.taskKey).toBe("a");
  });

  test("the fix hint names the inner task, as deploy does", () => {
    const findings = check(job(`          for_each_task: { inputs: "[1]", task: { task_key: inner, notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF} } } } }\n`));
    expect(findings[0]!.fixHint).toContain("in task 'inner'");
  });

  test.each([
    ["a run_job_task's job_parameters (deploys)", `          run_job_task: { job_id: 1, job_parameters: { x: ${REF} } }\n`],
    ["a description (deploys)", `          description: ${REF}\n          ${NB}\n`],
    ["a field not tested live", `          spark_jar_task: { main_class_name: M, parameters: [${REF}] }\n`],
  ])("%s is not reported", (_case, task) => expect(check(job(task))).toEqual([]));

  test.each([
    ["a defined name", "{{job.parameters.env}}"],
    ["spaces inside the braces", "{{ job.parameters.env }}"],
    ["brackets", "{{job.parameters.[env]}}"],
    ["another kind of reference", "{{job.id}}"],
  ])("%s deploys", (_case, ref) =>
    expect(check(job(`          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: "${ref}" } }\n`))).toEqual([]),
  );

  test("letter case counts, and a close name is suggested", () => {
    expect(summary(check(job(`          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: "{{job.parameters.Env}}" } }\n`)))).toEqual([
      'unknown_job_parameter @7: Job parameter "Env" may not exist. Did you mean "env"?',
    ]);
  });

  test("a job with no parameters fails too", () => {
    expect(kinds(check(job(`          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF} } }\n`, "[]")))).toEqual([
      "unknown_job_parameter",
    ]);
  });

  test("a name used twice in a task is reported once", () => {
    const task = `          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF}, q: ${REF} } }\n`;
    expect(kinds(check(job(task)))).toEqual(["unknown_job_parameter"]);
  });

  test("a parameter name the preview can't resolve stops the check", () => {
    const task = `          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF} } }\n`;
    expect(check(job(task, "[{ name: '${var.p}', default: x }]"))).toEqual([]);
    expect(kinds(check(job(task, "[{ name: '${var.p}', default: x }]"), { resolve: () => "other" }))).toEqual(["unknown_job_parameter"]);
    expect(check(job(task, "[{ name: '${var.p}', default: x }]"), { resolve: () => "nope" })).toEqual([]);
  });

  test("a task whose key is a variable keeps the graph's name for it", () => {
    // The graph names the task `${var.key}`, as the structural preview prints it.
    const text = `resources:\n  jobs:\n    j:\n      parameters: [{ name: env, default: dev }]\n      tasks:\n        - task_key: \${var.key}\n          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF} } }\n`;
    const findings = check(text, { resolve: (value) => (value === "${var.key}" ? "load" : undefined) });
    expect(findings.map((f) => [f.kind, f.taskKey])).toEqual([["unknown_job_parameter", "${var.key}"]]);
  });

  test("a parameter a target adds counts", () => {
    const text = job(`          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: ${REF} } }\n`);
    const resolved = { j: { parameters: [{ name: "env" }, { name: "nope" }], tasks: [{ task_key: "a", notebook_task: { base_parameters: { p: "{{job.parameters.nope}}" } } }] } };
    expect(check(text, { activeTarget: "prod" }, resolved)).toEqual([]);
  });

  describe("job_parameter_reference_with_dot", () => {
    test.each([
      ["a defined dotted name", "{{job.parameters.a.b}}"],
      ["a dotted name in brackets", "{{job.parameters.[a.b]}}"],
      ["a key under a parameter", "{{job.parameters.env.x}}"],
    ])("%s fails deploy", (_case, ref) => {
      const findings = check(
        job(`          notebook_task: { notebook_path: ./nb.py, base_parameters: { p: "${ref}" } }\n`, "[{ name: env, default: x }, { name: a.b, default: x }]"),
      );
      expect(kinds(findings)).toEqual(["job_parameter_reference_with_dot"]);
      expect(findings[0]!.fixHint).toContain("'parameters' is unknown");
    });
  });

  describe("job_parameter_in_default", () => {
    test("a default that uses another job parameter fails deploy, even a defined one", () => {
      const findings = check(job(`          ${NB}\n`, '\n        - { name: env, default: dev }\n        - { name: copy, default: "{{job.parameters.env}}" }'));
      expect(summary(findings)).toEqual([
        'job_parameter_in_default @6: Remove {{job.parameters.env}} from the default of job parameter "copy": a default can\'t use another job parameter, so deploy may fail.',
      ]);
      expect(findings[0]!.fixHint).toContain("is not allowed");
    });

    test("another reference in a default deploys", () => {
      expect(check(job(`          ${NB}\n`, '[{ name: id, default: "{{job.id}}" }]'))).toEqual([]);
    });
  });
});
