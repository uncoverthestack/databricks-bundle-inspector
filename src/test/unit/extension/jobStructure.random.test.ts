import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import { findDependencyProblems } from "../../../bundle/jobStructure.js";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";

// Random jobs checked against a reference written from the definitions, sharing no code
// with the detection: a task is in a loop if and only if it reaches itself; two tasks are
// in one loop if and only if each reaches the other. Seeded, so a failure replays exactly:
// RANDOM_SEED=<seed> RANDOM_RUNS=1 reproduces one job. RANDOM_RUNS raises the count locally.
const RUNS = Number(process.env.RANDOM_RUNS ?? 400);
const FIRST_SEED = Number(process.env.RANDOM_SEED ?? 1);

/** mulberry32: small, fast, and the same sequence on every machine. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Task {
  task_key: string;
  depends_on?: { task_key: string }[];
}

/** A random job: some tasks listed twice, self loops, repeated and unknown dependencies. */
function randomJob(seed: number): Task[] {
  const next = random(seed);
  const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)]!;
  const size = 1 + Math.floor(next() * (next() < 0.1 ? 120 : 25));
  const keys = Array.from({ length: size }, (_, i) => `t${i}`);
  const density = pick([0, 0.02, 0.05, 0.1, 0.3, 0.8]);
  const tasks: Task[] = keys.map((key) => {
    const upstream = keys.filter(() => next() < density);
    if (next() < 0.05) upstream.push(key); // self loop
    if (upstream.length && next() < 0.1) upstream.push(pick(upstream)); // repeated upstream
    if (next() < 0.05) upstream.push(`missing${Math.floor(next() * 3)}`);
    return { task_key: key, ...(upstream.length ? { depends_on: upstream.map((u) => ({ task_key: u })) } : {}) };
  });
  // A repeated task key: the CLI merges the copies and joins their depends_on lists.
  if (next() < 0.2) {
    const copy = pick(keys);
    tasks.splice(Math.floor(next() * tasks.length), 0, { task_key: copy, depends_on: [{ task_key: pick(keys) }] });
  }
  return tasks;
}

/** The reference: who each task can reach, by a plain search from every task. */
function reference(tasks: Task[]) {
  const keys = new Set(tasks.map((t) => t.task_key));
  const edges = new Map<string, Set<string>>();
  for (const t of tasks) {
    for (const d of t.depends_on ?? []) {
      if (!keys.has(d.task_key)) continue;
      const set = edges.get(t.task_key) ?? new Set<string>();
      set.add(d.task_key);
      edges.set(t.task_key, set);
    }
  }
  const reach = new Map<string, Set<string>>();
  for (const start of keys) {
    const seen = new Set<string>();
    const queue = [...(edges.get(start) ?? [])];
    while (queue.length) {
      const k = queue.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(...(edges.get(k) ?? []));
    }
    reach.set(start, seen);
  }
  const inLoop = [...keys].filter((k) => reach.get(k)!.has(k));
  const loopOf = (k: string) => inLoop.filter((o) => o === k || (reach.get(k)!.has(o) && reach.get(o)!.has(k))).sort();
  const unknown = new Set(
    tasks.flatMap((t) => (t.depends_on ?? []).filter((d) => !keys.has(d.task_key)).map((d) => `${t.task_key}->${d.task_key}`)),
  );
  return { inLoop: new Set(inLoop), loopOf, unknown };
}

/** The job as YAML, block style, one `depends_on` entry per line. */
function yamlOf(tasks: Task[]): string {
  const lines = ["resources:", "  jobs:", "    j:", "      tasks:"];
  for (const t of tasks) {
    lines.push(`        - task_key: ${t.task_key}`);
    if (t.depends_on) {
      lines.push("          depends_on:");
      for (const d of t.depends_on) lines.push(`            - task_key: ${d.task_key}`);
    }
  }
  return lines.join("\n");
}

describe(`random jobs, seeds ${FIRST_SEED} to ${FIRST_SEED + RUNS - 1}`, () => {
  test("loops, loop members, unknown dependencies and locations match the reference", () => {
    const failures: string[] = [];
    for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS && failures.length < 5; seed++) {
      const tasks = randomJob(seed);
      const text = yamlOf(tasks);
      const file = { file: "/b/databricks.yml", doc: parse(text), text, locations: parseYamlLocations("/b/databricks.yml", text) };
      const findings = findDependencyProblems({ j: { tasks } }, [file]);
      const expected = reference(tasks);
      const lines = text.split("\n");
      const fail = (why: string) => failures.push(`seed ${seed}: ${why}`);

      const loopTasks = new Set(findings.filter((f) => f.kind === "task_dependency_loop").map((f) => f.taskKey!));
      if ([...loopTasks].sort().join() !== [...expected.inLoop].sort().join()) {
        fail(`loop tasks ${[...loopTasks].sort().join()} != ${[...expected.inLoop].sort().join()}`);
      }
      for (const f of findings.filter((x) => x.kind === "task_dependency_loop")) {
        const members = expected.loopOf(f.taskKey!);
        // Up to ten members are named in full; check they are exactly the loop's.
        const named = [...f.title.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        if (members.length <= 10 && named.slice().sort().join() !== members.join()) fail(`loop of ${f.taskKey} named ${named.join()} != ${members.join()}`);
        if (!members.includes(f.subject)) fail(`loop edge ${f.taskKey}->${f.subject} leaves the loop`);
      }
      const unknown = new Set(findings.filter((f) => f.kind === "unknown_task_dependency").map((f) => `${f.taskKey}->${f.subject}`));
      if ([...unknown].sort().join() !== [...expected.unknown].sort().join()) fail(`unknown ${[...unknown].sort().join()} != ${[...expected.unknown].sort().join()}`);
      for (const f of findings) {
        const line = f.location ? lines[f.location.line - 1]?.trim() : undefined;
        if (line !== `- task_key: ${f.subject}`) fail(`${f.kind} ${f.taskKey}->${f.subject} located at "${line}"`);
      }
      if (new Set(findings.map((f) => `${f.kind}|${f.taskKey}|${f.subject}`)).size !== findings.length) fail("two findings say the same");
    }
    expect(failures).toEqual([]);
  });

  test("dense 1000-task jobs finish quickly", () => {
    const next = random(42);
    const keys = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    const tasks = keys.map((key) => ({ task_key: key, depends_on: Array.from({ length: 5 }, () => ({ task_key: keys[Math.floor(next() * 1000)]! })) }));
    const started = Date.now();
    const findings = findDependencyProblems({ j: { tasks } }, []);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(findings.every((f) => f.kind === "task_dependency_loop")).toBe(true);
  });
});
