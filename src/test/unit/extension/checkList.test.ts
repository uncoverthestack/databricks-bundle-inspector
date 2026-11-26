import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CHECKS, type CheckFamily } from "../../../bundle/checkList.js";
import { INSPECTOR_ISSUE_KINDS } from "../../../bundle/issues.js";

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
    for (const line of read("docs/checks.md").split("\n")) {
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
    expect(undocumented).toEqual([
      "missing_file",
      "notebook_missing_extension",
      "not_a_notebook",
      "file_is_a_notebook",
      "include_matches_nothing",
      "resource_not_included",
      "unresolved_variable",
      "variable_in_auth_field",
      "secret_value_not_variable",
      "secret_variable_has_default",
    ]);
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
