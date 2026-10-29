import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const repo = path.join(__dirname, "../../../..");
const scripts = (JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
const workflow = parse(readFileSync(path.join(repo, ".github/workflows/e2e.yml"), "utf8")) as {
  jobs: Record<string, { steps?: Array<{ name?: string; if?: string; run?: string }> }>;
};
const RUN_TEST = "node out/e2e/runTest.cjs";

/** The runTest.cjs arguments an `npm run test:e2e:*` script ends up passing. */
function argumentsOf(name: string): string {
  const script = scripts[name]!;
  if (script.endsWith(RUN_TEST)) return "";
  const chained = /^npm run (test:e2e(?::[\w:-]+)?) -- (.+)$/.exec(script);
  if (!chained) throw new Error(`${name}: expected "npm run test:e2e... -- <arguments>", not "${script}"`);
  return [argumentsOf(chained[1]!), chained[2]!].filter(Boolean).join(" ");
}

describe("e2e.yml runs every E2E suite script (#314)", () => {
  // The workflow runs each suite with runTest.cjs directly, built once, so a suite script
  // added to package.json but not to the workflow would never run in CI.
  const suiteScripts = Object.keys(scripts).filter((name) => /^test:e2e(:|$)/.test(name) && !name.endsWith(":watch"));
  const steps = (workflow.jobs["e2e-group"]?.steps ?? []).filter((step) => step.run?.includes(RUN_TEST));

  test("each suite script's arguments run in exactly one step", () => {
    const run = steps.map((step) => step.run!.slice(step.run!.indexOf(RUN_TEST) + RUN_TEST.length).trim());
    expect(suiteScripts.length).toBeGreaterThan(10);
    expect([...run].sort()).toEqual(suiteScripts.map(argumentsOf).sort());
  });

  test("each suite step belongs to exactly one of the two groups", () => {
    for (const step of steps) {
      const groups = [...(step.if ?? "").matchAll(/matrix\.group == (\d)/g)].map((match) => match[1]);
      expect([step.name, groups]).toEqual([step.name, [expect.stringMatching(/^[12]$/)]]);
    }
  });
});
