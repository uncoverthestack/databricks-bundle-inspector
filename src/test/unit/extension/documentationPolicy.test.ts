import { describe, expect, test } from "@jest/globals";
import { decideDocumentationGeneration } from "../../../bundle/documentationPolicy.js";
import type { InspectorIssue } from "../../../bundle/issues.js";

function issue(
  severity: InspectorIssue["severity"],
  id = severity,
): InspectorIssue {
  return {
    id,
    severity,
    kind: "validation_diagnostic",
    title: `${severity} issue`,
  };
}

describe("decideDocumentationGeneration", () => {
  test("allows documentation when there are no errors or warnings", () => {
    expect(decideDocumentationGeneration([])).toEqual({
      action: "allow",
      blockingIssues: [],
      warningIssues: [],
    });
  });

  test("warns when only warning-level issues are present", () => {
    const warning = issue("warning");

    expect(decideDocumentationGeneration([warning])).toEqual({
      action: "warn",
      blockingIssues: [],
      warningIssues: [warning],
    });
  });

  test("blocks when any error-level issue is present", () => {
    const error = issue("error");
    const warning = issue("warning");

    expect(decideDocumentationGeneration([warning, error])).toEqual({
      action: "block",
      blockingIssues: [error],
      warningIssues: [warning],
    });
  });
});
