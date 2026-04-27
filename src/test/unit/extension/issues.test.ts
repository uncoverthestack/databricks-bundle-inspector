import { describe, expect, test } from "@jest/globals";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import type {
  BundleGraph,
  ParsedBundleConfig,
} from "../../../bundle/graph/bundleGraph.js";
import type { ValidationIssue } from "../../../bundle/validateBundle.js";

describe("buildInspectorIssues", () => {
  test("normalizes unknown field CLI diagnostics without wrapper detail", () => {
    const graph: BundleGraph = { nodes: [], edges: [] };
    const parsedBundle: ParsedBundleConfig = { bundle: { name: "demo" } };
    const validationIssues: ValidationIssue[] = [
      {
        code: "BUNDLE_DIAGNOSTICS",
        message: "Databricks CLI reported bundle diagnostics.",
        diagnostics: [
          {
            severity: "warning",
            message: "unknown field: desription",
          },
        ],
      },
    ];

    expect(
      buildInspectorIssues(
        graph,
        parsedBundle,
        validationIssues,
        "/workspace/demo",
      ),
    ).toEqual([
      {
        id: "validation:0:0",
        severity: "warning",
        kind: "unknown_or_deprecated_field",
        title: "Unknown or deprecated field",
        detail: "desription",
        fixHint:
          "Remove the field or update it to a Databricks Bundle field supported by your CLI version.",
      },
    ]);
  });
});
