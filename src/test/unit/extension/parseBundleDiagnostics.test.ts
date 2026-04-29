import { describe, it, expect } from "@jest/globals";
import {
  parseAvailableTargets,
  parseBundleDiagnostics,
} from "../../../bundle/parseBundleDiagnostics.js";

const PROBE = "__bundle_inspector_probe__";

describe("parseBundleDiagnostics", () => {
  it("returns empty array for empty stderr", () => {
    expect(parseBundleDiagnostics("", PROBE)).toEqual([]);
  });

  it("filters out the probe target error", () => {
    const stderr = `Error: ${PROBE}: no such target. Available targets: dev, prod`;
    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([]);
  });

  it("parses a warning with location", () => {
    const stderr = `Warning: unknown field: includ\n  in databricks.yml:4:1`;
    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([
      { severity: "warning", message: "unknown field: includ", path: "databricks.yml", line: 4, column: 1 },
    ]);
  });

  it("parses an error with location", () => {
    const stderr = `Error: field is required\n  in resources/job.yml:10:5`;
    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([
      { severity: "error", message: "field is required", path: "resources/job.yml", line: 10, column: 5 },
    ]);
  });

  it("parses a diagnostic without a location line", () => {
    const stderr = `Warning: no default target set`;
    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([
      { severity: "warning", message: "no default target set" },
    ]);
  });

  it("parses multiple diagnostics and filters probe error", () => {
    const stderr = [
      `Warning: unknown field: includ`,
      `  in databricks.yml:4:1`,
      ``,
      `Error: ${PROBE}: no such target. Available targets: dev, prod`,
    ].join("\n");

    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([
      { severity: "warning", message: "unknown field: includ", path: "databricks.yml", line: 4, column: 1 },
    ]);
  });

  it("parses multiple real diagnostics", () => {
    const stderr = [
      `Warning: unknown field: includ`,
      `  in databricks.yml:4:1`,
      `Error: field is required`,
      `  in resources/job.yml:2:1`,
    ].join("\n");

    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([
      { severity: "warning", message: "unknown field: includ", path: "databricks.yml", line: 4, column: 1 },
      { severity: "error", message: "field is required", path: "resources/job.yml", line: 2, column: 1 },
    ]);
  });
});

describe("parseAvailableTargets", () => {
  it("extracts targets from the probe target error", () => {
    const stderr = `Error: ${PROBE}: no such target. Available targets: dev, prod`;

    expect(parseAvailableTargets(stderr)).toEqual(["dev", "prod"]);
  });

  it("returns an empty list when stderr has no target list", () => {
    expect(parseAvailableTargets("Warning: no default target set")).toEqual([]);
  });
});
