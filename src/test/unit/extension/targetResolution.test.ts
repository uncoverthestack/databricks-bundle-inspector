import { describe, expect, test } from "@jest/globals";
import {
  isVariableResolvedForTarget,
  resolveExpressionForTarget,
  resolveVariableForTarget,
} from "../../../bundle/targetResolution.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";

function bundle(): ParsedBundleConfig {
  return {
    bundle: { name: "demo" },
    variables: {
      warehouse_id: { default: "default-warehouse" },
      no_default: { description: "must be provided per target" },
      resolved_by_cli: { value: "cli-value" },
      lookup_only: { lookup: { warehouse: "main" } },
    },
    targets: {
      dev: {
        variables: {
          warehouse_id: "dev-warehouse",
          no_default: "dev-only",
        },
      },
      prod: {
        variables: {
          warehouse_id: "prod-warehouse",
        },
      },
    },
  };
}

describe("target resolution", () => {
  test("target overrides win over global defaults", () => {
    expect(resolveVariableForTarget(bundle(), "warehouse_id", "dev")).toMatchObject({
      value: "dev-warehouse",
      source: "target_override",
      status: "resolved",
    });
  });

  test("global defaults are used when a target has no override", () => {
    expect(
      resolveVariableForTarget(bundle(), "resolved_by_cli", "prod"),
    ).toMatchObject({
      value: "cli-value",
      source: "cli_resolved",
      status: "resolved",
    });
  });

  test("defined variables without a target value are unresolved for that target", () => {
    expect(isVariableResolvedForTarget(bundle(), "no_default", "prod")).toBe(
      false,
    );
  });

  test("structural preview preserves existing defined-variable behavior", () => {
    expect(isVariableResolvedForTarget(bundle(), "no_default", null)).toBe(true);
  });

  test("expressions resolve bundle target and variables for selected target", () => {
    expect(
      resolveExpressionForTarget(
        "${bundle.target}-${bundle.name}-${var.warehouse_id}",
        bundle(),
        "prod",
      ),
    ).toMatchObject({
      value: "prod-demo-prod-warehouse",
      changed: true,
      unresolvedVariables: [],
    });
  });

  test("unresolved variable expressions are preserved and reported", () => {
    expect(
      resolveExpressionForTarget("${var.missing}", bundle(), "dev"),
    ).toMatchObject({
      value: "${var.missing}",
      changed: false,
      unresolvedVariables: ["missing"],
    });
  });

  test("lookup-only variables are treated as lookup-backed, not missing definitions", () => {
    expect(resolveVariableForTarget(bundle(), "lookup_only", "prod")).toMatchObject({
      source: "lookup",
      status: "lookup",
    });
  });
});
