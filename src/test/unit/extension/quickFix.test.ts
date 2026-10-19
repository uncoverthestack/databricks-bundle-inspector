import { describe, test, expect } from "@jest/globals";
import { locateFix } from "../../../bundle/quickFix.js";

/** The text a fix would replace, or undefined when none is offered. */
function replaced(line: string, oldText: string, column?: number): string | undefined {
  const span = locateFix(line, oldText, column);
  return span ? line.slice(span.start, span.end) : undefined;
}

describe("locateFix", () => {
  test("finds a plain value after a key, at its column", () => {
    const line = "            notebook_path: ../src/etl";
    expect(locateFix(line, "../src/etl", 28)).toEqual({ start: 27, end: 37 });
  });

  test("finds a quoted value, leaving the quotes alone", () => {
    expect(replaced(`  notebook_path: "src/etl"`, "src/etl", 18)).toBe("src/etl");
    expect(replaced(`  notebook_path: 'src/etl'`, "src/etl", 18)).toBe("src/etl");
    expect(locateFix(`  notebook_path: "src/etl"`, "src/etl", 18)).toEqual({ start: 18, end: 25 });
  });

  test("finds a list entry with no column, and keeps a comment after it", () => {
    expect(locateFix("  - resource/*.yml", "resource/*.yml")).toEqual({ start: 4, end: 18 });
    expect(replaced("  - resource/*.yml  # jobs", "resource/*.yml")).toBe("resource/*.yml");
    expect(replaced(`  - "resource/*.yml"`, "resource/*.yml")).toBe("resource/*.yml");
  });

  test("offers nothing when the value is now different, as after an edit", () => {
    expect(locateFix("  notebook_path: src/etl.py", "src/etl", 18)).toBeUndefined();
    expect(locateFix("  notebook_path: src/etl_v2", "src/etl", 18)).toBeUndefined();
    expect(locateFix("  notebook_path: old/src/etl", "src/etl", 18)).toBeUndefined();
  });

  test("offers nothing when the value comes from a variable", () => {
    // The check read the resolved path; the file holds the expression.
    expect(locateFix("  notebook_path: ${var.root}/src/etl", "src/etl", 18)).toBeUndefined();
    expect(locateFix("  notebook_path: ${var.notebook}", "src/etl", 18)).toBeUndefined();
  });

  test("offers nothing when the value is not where the check found it", () => {
    expect(locateFix("  notebook_path: src/etl", "src/etl", 5)).toBeUndefined();
  });

  test("offers nothing when the line holds the value twice and no column picks one", () => {
    expect(locateFix("  - a.yml # a.yml", "a.yml")).toEqual({ start: 4, end: 9 });
    expect(locateFix(`  key: "x" "x"`, "x")).toBeUndefined();
  });

  test("offers nothing for an empty value, mismatched quotes, or text inside a key", () => {
    expect(locateFix("  notebook_path: src/etl", "")).toBeUndefined();
    expect(locateFix(`  notebook_path: "src/etl'`, "src/etl", 18)).toBeUndefined();
    expect(locateFix("  src/etl: value", "src/etl")).toBeUndefined();
  });
});
