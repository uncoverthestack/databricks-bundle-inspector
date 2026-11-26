import { describe, expect, test } from "@jest/globals";
import { withPythonTree } from "../../../bundle/code/pythonParser.js";

describe("Python parser", () => {
  test("positions count JavaScript characters, also after non-ASCII text and emoji", async () => {
    const text = 'é = "😀 ünïcode"\nx = dbutils.widgets.get("a")\n';
    const found = await withPythonTree(text, (root) =>
      root.descendantsOfType("call").map((node) => ({ start: node!.startIndex, text: node!.text })),
    );
    expect(found).toEqual([{ start: text.indexOf("dbutils"), text: 'dbutils.widgets.get("a")' }]);
  });

  test("a # inside a multi-line f-string's braces doesn't hide later code (#602)", async () => {
    const text = 'msg = f"""{\n  1  # a } comment\n}"""\nv = dbutils.widgets.get("needed")\n';
    const calls = await withPythonTree(text, (root) => root.descendantsOfType("call").map((node) => node!.text));
    expect(calls).toContain('dbutils.widgets.get("needed")');
  });
});

describe("the files each bundle ships", () => {
  test("the build script copies exactly the files the parser loads", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { TREE_SITTER_FILES } = await import("../../../bundle/code/pythonParser.js");
    const script = await readFile(path.join(__dirname, "../../../../scripts/tree-sitter-files.mjs"), "utf8");
    const listed = [...script.matchAll(/^\s+"([^"]+)": "([^"]+)",$/gm)].map((match) => [match[1], match[2]]);
    expect(Object.fromEntries(listed)).toEqual(TREE_SITTER_FILES);
  });
});
