import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globSync, hasGlobCharacters, matchGoSegment } from "../../../bundle/goGlob.js";

describe("matchGoSegment (Go's filepath.Match for one path segment)", () => {
  test.each([
    ["*.yml", "a.yml", true],
    ["*.yml", "a.yaml", false],
    ["*", "", true],
    // `**` is not recursive for the CLI: it is `*` twice.
    ["**", "abc", true],
    ["a?c", "abc", true],
    ["a?c", "ac", false],
    ["?", "é", true],
    ["[ab]x", "bx", true],
    ["[ab]x", "cx", false],
    ["[^ab]x", "cx", true],
    ["[^ab]x", "ax", false],
    ["[a-c]", "b", true],
    ["[a-c]", "d", false],
    ["\\*", "*", true],
    ["\\*", "a", false],
    ["*.y*ml", "x.yaml", true],
    ["*.y*ml", "x.yml", true],
    // Braces are not supported by the CLI: they are plain characters.
    ["{yml,yaml}", "yml", false],
    ["{yml,yaml}", "{yml,yaml}", true],
  ])("%s against %s is %s", (pattern, name, expected) => {
    expect(matchGoSegment(pattern, name)).toBe(expected);
  });

  test.each(["[", "[]", "[a", "[a-]", "a\\", "[-a]"])("%s is a malformed pattern", (pattern) => {
    expect(matchGoSegment(pattern, "a")).toBeUndefined();
  });
});

test("hasGlobCharacters follows the CLI's check for a pattern", () => {
  expect(hasGlobCharacters("resources/*.yml")).toBe(true);
  expect(hasGlobCharacters("resources/job?.yml")).toBe(true);
  expect(hasGlobCharacters("resources/[ab].yml")).toBe(true);
  expect(hasGlobCharacters("resources/job.yml")).toBe(false);
  // The CLI only treats `*`, `?` and `[` as pattern characters, so `{` does not count.
  expect(hasGlobCharacters("resources/{a,b}.yml")).toBe(false);
});

describe("globSync against a real folder", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "glob-"));
    for (const file of [
      "resources/top.job.yml",
      "resources/jobs/nested.job.yml",
      "resources/ext.job.yaml",
      "other/o.job.yml",
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "resources: {}\n");
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // Each expected list reproduces what `databricks bundle validate` actually loaded for
  // the same four files (checked on CLI v0.299.0 and v1.17.0): top, nested, ext and other
  // are the four jobs those files define.
  test.each([
    ["resources/*.yml", ["resources/top.job.yml"]],
    ["resources/**/*.yml", ["resources/jobs/nested.job.yml"]],
    ["resources/*.y*ml", ["resources/ext.job.yaml", "resources/top.job.yml"]],
    ["resources/*.{yml,yaml}", []],
    ["**/*.job.yml", ["other/o.job.yml", "resources/top.job.yml"]],
    // The CLI then stops, because it also selects the `jobs` folder, which is not a YAML file.
    ["resources/**", ["resources/ext.job.yaml", "resources/jobs", "resources/top.job.yml"]],
    ["nothing/*.yml", []],
    ["resources/top.job.yml", ["resources/top.job.yml"]],
    ["resources/./top.job.yml", ["resources/top.job.yml"]],
  ])("%s", (entry, expected) => {
    expect(globSync(root, entry)).toEqual(expected);
  });

  test("a malformed pattern is reported as undefined", () => {
    expect(globSync(root, "resources/[.yml")).toBeUndefined();
  });
});
