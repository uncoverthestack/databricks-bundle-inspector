/**
 * Live rule probes (#650): small bundles, a broken one and a working one per rule, with what
 * each step should do when deployed and run on a real workspace. Rules the inspector relies on
 * were each confirmed on one Databricks CLI version; re-running the probes on a new release
 * shows when Databricks changed the behaviour a check depends on.
 *
 * A probe folder holds `rule.json` and one folder per variant (`broken`, `working`), each a
 * bundle whose `databricks.yml` writes its name as `__NAME__` and has a target `probe` and a
 * job `probe`. The runner gives each run a unique name, so runs never share a workspace folder.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const STEPS = ["validate", "deploy", "run"] as const;
export type Step = (typeof STEPS)[number];

/** `unknown`: not confirmed yet; the run reports what happens without failing (discover mode). */
export type Expected = "pass" | "fail" | "unknown";
export type Outcome = "pass" | "fail" | "skipped";

export interface VariantExpectation {
  validate: Expected;
  deploy?: Expected;
  run?: Expected;
  /** Text the failing step's output must contain, so a failure for another reason isn't a match. */
  failsWith?: string;
}

export interface Probe {
  id: string;
  /** The finding code the rule backs, as in docs/checks.md. */
  check: string;
  issue: number;
  /** Where the rule is written down and when it was last confirmed. */
  note: string;
  variants: Record<string, VariantExpectation>;
  folder: string;
}

export function loadProbes(root: string): Probe[] {
  return readdirSync(root)
    .filter((name) => statSync(path.join(root, name)).isDirectory())
    .sort()
    .map((id) => {
      const folder = path.join(root, id);
      const rule = JSON.parse(readFileSync(path.join(folder, "rule.json"), "utf8")) as Omit<Probe, "id" | "folder">;
      return { ...rule, id, folder };
    });
}

/** Problems with a probe's files, before anything is deployed. */
export function probeProblems(probe: Probe): string[] {
  const problems: string[] = [];
  for (const [variant, expected] of Object.entries(probe.variants)) {
    const bundle = path.join(probe.folder, variant, "databricks.yml");
    if (!existsSync(bundle)) {
      problems.push(`${probe.id}/${variant}: no databricks.yml`);
      continue;
    }
    const text = readFileSync(bundle, "utf8");
    if (!text.includes("__NAME__")) problems.push(`${probe.id}/${variant}: the bundle name isn't __NAME__`);
    if (!/^\s+probe:\s*$/m.test(text)) problems.push(`${probe.id}/${variant}: no target or job named probe`);
    // Steps run in order and stop at the first failure, so nothing may follow a "fail".
    const listed = STEPS.filter((step) => expected[step] !== undefined);
    if (listed.join() !== STEPS.slice(0, listed.length).join()) problems.push(`${probe.id}/${variant}: steps must start at validate with none missing`);
    const failAt = listed.findIndex((step) => expected[step] === "fail");
    if (failAt !== -1 && failAt < listed.length - 1) problems.push(`${probe.id}/${variant}: a step follows a failing one`);
  }
  if (!probe.variants.broken || !probe.variants.working) problems.push(`${probe.id}: needs a broken and a working variant`);
  return problems;
}

export interface StepResult {
  step: Step;
  outcome: Outcome;
  output: string;
}

export interface Verdict {
  /** Every listed step matched (unknown steps always do). */
  matches: boolean;
  /** The first step that failed, or "none". */
  firstFailure: Step | "none";
  lines: string[];
}

/** Compares a variant's results with what it should do. */
export function judge(expected: VariantExpectation, results: readonly StepResult[]): Verdict {
  const lines: string[] = [];
  let matches = true;
  for (const step of STEPS) {
    const want = expected[step];
    if (want === undefined) continue;
    const got = results.find((result) => result.step === step)?.outcome ?? "skipped";
    const ok = want === "unknown" || want === got;
    if (!ok) matches = false;
    lines.push(`${step}: expected ${want}, got ${got}${ok ? "" : "  <-- differs"}`);
  }
  const failed = results.find((result) => result.outcome === "fail");
  if (failed && expected.failsWith && expected[failed.step] === "fail" && !failed.output.includes(expected.failsWith)) {
    matches = false;
    lines.push(`${failed.step} failed, but without "${expected.failsWith}"  <-- differs`);
  }
  return { matches, firstFailure: failed?.step ?? "none", lines };
}
