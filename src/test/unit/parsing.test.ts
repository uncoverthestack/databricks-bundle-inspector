import { test, expect } from "@jest/globals";
import {
  extractDatabricksVersion,
  isDatabricksCliVersionOutput,
} from "../../databricksCli/parsing.js";

test("extracts Databricks CLI version", () => {
  expect(extractDatabricksVersion("Databricks CLI v0.295.0")).toBe("v0.295.0");
});

test("returns undefined when version is missing", () => {
  expect(extractDatabricksVersion("hello")).toBeUndefined();
});

test("detects Databricks CLI output", () => {
  expect(isDatabricksCliVersionOutput("Databricks CLI v0.295.0")).toBe(true);
});

test("rejects non-Databricks CLI output", () => {
  expect(isDatabricksCliVersionOutput("Python 3.12.0")).toBe(false);
});
