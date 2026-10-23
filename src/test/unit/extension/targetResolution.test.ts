import { describe, expect, test } from "@jest/globals";
import {
  isVariableResolvedForTarget,
  resolveExpressionForTarget,
  resolveVariableForTarget,
  splitVariableReference,
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

// Values the CLI gives for the same references, with a workspace to resolve
// against (CLI 1.21.0; acceptance tests variables/complex and
// resolve-field-within-complex; "reference does not exist" for a missing field).
describe("fields and items of complex variables", () => {
  const complexBundle = (): ParsedBundleConfig =>
    ({
      bundle: { name: "demo" },
      variables: {
        c: { type: "complex", default: { a: { b: "c_a_b" }, list: [{ x: "x0" }, { x: "x1" }] } },
        l: { type: "complex", default: ["l0", "l1"] },
        req: { description: "set by each target" },
        lk: { lookup: { cluster: "shared" } },
      },
      targets: {
        short: { variables: { c: { a: { b: "short_b" }, list: [] }, req: "set" } },
        full: { variables: { c: { default: { a: { b: "full_b" } } } } },
      },
    }) as unknown as ParsedBundleConfig;

  test("splits a reference into the variable and the path into its value", () => {
    expect(splitVariableReference("s")).toEqual({ name: "s", path: [] });
    expect(splitVariableReference("c.a.b")).toEqual({ name: "c", path: ["a", "b"] });
    expect(splitVariableReference("c.list[1].x")).toEqual({ name: "c", path: ["list", 1, "x"] });
    expect(splitVariableReference("l[0]")).toEqual({ name: "l", path: [0] });
    expect(splitVariableReference("my-var")).toEqual({ name: "my-var", path: [] });
  });

  test("reads a field, a list item and an item's field from the default", () => {
    expect(resolveVariableForTarget(complexBundle(), "c.a.b", null)).toMatchObject({ value: "c_a_b", source: "global_default", status: "resolved" });
    expect(resolveVariableForTarget(complexBundle(), "c.list[1].x", null)).toMatchObject({ value: "x1", status: "resolved" });
    expect(resolveVariableForTarget(complexBundle(), "l[0]", null)).toMatchObject({ value: "l0", status: "resolved" });
    expect(isVariableResolvedForTarget(complexBundle(), "c.list[1].x", null)).toBe(true);
  });

  test("reads fields from a target's shorthand and full-form overrides", () => {
    expect(resolveVariableForTarget(complexBundle(), "c.a.b", "short")).toMatchObject({ value: "short_b", source: "target_override" });
    expect(resolveVariableForTarget(complexBundle(), "c.a.b", "full")).toMatchObject({ value: "full_b", source: "target_override" });
  });

  test("a field or item the value doesn't have is unresolved, as the CLI reports it", () => {
    expect(resolveVariableForTarget(complexBundle(), "c.nope", null).status).toBe("unresolved");
    expect(resolveVariableForTarget(complexBundle(), "l[5]", null).status).toBe("unresolved");
    expect(resolveVariableForTarget(complexBundle(), "c.list[0].x", "short").status).toBe("unresolved");
    expect(isVariableResolvedForTarget(complexBundle(), "c.nope", null)).toBe(false);
  });

  test("reads a target's mapping as the full form only when every key is a variable setting", () => {
    // CLI 1.21.0: {a: x} and {default: x, a: y} are values; {default: x} and {description, default} are full forms.
    const b = {
      bundle: { name: "demo" },
      variables: { c: { type: "complex", default: { a: "base" } }, s: { default: "base" } },
      targets: {
        shorthand: { variables: { c: { a: "shorthand_map" } } },
        full: { variables: { c: { default: { a: "full_form" } }, s: { default: "string_full" } } },
        mixed: { variables: { c: { default: "has_default_key", a: "other" } } },
        described: { variables: { c: { description: "d", default: { a: "described" } } } },
      },
    } as unknown as ParsedBundleConfig;
    expect(resolveVariableForTarget(b, "c.a", "shorthand").value).toBe("shorthand_map");
    expect(resolveVariableForTarget(b, "c.a", "full").value).toBe("full_form");
    expect(resolveVariableForTarget(b, "s", "full").value).toBe("string_full");
    expect(resolveVariableForTarget(b, "c.a", "mixed").value).toBe("other");
    expect(resolveVariableForTarget(b, "c.default", "mixed").value).toBe("has_default_key");
    expect(resolveVariableForTarget(b, "c.a", "described").value).toBe("described");
  });

  test("a field of a lookup is not judged: its value is only known with a login", () => {
    expect(resolveVariableForTarget(complexBundle(), "lk.anything", null).status).toBe("lookup");
  });

  test("no default is unset in the preview and unresolved in a target that doesn't set it", () => {
    expect(resolveVariableForTarget(complexBundle(), "req", null)).toMatchObject({ source: "no_default", status: "unset" });
    expect(isVariableResolvedForTarget(complexBundle(), "req", null)).toBe(true);
    expect(resolveVariableForTarget(complexBundle(), "req", "full").status).toBe("unresolved");
    expect(resolveVariableForTarget(complexBundle(), "req", "short")).toMatchObject({ value: "set", source: "target_override" });
  });

  test("expressions fill in fields", () => {
    expect(resolveExpressionForTarget("pre-${var.c.a.b}-${var.l[1]}", complexBundle(), null).value).toBe("pre-c_a_b-l1");
  });
});

// In a target the CLI's output has `default` (from the bundle files, the target's
// override merged in) and `value` (what deploys). A BUNDLE_VAR_ environment variable
// or variable-overrides.json changes only `value` (CLI 1.21.0).
describe("values set outside the bundle files", () => {
  const fromTarget = (value: string, merged: string, override?: string): ParsedBundleConfig =>
    ({
      bundle: { name: "demo" },
      variables: { s: { default: merged, value } },
      targets: { t: { variables: override === undefined ? {} : { s: override } } },
    }) as unknown as ParsedBundleConfig;

  test("an override the CLI used is the target's", () => {
    expect(resolveVariableForTarget(fromTarget("s_short", "s_short", "s_short"), "s", "t")).toMatchObject({ value: "s_short", source: "target_override" });
  });

  test("an environment variable or overrides file that beats the target's override shows the CLI's value", () => {
    expect(resolveVariableForTarget(fromTarget("s_from_env", "s_short", "s_short"), "s", "t")).toMatchObject({ value: "s_from_env", source: "outside_files" });
  });

  test("one that beats the default with no override shows the CLI's value", () => {
    expect(resolveVariableForTarget(fromTarget("s_from_env", "s_default"), "s", "t")).toMatchObject({ value: "s_from_env", source: "outside_files" });
  });

  test("a default the CLI used stays resolved, and complex values compare whatever the key order", () => {
    expect(resolveVariableForTarget(fromTarget("s_default", "s_default"), "s", "t").source).toBe("cli_resolved");
    const complex = {
      bundle: { name: "demo" },
      variables: { c: { default: { a: 1, b: 2 }, value: { b: 2, a: 1 } } },
      targets: { t: { variables: { c: { a: 1, b: 2 } } } },
    } as unknown as ParsedBundleConfig;
    expect(resolveVariableForTarget(complex, "c.b", "t")).toMatchObject({ value: "2", source: "target_override" });
  });
});
