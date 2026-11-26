import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CHECKS, type CheckFamily } from "../../../bundle/checkList.js";
import { INSPECTOR_ISSUE_KINDS } from "../../../bundle/issues.js";
import { loadProbes, STEPS, type Step } from "../../liveRules/probes.js";

const root = path.resolve(__dirname, "../../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Each `## ` section of docs/checks.md, as the family its codes belong to. */
const FAMILY_BY_HEADING: Record<string, CheckFamily> = {
  "Files and paths": "files",
  "`include`": "include",
  Jobs: "jobs",
  Compute: "compute",
  "Code in notebooks and files": "code",
  "Bundle configuration": "configuration",
};

describe("the list of checks (#648)", () => {
  test("has every code, in the order of INSPECTOR_ISSUE_KINDS and docs/checks.md", () => {
    expect(Object.keys(CHECKS)).toEqual([...INSPECTOR_ISSUE_KINDS]);
  });

  test("each code's family is the docs/checks.md section it is under", () => {
    const fromDocs: Record<string, CheckFamily> = {};
    let family: CheckFamily | undefined;
    for (const line of read("docs/checks.md").split(/\r?\n/)) {
      const heading = /^## (.+)$/.exec(line)?.[1];
      if (heading !== undefined) family = FAMILY_BY_HEADING[heading];
      const code = /^### `([a-z_]+)`$/.exec(line)?.[1];
      if (code && family) fromDocs[code] = family;
    }
    expect(fromDocs).toEqual(Object.fromEntries(Object.entries(CHECKS).map(([code, info]) => [code, info.family])));
  });

  test("only these say nothing about which step fails; the list may only shrink", () => {
    // Each needs its step confirmed by deploying and running (#650), then written in
    // docs/checks.md and set in checkList.ts. A new check names its step from the start.
    const undocumented = Object.entries(CHECKS)
      .filter(([, info]) => !("stops" in info))
      .map(([code]) => code);
    expect(undocumented).toEqual(["variable_in_auth_field", "secret_value_not_variable", "secret_variable_has_default"]);
  });
});

describe("codes never change", () => {
  const shipped = JSON.parse(read("src/bundle/shippedCodes.json")) as Record<string, string>;
  const version = (text: string) => text.split(".").map(Number) as [number, number, number];
  const newer = (a: string, b: string) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
    return false;
  };

  test("every code that has shipped is still a code", () => {
    const current = new Set<string>(INSPECTOR_ISSUE_KINDS);
    expect(Object.keys(shipped).filter((code) => !current.has(code))).toEqual([]);
  });

  test("a release records its new codes: when package.json moves past the newest release here, every code must be in shippedCodes.json", () => {
    const packageVersion = (JSON.parse(read("package.json")) as { version: string }).version;
    const newest = Object.values(shipped).reduce((a, b) => (newer(b, a) ? b : a));
    if (!newer(packageVersion, newest)) return;
    // Add each one to src/bundle/shippedCodes.json with the version being released.
    expect(INSPECTOR_ISSUE_KINDS.filter((code) => !(code in shipped))).toEqual([]);
  });
});

describe("every check is tested", () => {
  function testFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) return testFiles(file);
      return name.endsWith(".ts") && name !== "checkList.test.ts" ? [file] : [];
    });
  }

  test("each code is named in at least one test", () => {
    const text = testFiles(path.join(root, "src/test")).map((file) => readFileSync(file, "utf8")).join("\n");
    // Tested through what it shows: "Out of date:" findings (diagnosticFailures.test.ts).
    const testedOtherwise = new Set(["inspector_check_failed"]);
    const untested = INSPECTOR_ISSUE_KINDS.filter((code) => !testedOtherwise.has(code) && !new RegExp(`\\b${code}\\b`).test(text));
    expect(untested).toEqual([]);
  });
});

/**
 * The bar a check meets before it ships (docs/checks.md, "Adding a check"). It applies to every
 * code not in shippedCodes.json yet, so a new code can't reach a release without it:
 *
 * 1. its failing step is confirmed live: a probe in src/test/liveRules/probes (#650);
 * 2. no new false alarms on real bundles: the "Findings on real bundles" pull request check
 *    (#660), reviewed by hand, so not tested here;
 * 3. a near-miss test that must stay quiet, with "near miss (<code>)" in its title;
 * 4. an entry in the check list, with the step it stops (#648).
 */
describe("the bar every check meets before it ships", () => {
  const shipped = JSON.parse(read("src/bundle/shippedCodes.json")) as Record<string, string>;
  const unshipped = INSPECTOR_ISSUE_KINDS.filter((code) => !(code in shipped));
  const probes = loadProbes(path.join(root, "src/test/liveRules/probes"));
  /** Nothing fails for these, so there is no step to confirm live. */
  const NOTHING_FAILS = new Set(["advice", "coverage", "cli"]);

  /** The first step the variant is confirmed to fail at, or "none" when every listed step passes. */
  const failsAt = (variant: Partial<Record<Step, string>>): Step | "none" | "unconfirmed" => {
    for (const step of STEPS) {
      if (variant[step] === "unknown") return "unconfirmed";
      if (variant[step] === "fail") return step;
    }
    return "none";
  };
  const confirmed = (code: string): boolean => {
    const stops = (CHECKS as Record<string, { stops?: string }>)[code]?.stops;
    return probes.some((probe) => {
      if (probe.check !== code) return false;
      const broken = failsAt(probe.variants.broken ?? {});
      const working = failsAt(probe.variants.working ?? {});
      if (working !== "none" || probe.variants.working?.run !== "pass") return false;
      // Silent: it deploys and runs, but does the wrong thing; how that shows varies by check.
      return stops === "silent" ? broken !== "unconfirmed" : broken === stops;
    });
  };

  test("4. every check not shipped yet says which step it stops", () => {
    expect(unshipped.filter((code) => !("stops" in CHECKS[code]))).toEqual([]);
  });

  test("1. every check not shipped yet has its failing step confirmed live, by a probe that fails there", () => {
    const missing = unshipped.filter((code) => !NOTHING_FAILS.has((CHECKS[code] as { stops?: string }).stops ?? "") && !confirmed(code));
    // Add a probe: src/test/liveRules/README.md. Run it twice on a workspace before setting the steps.
    expect(missing).toEqual([]);
  });

  test("3. every check not shipped yet has a near-miss test", () => {
    function testFiles(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) return testFiles(file);
        return name.endsWith(".ts") && name !== "checkList.test.ts" ? [file] : [];
      });
    }
    const named = new Set<string>();
    for (const file of testFiles(path.join(root, "src/test"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/near miss \(([a-z_]+)\)/g)) named.add(match[1]!);
    }
    // A test titled "near miss (<code>): ..." with a case close to the mistake that must give no finding.
    expect(unshipped.filter((code) => !named.has(code))).toEqual([]);
  });

  test("every probe backs a check, and fails at the step the check list names", () => {
    const wrong = probes.flatMap((probe) => {
      const info = (CHECKS as Record<string, { stops?: string }>)[probe.check];
      if (!info) return [`${probe.id}: no check "${probe.check}"`];
      const broken = failsAt(probe.variants.broken ?? {});
      if (broken === "unconfirmed" || info.stops === undefined || info.stops === "silent") return [];
      return broken === info.stops ? [] : [`${probe.id}: fails at ${broken}, the check list says ${info.stops}`];
    });
    expect(wrong).toEqual([]);
  });
});
