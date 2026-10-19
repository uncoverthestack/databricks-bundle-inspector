import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { INSPECTOR_ISSUE_KINDS } from "../../../bundle/issues.js";

const checksDoc = readFileSync(path.resolve(__dirname, "../../../../docs/checks.md"), "utf8");

/** The codes with a section in docs/checks.md, in page order: headings written as `### \`code\``. */
const documented = [...checksDoc.matchAll(/^### `([a-z_]+)`$/gm)].map((match) => match[1]!);

describe("issue codes and docs/checks.md", () => {
  test("every code has exactly one section, and every section is a code, in the same order", () => {
    expect(documented).toEqual([...INSPECTOR_ISSUE_KINDS]);
  });

  test("the list at the top of the page names every code", () => {
    const summary = checksDoc.slice(0, checksDoc.indexOf("\n## "));
    for (const kind of INSPECTOR_ISSUE_KINDS) expect(summary).toContain(`\`${kind}\``);
  });

  test("each section says how serious it is and how to fix it", () => {
    const sections = checksDoc.split(/^### /m).slice(1);
    for (const section of sections) {
      const code = /^`([a-z_]+)`/.exec(section)?.[1];
      expect({ code, severity: section.includes("**Severity:**") }).toEqual({ code, severity: true });
      expect({ code, fix: section.includes("**Fix:**") }).toEqual({ code, fix: true });
    }
  });
});
