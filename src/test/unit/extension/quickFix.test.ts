import { describe, test, expect } from "@jest/globals";
import { parse } from "yaml";
import { fixEdit, locateFix, writtenValueAt, yamlValue } from "../../../bundle/quickFix.js";

/** The text a fix would replace, or undefined when none is offered. */
function replaced(line: string, oldText: string, column: number): string | undefined {
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
    expect(locateFix("  - resource/*.yml", "resource/*.yml", 5)).toEqual({ start: 4, end: 18 });
    expect(replaced("  - resource/*.yml  # jobs", "resource/*.yml", 5)).toBe("resource/*.yml");
    expect(replaced(`  - "resource/*.yml"`, "resource/*.yml", 5)).toBe("resource/*.yml");
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
    expect(locateFix("  - a.yml # a.yml", "a.yml", 5)).toEqual({ start: 4, end: 9 });
    expect(locateFix(`  key: "x" "x"`, "x", 8)).toBeUndefined();
    // A quoted value that ends a flow mapping or list entry is still one value.
    expect(replaced(`  notebook_task: { notebook_path: "./src/etl" }`, "./src/etl", 35)).toBe("./src/etl");
    expect(replaced(`  include: ["resource/*.yml", "b"]`, "resource/*.yml", 13)).toBe("resource/*.yml");
  });

  test("offers nothing for a copy of the value inside a longer plain value", () => {
    // YAML reads "resource/*.yml resource/*.yml" as one value: neither copy is the value.
    expect(locateFix("  - resource/*.yml resource/*.yml", "resource/*.yml", 5)).toBeUndefined();
    expect(locateFix("  notebook_path: src/etl src/etl  # x", "src/etl", 18)).toBeUndefined();
  });

  test("offers nothing for an empty value, mismatched quotes, or text inside a key", () => {
    expect(locateFix("  notebook_path: src/etl", "", 18)).toBeUndefined();
    expect(locateFix(`  notebook_path: "src/etl'`, "src/etl", 18)).toBeUndefined();
    expect(locateFix("  src/etl: value", "src/etl", 3)).toBeUndefined();
  });
});

describe("yamlValue", () => {
  test("1000 generated path strings round-trip in all quote styles and both YAML versions", () => {
    const alphabet = [..."abc012 /:#'\"`[]{}&*!\\", "\n", "\r", "\t", "\u0085", "\u2028", "\u2029", "é", "🐍"];
    let seed = 42;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 1000; i++) {
      const value = Array.from({ length: next() % 40 }, () => alphabet[next() % alphabet.length]).join("");
      for (const quote of [undefined, '"', "'"] as const) {
        for (const version of ["1.1", "1.2"] as const) {
          expect(parse(`key: ${yamlValue(value, quote)}`, { version })).toEqual({ key: value });
        }
      }
    }
  });

  test.each(["a\u0085b.py", "a\u2028b.py", "a\u2029b.py", "a\r\nb.py"])("preserves YAML line-break characters in %j", (value) => {
    for (const quote of [undefined, '"', "'"] as const) {
      expect(parse(`key: ${yamlValue(value, quote)}`)).toEqual({ key: value });
    }
  });

  test("keeps a plain value plain when YAML reads it back unchanged", () => {
    expect(yamlValue("../src/etl.py", undefined)).toBe("../src/etl.py");
    expect(yamlValue("../it's/a.py", undefined)).toBe("../it's/a.py");
    expect(yamlValue("a#1.py", undefined)).toBe("a#1.py");
    expect(yamlValue("resources/*.yml", undefined)).toBe("resources/*.yml");
  });

  test("quotes a plain value YAML would read as something else", () => {
    expect(yamlValue("../team #2/a.py", undefined)).toBe("'../team #2/a.py'");
    expect(yamlValue("../v: 2/a.py", undefined)).toBe("'../v: 2/a.py'");
    expect(yamlValue(`"x".py`, undefined)).toBe(`'"x".py'`);
    expect(yamlValue("'x.py", undefined)).toBe(`'''x.py'`);
    expect(yamlValue("*.yml", undefined)).toBe("'*.yml'");
    expect(yamlValue("1.5", undefined)).toBe("'1.5'");
    // A boolean to YAML 1.1, which some readers still use.
    expect(yamlValue("on", undefined)).toBe("'on'");
    expect(yamlValue("a.py ", undefined)).toBe("'a.py '");
  });

  test("keeps the old value's quotes, escaping what they need", () => {
    expect(yamlValue(`../say "hi"/a.py`, '"')).toBe(String.raw`"../say \"hi\"/a.py"`);
    expect(yamlValue(String.raw`..\a.py`, '"')).toBe(String.raw`"..\\a.py"`);
    expect(yamlValue("../it's/a.py", "'")).toBe("'../it''s/a.py'");
  });

  test.each([
    ["../team #2/a.py"],
    ["../v: 2/a.py"],
    [`../say "hi"/a.py`],
    ["../it's/a.py"],
    ["- a.py"],
    ["a\nb.py"],
    ["[a].py"],
    ["*.yml"],
    ["&a b"],
    ["@a"],
  ])("reads back as %j in every style", (value) => {
    for (const quote of [undefined, '"', "'"] as const) {
      expect(parse(`key: ${yamlValue(value, quote)}`)).toEqual({ key: value });
    }
  });
});

describe("writtenValueAt", () => {
  test.each(["../it's/a.py", '../say"hi/a.py'])("a quote inside the plain path %s cannot hide its trailing comment", (value) => {
    expect(writtenValueAt(`  path: ${value} # old location`, 9)).toBe(value);
  });
});

describe("fixEdit", () => {
  const applied = (line: string, edit: { start: number; end: number; text: string }) =>
    line.slice(0, edit.start) + edit.text + line.slice(edit.end);

  test("replaces a quoted value with its quotes", () => {
    const line = `  notebook_path: "../old/a.py"`;
    expect(applied(line, fixEdit(line, "../old/a.py", `../say "hi"/a.py`, 18)!)).toBe(
      String.raw`  notebook_path: "../say \"hi\"/a.py"`,
    );
  });

  test("quotes a plain value that needs it, and keeps a comment after it", () => {
    const line = "  notebook_path: ../old/a.py  # moved";
    expect(applied(line, fixEdit(line, "../old/a.py", "../team #2/a.py", 18)!)).toBe(
      "  notebook_path: '../team #2/a.py'  # moved",
    );
  });

  test("offers nothing where locateFix finds nothing", () => {
    expect(fixEdit("  notebook_path: src/etl.py", "src/etl", "src/etl.py", 18)).toBeUndefined();
  });
});
