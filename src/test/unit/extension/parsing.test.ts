import { describe, test, expect } from "@jest/globals";
import {
  extractDatabricksVersion,
  isDatabricksCliVersionOutput,
  isOlderThanSupported,
} from "../../../databricksCli/parsing.js";

describe("extractDatabricksVersion", () => {
  test("extracts Databricks CLI version", () => {
    expect(extractDatabricksVersion("Databricks CLI v0.295.0")).toBe(
      "v0.295.0",
    );
  });

  test("returns undefined when version is missing", () => {
    expect(extractDatabricksVersion("hello")).toBeUndefined();
  });
});

describe("isDatabricksCliVersionOutput", () => {
  test("detects valid Databricks CLI output", () => {
    expect(isDatabricksCliVersionOutput("Databricks CLI v0.295.0")).toBe(true);
  });

  test("accepts Databricks CLI output even when version format is different", () => {
    expect(isDatabricksCliVersionOutput("Databricks CLI 0.295.0")).toBe(true);
  });

  test("rejects non-Databricks CLI output", () => {
    expect(isDatabricksCliVersionOutput("Python 3.12.0")).toBe(false);
  });
});

describe("isOlderThanSupported", () => {
  test.each([
    ["v0.250.0", true],
    ["v0.298.9", true],
    ["v0.299.0", false],
    ["v0.299.2", false],
    ["v0.300.0", false],
    ["v1.0.0", false],
    ["v1.17.0", false],
    ["v0.1000.0", false],
  ])("%s -> %s", (version, older) => {
    expect(isOlderThanSupported(version)).toBe(older);
  });

  test("claims nothing when the version is missing or unreadable", () => {
    expect(isOlderThanSupported(undefined)).toBe(false);
    expect(isOlderThanSupported("dev")).toBe(false);
  });
});
