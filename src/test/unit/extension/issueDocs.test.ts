import { describe, expect, test } from "@jest/globals";
import { codeValue, issueDocsUrl } from "../../../bundle/issueDocs.js";

describe("issueDocsUrl", () => {
  test("links the code's section at the installed version's tag", () => {
    expect(issueDocsUrl("missing_file", "0.3.2")).toBe(
      "https://github.com/uncoverthestack/databricks-bundle-inspector/blob/v0.3.2/docs/checks.md#missing_file",
    );
  });

  test("falls back to main when the version is unknown or not a release", () => {
    expect(issueDocsUrl("cli_diagnostic", undefined)).toContain("/blob/main/docs/checks.md#cli_diagnostic");
    expect(issueDocsUrl("cli_diagnostic", "")).toContain("/blob/main/");
    expect(issueDocsUrl("cli_diagnostic", "unknown")).toContain("/blob/main/");
  });
});

describe("codeValue", () => {
  test("reads a code held as a value or as { value, target }", () => {
    expect(codeValue("widget_not_set")).toBe("widget_not_set");
    expect(codeValue({ value: "widget_not_set" })).toBe("widget_not_set");
    expect(codeValue(undefined)).toBeUndefined();
  });
});
