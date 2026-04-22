import { describe, test, expect } from "@jest/globals";
import {
  extractDatabricksVersion,
  isDatabricksCliVersionOutput,
} from "../../databricksCli/parsing.js";

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
