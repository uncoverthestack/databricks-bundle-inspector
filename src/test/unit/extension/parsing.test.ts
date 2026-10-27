import { describe, test, expect } from "@jest/globals";
import {
  extractDatabricksVersion,
  isDatabricksCliVersionOutput,
  isOlderThanSupported,
  legacyCliVersion,
  telemetryCliVersion,
} from "../../../databricksCli/parsing.js";

describe("telemetryCliVersion", () => {
  test.each([
    ["v1.21.0", "1.21"],
    ["v0.299.2", "0.299"],
    ["1.21.0", "1.21"],
    // Anything but a plain version sends nothing: a dev build, extra text, a path.
    ["v1.21.0-dev+abc", undefined],
    ["Databricks CLI v1.21.0", undefined],
    ["/Users/someone/bin/databricks", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("%j is sent as %j", (version, sent) => {
    expect(telemetryCliVersion(version)).toBe(sent);
  });
});

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

describe("legacyCliVersion", () => {
  test.each([
    // The legacy package's own output (databricks_cli/version.py at tag 0.18.0).
    ["Version 0.18.0", "0.18.0"],
    ["Version 0.17.7\n", "0.17.7"],
    ["Version 0.9.1", "0.9.1"],
    // Not the legacy package, or not sure: the neutral wording is used instead.
    ["Version: 0.18.0", undefined],
    ["Version 0.100.0", undefined],
    ["Version 1.0.0", undefined],
    ["Databricks CLI v0.18.0", undefined],
    ["jq-1.7.1", undefined],
    ["Version 0.18.0 extra", undefined],
    ["", undefined],
  ])("%j -> %s", (output, expected) => {
    expect(legacyCliVersion(output)).toBe(expected);
  });
});
