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

  // Captured verbatim from `databricks bundle validate` (identical on 0.270.1 through 1.17.0).
  // Resource-scoped diagnostics carry an `at <yaml.path>` line before the location,
  // and a diagnostic can list more than one location.
  it("parses resource-scoped diagnostics from real CLI output", () => {
    const stderr = [
      `Warning: unknown field: bogus_top`,
      `  in databricks.yml:3:1`,
      ``,
      `Warning: unknown field: bogus_field`,
      `  at resources.jobs.j1`,
      `  in resources/jobs.yml:5:7`,
      ``,
      `Warning: unknown field: bogus_task_field`,
      `  at resources.jobs.j1.tasks[0]`,
      `  in resources/jobs.yml:10:11`,
      ``,
      `Error: multiple resources or scripts have been defined with the same key: j1`,
      `  at resources.jobs.j1`,
      `  in resources/jobs.yml:4:7`,
      `     resources/more.yml:4:7`,
      ``,
    ].join("\n");

    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([
      { severity: "warning", message: "unknown field: bogus_top", path: "databricks.yml", line: 3, column: 1 },
      {
        severity: "warning",
        message: "unknown field: bogus_field",
        yamlPath: "resources.jobs.j1",
        path: "resources/jobs.yml",
        line: 5,
        column: 7,
      },
      {
        severity: "warning",
        message: "unknown field: bogus_task_field",
        yamlPath: "resources.jobs.j1.tasks[0]",
        path: "resources/jobs.yml",
        line: 10,
        column: 11,
      },
      {
        severity: "error",
        message: "multiple resources or scripts have been defined with the same key: j1",
        yamlPath: "resources.jobs.j1",
        path: "resources/jobs.yml",
        line: 4,
        column: 7,
      },
    ]);
  });

  it("keeps the yaml path when a diagnostic has no file location", () => {
    const stderr = `Warning: something is off\n  at resources.jobs.j1`;
    expect(parseBundleDiagnostics(stderr, PROBE)).toEqual([
      { severity: "warning", message: "something is off", yamlPath: "resources.jobs.j1" },
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
