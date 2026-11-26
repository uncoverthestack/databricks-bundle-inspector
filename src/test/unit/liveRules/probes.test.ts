import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import { INSPECTOR_ISSUE_KINDS } from "../../../bundle/issues.js";
import { judge, loadProbes, probeProblems, type StepResult } from "../../liveRules/probes.js";

const probes = loadProbes(path.resolve(__dirname, "../../liveRules/probes"));
const result = (step: StepResult["step"], outcome: StepResult["outcome"], output = ""): StepResult => ({ step, outcome, output });

describe("live rule probes (#650)", () => {
  test("every probe's files are well formed", () => {
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.flatMap(probeProblems)).toEqual([]);
  });

  test("every probe backs a finding code", () => {
    const codes = new Set<string>(INSPECTOR_ISSUE_KINDS);
    expect(probes.filter((probe) => !codes.has(probe.check)).map((probe) => probe.id)).toEqual([]);
  });

  test("every working variant deploys and runs, as the control", () => {
    expect(probes.filter((probe) => JSON.stringify(probe.variants.working) !== JSON.stringify({ validate: "pass", deploy: "pass", run: "pass" })).map((p) => p.id)).toEqual([]);
  });
});

describe("judging a run", () => {
  test("a broken deploy as expected", () => {
    const verdict = judge({ validate: "pass", deploy: "fail" }, [result("validate", "pass"), result("deploy", "fail")]);
    expect(verdict).toMatchObject({ matches: true, firstFailure: "deploy" });
  });

  test("a deploy that now passes differs", () => {
    const verdict = judge({ validate: "pass", deploy: "fail" }, [result("validate", "pass"), result("deploy", "pass")]);
    expect(verdict.matches).toBe(false);
    expect(verdict.lines).toContain("deploy: expected fail, got pass  <-- differs");
  });

  test("a step never reached counts as skipped", () => {
    const verdict = judge({ validate: "pass", deploy: "pass", run: "fail" }, [result("validate", "fail")]);
    expect(verdict.lines).toEqual(["validate: expected pass, got fail  <-- differs", "deploy: expected pass, got skipped  <-- differs", "run: expected fail, got skipped  <-- differs"]);
  });

  test("unknown steps never differ, and the first failure is reported", () => {
    const verdict = judge({ validate: "unknown", deploy: "unknown", run: "unknown" }, [result("validate", "pass"), result("deploy", "fail")]);
    expect(verdict).toMatchObject({ matches: true, firstFailure: "deploy" });
  });

  test("a failure for another reason differs when failsWith is set", () => {
    const expected = { validate: "pass", deploy: "fail", failsWith: "Invalid trigger settings" } as const;
    expect(judge(expected, [result("validate", "pass"), result("deploy", "fail", "Error: Invalid trigger settings. One of")]).matches).toBe(true);
    expect(judge(expected, [result("validate", "pass"), result("deploy", "fail", "Error: 403 Forbidden")]).matches).toBe(false);
  });
});

describe("probe file rules", () => {
  test("a step after a failing one is refused", () => {
    const probe = { ...probes[0]!, variants: { broken: { validate: "fail" as const, deploy: "pass" as const }, working: probes[0]!.variants.working! } };
    expect(probeProblems(probe)).toContain(`${probe.id}/broken: a step follows a failing one`);
  });
});
