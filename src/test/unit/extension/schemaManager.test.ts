import { describe, test, expect } from "@jest/globals";
import { parseBundleIncludes } from "../../../bundle/schemaManager.js";

describe("parseBundleIncludes", () => {
  test("returns glob patterns from a standard include block", () => {
    const content = `
bundle:
  name: my-bundle

include:
  - resources/*.yml
  - pipelines/*.yml
`.trim();
    expect(parseBundleIncludes(content)).toEqual([
      "resources/*.yml",
      "pipelines/*.yml",
    ]);
  });

  test("returns empty array when include key is absent", () => {
    const content = `
bundle:
  name: my-bundle
`.trim();
    expect(parseBundleIncludes(content)).toEqual([]);
  });

  test("returns empty array for an empty file", () => {
    expect(parseBundleIncludes("")).toEqual([]);
  });

  test("returns empty array when include is an empty list", () => {
    const content = `
include: []
`.trim();
    expect(parseBundleIncludes(content)).toEqual([]);
  });

  test("handles quoted glob patterns", () => {
    const content = `
include:
  - "resources/*.yml"
  - 'jobs/*.yaml'
`.trim();
    expect(parseBundleIncludes(content)).toEqual([
      "resources/*.yml",
      "jobs/*.yaml",
    ]);
  });

  test("filters out non-string entries from a mixed array", () => {
    const content = `
include:
  - resources/*.yml
  - 42
  - true
`.trim();
    expect(parseBundleIncludes(content)).toEqual(["resources/*.yml"]);
  });

  test("returns empty array when include is a scalar, not a list", () => {
    const content = `
include: resources/*.yml
`.trim();
    expect(parseBundleIncludes(content)).toEqual([]);
  });

  test("handles a single include entry", () => {
    const content = `
include:
  - resources/*.yml
`.trim();
    expect(parseBundleIncludes(content)).toEqual(["resources/*.yml"]);
  });

  test("ignores other top-level keys around include", () => {
    const content = `
bundle:
  name: my-bundle

include:
  - resources/*.yml

targets:
  dev:
    mode: development
`.trim();
    expect(parseBundleIncludes(content)).toEqual(["resources/*.yml"]);
  });
});
