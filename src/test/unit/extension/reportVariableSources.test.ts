import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { outsideReportVariables } from "../../../bundle/reportVariableSources.js";

const root = mkdtempSync(path.join(os.tmpdir(), "dbi-report-sources-"));
const dir = path.join(root, ".databricks", "bundle", "dev");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("report variable provenance", () => {
  test("captures environment variable names, including empty values, but never their values", () => {
    expect(outsideReportVariables(undefined, "dev", { BUNDLE_VAR_lookup: "private", BUNDLE_VAR_empty: "", BUNDLE_VAR_unset: undefined, OTHER: "private" })).toEqual([{ name: "lookup", source: "environment" }, { name: "empty", source: "environment" }]);
  });
  test("captures keys from the target's local overrides file, not its values", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "variable-overrides.json"), JSON.stringify({ lookup: "private", complex: { token: "private" } }));
    expect(outsideReportVariables(root, "dev", {})).toEqual([{ name: "lookup", source: "file" }, { name: "complex", source: "file" }]);
    expect(outsideReportVariables(root, "prod", {})).toEqual([]);
  });
  test("unreadable provenance means values are withheld rather than assumed safe", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "variable-overrides.json"), "not JSON");
    expect(outsideReportVariables(root, "dev", {})).toEqual([{ name: "*", source: "file" }]);
  });
});
