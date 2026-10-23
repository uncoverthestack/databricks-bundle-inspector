import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import { findDependencyProblems, findDuplicateKeys } from "../../../bundle/jobStructure.js";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";

const task = (key: string, ...upstream: string[]) => ({
  task_key: key,
  ...(upstream.length ? { depends_on: upstream.map((u) => ({ task_key: u })) } : {}),
});
const job = (...tasks: object[]) => ({ tasks });
const kinds = (findings: { kind: string; taskKey?: string }[]) => findings.map((f) => `${f.kind}:${f.taskKey ?? ""}`);

describe("dependencies on unknown tasks", () => {
  test("suggests a close task key", () => {
    const [finding] = findDependencyProblems({ j: job(task("load"), task("report", "laod")) }, []);
    expect(finding).toMatchObject({ kind: "unknown_task_dependency", jobKey: "j", taskKey: "report" });
    expect(finding!.title).toContain('Did you mean "load"?');
  });

  test("names the job that has the key, and makes no guess when nothing is close", () => {
    const findings = findDependencyProblems(
      { first: job(task("only_here")), second: job(task("wait", "only_here"), task("other", "zzzzzzzz")) },
      [],
    );
    expect(findings[0]!.title).toContain('which is a task of job "first"');
    expect(findings[1]!.title).not.toContain("Did you mean");
  });

  test("reports a missing key once, even when the task is listed twice", () => {
    expect(findDependencyProblems({ j: job(task("a", "nope"), task("a", "nope")) }, [])).toHaveLength(1);
  });

  test("ignores depends_on entries without a task_key, as the CLI drops a plain-text entry", () => {
    expect(findDependencyProblems({ j: job({ task_key: "a", depends_on: ["b", {}] }) }, [])).toEqual([]);
  });
});

describe("dependency loops", () => {
  test("a task that depends on itself", () => {
    const findings = findDependencyProblems({ j: job(task("a", "a")) }, []);
    expect(kinds(findings)).toEqual(["task_dependency_loop:a"]);
    expect(findings[0]!.title).toBe('Task "a" depends on itself, so it can never start.');
  });

  test("a loop of three, reported on each of its tasks in job order, not on a task after it", () => {
    const findings = findDependencyProblems(
      { j: job(task("a", "c"), task("b", "a"), task("c", "b"), task("after", "c"), task("before")) },
      [],
    );
    expect(kinds(findings).sort()).toEqual(["task_dependency_loop:a", "task_dependency_loop:b", "task_dependency_loop:c"]);
    expect(findings[0]!.title).toBe('Tasks "a", "b" and "c" depend on each other in a loop, so none of them can start.');
  });

  test("two separate loops in one job", () => {
    const findings = findDependencyProblems({ j: job(task("a", "b"), task("b", "a"), task("c", "d"), task("d", "c")) }, []);
    expect(new Set(findings.map((f) => f.title)).size).toBe(2);
  });

  test("no finding for chains, fan-outs, diamonds and an upstream listed twice", () => {
    const fanOut = Array.from({ length: 50 }, (_, i) => task(`leaf${i}`, "root"));
    expect(
      findDependencyProblems(
        {
          chain: job(task("a"), task("b", "a"), task("c", "b")),
          fan: job(task("root"), ...fanOut, task("join", ...fanOut.map((t) => t.task_key))),
          diamond: job(task("a"), task("b", "a"), task("c", "a"), task("d", "b", "c")),
          repeated: job(task("a"), task("b", "a", "a")),
        },
        [],
      ),
    ).toEqual([]);
  });

  test("a 1000-task chain and a 1000-task loop, without deep recursion", () => {
    const chain = Array.from({ length: 1000 }, (_, i) => task(`t${i}`, ...(i ? [`t${i - 1}`] : [])));
    const loop = Array.from({ length: 1000 }, (_, i) => task(`t${i}`, `t${(i + 999) % 1000}`));
    const started = Date.now();
    expect(findDependencyProblems({ chain: job(...chain) }, [])).toEqual([]);
    expect(findDependencyProblems({ loop: job(...loop) }, [])).toHaveLength(1000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("duplicate task keys and job parameters", () => {
  const files = (text: string) => [
    { file: "/b/databricks.yml", doc: parse(text), text, locations: parseYamlLocations("/b/databricks.yml", text) },
  ];

  test("a key repeated in one list, at the second copy, naming the first's line", () => {
    const [finding] = findDuplicateKeys(
      files(["resources:", "  jobs:", "    j:", "      tasks:", "        - task_key: same", "        - task_key: same"].join("\n")),
    );
    expect(finding).toMatchObject({ kind: "duplicate_task_key", jobKey: "j", taskKey: "same", location: { line: 6 } });
    expect(finding!.fixHint).toContain("The first is on line 5.");
  });

  test("a job parameter declared twice", () => {
    expect(
      kinds(
        findDuplicateKeys(
          files(["resources:", "  jobs:", "    j:", "      parameters:", "        - name: env", "          default: a", "        - name: env", "          default: b"].join("\n")),
        ),
      ),
    ).toEqual(["duplicate_job_parameter:"]);
  });

  test("a target overriding a job's task or parameter is not a duplicate, a repeat inside the target's list is", () => {
    const findings = findDuplicateKeys(
      files(
        [
          "resources:",
          "  jobs:",
          "    j:",
          "      parameters: [{name: env, default: base}]",
          "      tasks: [{task_key: load}]",
          "targets:",
          "  dev:",
          "    resources:",
          "      jobs:",
          "        j:",
          "          parameters: [{name: env, default: dev}]",
          "          tasks: [{task_key: load, max_retries: 3}]",
          "  prod:",
          "    resources:",
          "      jobs:",
          "        j:",
          "          tasks: [{task_key: load}, {task_key: load}]",
        ].join("\n"),
      ),
    );
    expect(kinds(findings)).toEqual(["duplicate_task_key:load"]);
    expect(findings[0]!.location?.line).toBe(17);
  });

  test("the same task key in two jobs is fine", () => {
    expect(
      findDuplicateKeys(files(["resources:", "  jobs:", "    a: {tasks: [{task_key: load}]}", "    b: {tasks: [{task_key: load}]}"].join("\n"))),
    ).toEqual([]);
  });
});

// Review findings on PR #240, each reproduced with the Databricks CLI before the fix.
describe("review findings", () => {
  const sourceFile = (text: string, file = "/b/databricks.yml") => ({ file, doc: parse(text, { merge: true }), text, locations: parseYamlLocations(file, text) });
  // As the inspector resolves `${var...}` with the bundle's defaults; `${resources...}` stays unknown.
  const resolve = (value: string) => (value.includes("${var.") ? value.replace(/\$\{var\.(\w+)\}/g, (_m, name: string) => ({ k: "same", p: "env", up: "a" })[name] ?? `\${var.${name}}`) : value);

  test("keys that resolve to the same value are duplicates, as the CLI merges them after resolving", () => {
    const findings = findDuplicateKeys(
      [sourceFile(["resources:", "  jobs:", "    j:", "      parameters: [{name: env}, {name: '${var.p}'}]", "      tasks: [{task_key: same}, {task_key: '${var.k}'}]"].join("\n"))],
      { resolve },
    );
    expect(kinds(findings).sort()).toEqual(["duplicate_job_parameter:", "duplicate_task_key:same"]);
    expect(findings.find((f) => f.kind === "duplicate_task_key")!.title).toContain('("${var.k}" resolves to "same")');
  });

  test("a dependency written with a variable is read as its value, and an unresolvable task key makes no guess", () => {
    expect(findDependencyProblems({ j: job(task("a"), task("b", "${var.up}")) }, [], { resolve })).toEqual([]);
    expect(findDependencyProblems({ j: job(task("${resources.jobs.x.name}"), task("b", "a")) }, [], { resolve })).toEqual([]);
  });

  test("with a target picked, a dependency opens in that target, not another one", () => {
    const text = [
      "resources:", "  jobs:", "    j:", "      tasks: [{task_key: a}]",
      "targets:",
      "  prod:", "    resources:", "      jobs:", "        j:", "          tasks:", "            - task_key: a", "              depends_on: [{task_key: gone}]",
      "  dev:", "    resources:", "      jobs:", "        j:", "          tasks:", "            - task_key: a", "              depends_on: [{task_key: gone}]",
    ].join("\n");
    const jobs = { j: job(task("a", "gone")) };
    expect(findDependencyProblems(jobs, [sourceFile(text)], { activeTarget: "dev" })[0]!.location?.line).toBe(19);
    expect(findDependencyProblems(jobs, [sourceFile(text)], { activeTarget: "prod" })[0]!.location?.line).toBe(12);
  });

  test("a task written through a YAML anchor still has a location: where the anchor writes it", () => {
    const text = [
      "definitions:", "  t: &t", "    task_key: x", "    depends_on: [{task_key: missing}]",
      "resources:", "  jobs:", "    j:", "      tasks:", "        - *t",
    ].join("\n");
    expect(findDependencyProblems({ j: job(task("x", "missing")) }, [sourceFile(text)])[0]!.location).toEqual({ file: "/b/databricks.yml", line: 4, column: 29 });
  });

  test("a dependency in the second copy of a repeated task key opens the second copy", () => {
    const text = ["resources:", "  jobs:", "    j:", "      tasks:", "        - task_key: r", "        - task_key: r", "          depends_on: [{task_key: only_here}]"].join("\n");
    expect(findDependencyProblems({ j: job(task("r"), task("r", "only_here")) }, [sourceFile(text)])[0]!.location?.line).toBe(7);
  });

  test("two missing dependencies on one line are told apart by their subject", () => {
    const text = ["resources:", "  jobs:", "    j:", "      tasks: [{task_key: f, depends_on: [{task_key: m1}, {task_key: m2}]}]"].join("\n");
    const findings = findDependencyProblems({ j: job(task("f", "m1", "m2")) }, [sourceFile(text)]);
    expect(findings.map((f) => f.subject)).toEqual(["m1", "m2"]);
    expect(new Set(findings.map((f) => `${f.location?.line}:${f.location?.column}`)).size).toBe(2);
  });

  test("a duplicate in a target's own list names that target", () => {
    const text = ["targets:", "  prod:", "    resources:", "      jobs:", "        j:", "          tasks: [{task_key: d}, {task_key: d}]"].join("\n");
    expect(findDuplicateKeys([sourceFile(text)])[0]!.title).toMatch(/^In target "prod", job "j" lists the task key "d" twice/);
  });

  test("a 1000-task loop names its first tasks only, so the findings stay small", () => {
    const loop = Array.from({ length: 1000 }, (_, i) => task(`t${i}`, `t${(i + 999) % 1000}`));
    const findings = findDependencyProblems({ loop: job(...loop) }, []);
    expect(findings[0]!.title).toBe('Tasks "t0", "t1", "t2" and 997 others depend on each other in a loop, so none of them can start.');
    expect(JSON.stringify(findings).length).toBeLessThan(400_000);
  });
});
