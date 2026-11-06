import { describe, expect, test } from "@jest/globals";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { variableLoopIssues } from "../../../bundle/issues.js";
import { findVariableLoops } from "../../../bundle/variableLoops.js";

// Each case as `bundle validate -o json` prints it with no target (CLI v1.24.0): defaults
// under `variables`, overrides under `targets.<name>.variables` in their full form. The
// expected result per target is what `bundle validate -t <target>` did on CLI v1.24.0;
// variableLoopsCli.integration.test.ts checks the same cases against the CLI itself.

const twoTargets = { dev: { default: true }, prod: {} };

function bundle(variables: Record<string, unknown>, targets: Record<string, unknown> = twoTargets): ParsedBundleConfig {
  return { bundle: { name: "loops" }, variables, targets } as unknown as ParsedBundleConfig;
}

/** Per loop: its path, error or warning, and the targets it fails. */
function loops(config: ParsedBundleConfig) {
  return findVariableLoops(config).map((loop) => ({
    path: loop.path.join(" -> "),
    severity: loop.complex ? "warning" : "error",
    targets: loop.everyTarget ? "every target" : loop.targets,
  }));
}

describe("findVariableLoops", () => {
  test("two defaults that refer to each other fail every target", () => {
    expect(loops(bundle({ a: { default: "${var.b}" }, b: { default: "${var.a}" } }))).toEqual([
      { path: "a -> b -> a", severity: "error", targets: "every target" },
    ]);
  });

  test("a variable that refers to itself", () => {
    expect(loops(bundle({ a: { default: "${var.a}" } }))).toEqual([{ path: "a -> a", severity: "error", targets: "every target" }]);
  });

  test("a reference inside longer text still closes the loop", () => {
    expect(loops(bundle({ a: { default: "pre_${var.b}" }, b: { default: "${var.a}_x" } }))).toEqual([
      { path: "a -> b -> a", severity: "error", targets: "every target" },
    ]);
  });

  test("three variables in a ring", () => {
    expect(loops(bundle({ a: { default: "${var.b}" }, b: { default: "${var.c}" }, c: { default: "${var.a}" } }))).toEqual([
      { path: "a -> b -> c -> a", severity: "error", targets: "every target" },
    ]);
  });

  test("a chain that ends in a value is not a loop", () => {
    expect(loops(bundle({ a: { default: "${var.b}" }, b: { default: "${var.c}" }, c: { default: "main" } }))).toEqual([]);
  });

  test("a loop between variables nothing uses still fails", () => {
    expect(loops(bundle({ a: { default: "main" }, x: { default: "${var.y}" }, y: { default: "${var.x}" } }))).toEqual([
      { path: "x -> y -> x", severity: "error", targets: "every target" },
    ]);
  });

  test("an override can make a loop in one target only", () => {
    const config = bundle(
      { a: { default: "main" }, b: { default: "${var.a}" } },
      { dev: { default: true, variables: { a: { default: "${var.b}" } } }, prod: {} },
    );
    expect(loops(config)).toEqual([{ path: "a -> b -> a", severity: "error", targets: ["dev"] }]);
    expect(findVariableLoops(config)[0]?.overrideTarget).toEqual({ a: "dev", b: undefined });
  });

  test("an override can break a loop in one target", () => {
    const config = bundle(
      { a: { default: "${var.b}" }, b: { default: "${var.a}" } },
      { dev: { default: true, variables: { b: { default: "main" } } }, prod: {} },
    );
    expect(loops(config)).toEqual([{ path: "a -> b -> a", severity: "error", targets: ["prod"] }]);
  });

  test("an override written as the value itself counts too", () => {
    const config = bundle({ a: { default: "main" }, b: { default: "${var.a}" } }, { dev: { variables: { a: "${var.b}" } } });
    expect(loops(config)).toEqual([{ path: "a -> b -> a", severity: "error", targets: "every target" }]);
  });

  test("a bundle with no targets", () => {
    expect(loops(bundle({ a: { default: "${var.b}" }, b: { default: "${var.a}" } }, {}))).toEqual([
      { path: "a -> b -> a", severity: "error", targets: "every target" },
    ]);
  });

  test("a loop through one field of a complex value fails", () => {
    expect(loops(bundle({ a: { type: "complex", default: { x: "${var.b}" } }, b: { default: "${var.a.x}" } }))).toEqual([
      { path: "a.x -> b -> a.x", severity: "error", targets: "every target" },
    ]);
  });

  test("references between different fields are not a loop", () => {
    expect(loops(bundle({ a: { type: "complex", default: { x: "main", y: "${var.b}" } }, b: { default: "${var.a.x}" } }))).toEqual([]);
  });

  test("a loop through a whole complex value only warns", () => {
    expect(loops(bundle({ a: { type: "complex", default: { hello: "${var.a}" } } }))).toEqual([
      { path: "a.hello -> a.hello", severity: "warning", targets: "every target" },
    ]);
    expect(
      loops(bundle({ a: { type: "complex", default: { hello: "${var.b}" } }, b: { default: "${var.a}" } })).map((loop) => loop.severity),
    ).toEqual(["warning"]);
    expect(
      loops(
        bundle({ a: { type: "complex", default: { hello: "${var.b}" } }, b: { type: "complex", default: { hello: "${var.a}" } } }),
      ).map((loop) => loop.severity),
    ).toEqual(["warning"]);
  });

  test("a reference to a variable or field that doesn't exist is left to unresolved_variable", () => {
    expect(loops(bundle({ a: { default: "${var.nope}" }, b: { type: "complex", default: { x: "${var.b.missing}" } } }))).toEqual([]);
  });

  test("a lookup or a variable with no default has nothing to follow", () => {
    expect(loops(bundle({ a: { lookup: { warehouse: "w" } }, b: { description: "set elsewhere" } }))).toEqual([]);
  });
});

describe("variableLoopIssues", () => {
  const sources = {
    a: { definition: { file: "/b/databricks.yml", line: 4, column: 14 }, targets: { dev: { file: "/b/databricks.yml", line: 12, column: 10 } } },
    b: { definition: { file: "/b/databricks.yml", line: 6, column: 14 }, targets: {} },
  };

  test("one error per variable in the loop, at its default's line, naming every target", () => {
    const issues = variableLoopIssues(bundle({ a: { default: "${var.b}" }, b: { default: "${var.a}" } }), sources);
    expect(issues.map((issue) => [issue.kind, issue.severity, issue.detail, issue.line])).toEqual([
      ["variable_reference_loop", "error", "a", 4],
      ["variable_reference_loop", "error", "b", 6],
    ]);
    expect(issues[0]?.title).toBe("Variables refer to each other in a loop: a → b → a.");
    expect(issues[0]?.fixHint).toContain("fail on every target");
  });

  test("an override's loop sits at the override's line and names its target", () => {
    const issues = variableLoopIssues(
      bundle({ a: { default: "main" }, b: { default: "${var.a}" } }, { dev: { variables: { a: { default: "${var.b}" } } }, prod: {} }),
      sources,
    );
    expect(issues.map((issue) => [issue.detail, issue.line, issue.yamlPath])).toEqual([
      ["a", 12, "targets.dev.variables.a"],
      ["b", 6, "variables.b"],
    ]);
    expect(issues[0]?.fixHint).toContain('fail on target "dev"');
  });

  test("a loop through a complex value is a warning that says the text may stay", () => {
    const [issue] = variableLoopIssues(bundle({ a: { type: "complex", default: { hello: "${var.a}" } } }), sources);
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixHint).toContain("${var...} text may stay");
  });
});
