import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import { findTargetCheckProblems } from "../../../bundle/targetChecks.js";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";

function source(text: string, file = "/b/databricks.yml") {
  return { file, doc: parse(text, { merge: true }), text, locations: parseYamlLocations(file, text) };
}
function findings(text: string, cliOutput: unknown = parse(text), version = "v1.28.0") {
  return findTargetCheckProblems(cliOutput, [source(text)], version).filter((finding) => finding.kind.startsWith("secret_"));
}

describe("plaintext secret checks (#606)", () => {
  test("a target-only literal is reported at its target value without copying it", () => {
    const text = "targets:\n  prod:\n    resources:\n      secrets:\n        s:\n          value: do-not-log-this-value\n";
    const output = parse(text);
    output.targets.prod.resources.secrets.s.value = "[redacted]";
    const result = findings(text, output);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "secret_value_not_variable", yamlPath: "targets.prod.resources.secrets.s.value", location: { line: 6 } });
    expect(JSON.stringify(result)).not.toContain("do-not-log-this-value");
  });

  test.each(["default", "value"])("variables.pw.%s follows the variable's repository default", (field) => {
    const text = `variables:\n  pw:\n    default: do-not-log-this-value\nresources:\n  secrets:\n    s:\n      value: \${variables.pw.${field}}\n`;
    const result = findings(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "secret_variable_has_default", yamlPath: "resources.secrets.s.value", location: { line: 7 } });
    expect(JSON.stringify(result)).not.toContain("do-not-log-this-value");
  });

  test("a target's variable override also counts as plaintext for the full reference form", () => {
    const text = "variables:\n  pw: {}\ntargets:\n  prod:\n    variables:\n      pw: written-here\n    resources:\n      secrets:\n        s:\n          value: ${variables.pw.value}\n";
    expect(findings(text).map((finding) => finding.kind)).toEqual(["secret_variable_has_default"]);
  });

  test("a variable with no repository value stays quiet for both forms", () => {
    for (const expression of ["${var.pw}", "${variables.pw.value}"]) {
      const text = `variables:\n  pw: {}\nresources:\n  secrets:\n    s:\n      value: ${expression}\n`;
      const output = parse(text);
      // A value the CLI obtained from the environment is not a plaintext YAML default.
      output.variables.pw.value = "external-value-not-from-a-file";
      output.resources.secrets.s.value = "[redacted]";
      expect(findings(text, output)).toEqual([]);
    }
  });

  test("each target's own value is checked once, without inventing a root value", () => {
    const text = "variables:\n  pw: {}\ntargets:\n  dev:\n    resources:\n      secrets:\n        s:\n          value: literal\n  prod:\n    resources:\n      secrets:\n        s:\n          value: ${var.pw}\n";
    expect(findings(text).map((finding) => finding.yamlPath)).toEqual(["targets.dev.resources.secrets.s.value"]);
  });

  test("included target-only secret values point at the included file", () => {
    const file = source("targets:\n  prod:\n    resources:\n      secrets:\n        s:\n          value: literal\n", "/b/resources/secrets.yml");
    const result = findTargetCheckProblems(file.doc, [source("bundle: {name: b}\n"), file], "v1.28.0");
    expect(result).toEqual([expect.objectContaining({ kind: "secret_value_not_variable", location: expect.objectContaining({ file: file.file, line: 6 }) })]);
  });

  test("a root secret inherited by a target is not reported twice", () => {
    const text = "resources:\n  secrets:\n    s:\n      value: literal\ntargets:\n  prod:\n    resources:\n      secrets:\n        s:\n          name: renamed\n";
    expect(findings(text)).toHaveLength(1);
  });

  test("an older CLI that drops secrets receives no extra secret findings", () => {
    const text = "targets:\n  prod:\n    resources:\n      secrets:\n        s:\n          value: literal\n";
    expect(findings(text, { resources: {}, targets: { prod: {} } }, "v1.11.0")).toEqual([]);
  });

  test("a target-only secret with no value points at its actual definition", () => {
    const text = "targets:\n  prod:\n    resources:\n      secrets:\n        s:\n          name: credential\n";
    expect(findings(text)).toEqual([expect.objectContaining({
      kind: "secret_value_not_variable", yamlPath: "targets.prod.resources.secrets.s", location: expect.objectContaining({ line: 5 }),
    })]);
  });

  test("the original var form still rejects a repository default", () => {
    const text = "variables:\n  pw:\n    default: literal\nresources:\n  secrets:\n    s:\n      value: ${var.pw}\n";
    expect(findings(text).map((finding) => finding.kind)).toEqual(["secret_variable_has_default"]);
  });
});
