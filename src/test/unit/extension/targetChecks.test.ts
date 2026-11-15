import { describe, expect, test } from "@jest/globals";
import { parse } from "yaml";
import { parseYamlLocations } from "../../../bundle/sourceLocations.js";
import { findTargetCheckProblems, isPureReference, variableReferences } from "../../../bundle/targetChecks.js";

// The real CLI's answer for each rule is in targetChecks.integration.test.ts; these are the
// edge cases around it.

const sourceFile = (text: string, file = "/b/databricks.yml") => ({ file, doc: parse(text, { merge: true }), text, locations: parseYamlLocations(file, text) });

/** The findings for a bundle written as one databricks.yml, with the CLI's output given separately when it differs. */
function check(text: string, cliVersion?: string, cliOutput: unknown = parse(text, { merge: true })) {
  return findTargetCheckProblems(cliOutput, [sourceFile(text)], cliVersion).map((finding) => ({
    kind: finding.kind,
    path: finding.yamlPath,
    line: finding.location?.line,
  }));
}

describe("variable references, as the CLI matches them", () => {
  test("finds each reference, with indexes, and skips $${...} from v1.15.0", () => {
    expect(variableReferences("${var.a} and ${resources.jobs.j.tasks[0].id}")).toEqual(["var.a", "resources.jobs.j.tasks[0].id"]);
    expect(variableReferences("echo $${HOME} ${bundle.name}")).toEqual(["bundle.name"]);
    expect(variableReferences("echo $${HOME}", false)).toEqual(["HOME"]);
  });

  test("ignores text that isn't a reference", () => {
    expect(variableReferences("${} ${1abc} $var.a {var.a} ${var.}")).toEqual([]);
  });

  test("a secret's value must be one reference and nothing else", () => {
    expect(isPureReference("${var.api_key}")).toBe(true);
    expect(isPureReference("key-${var.api_key}")).toBe(false);
    expect(isPureReference("${var.a}${var.b}")).toBe(false);
    expect(isPureReference("")).toBe(false);
  });
});

describe("findTargetCheckProblems", () => {
  test("a target's override is checked at the target's line", () => {
    const text = "bundle:\n  name: b\ntargets:\n  prod:\n    bundle:\n      engine: terraform\n    workspace:\n      host: https://${var.host}\n";
    expect(check(text)).toEqual([
      { kind: "variable_in_auth_field", path: "targets.prod.workspace.host", line: 8 },
      { kind: "terraform_engine_removed", path: "targets.prod.bundle.engine", line: 6 },
    ]);
  });

  test("the Terraform rules apply from v1.20.0, and when the version can't be read", () => {
    const text = "bundle:\n  name: b\n  engine: terraform\n  terraform:\n    exec_path: /tf\n";
    expect(check(text, "v1.19.0")).toEqual([]);
    const both = [
      { kind: "terraform_engine_removed", path: "bundle.engine", line: 3 },
      { kind: "terraform_setting_has_no_effect", path: "bundle.terraform", line: 4 },
    ];
    expect(check(text, "v1.20.0")).toEqual(both);
    expect(check(text, undefined)).toEqual(both);
    expect(check(text, "not a version")).toEqual(both);
  });

  test("an empty or missing engine is fine, and before v1.20.0 terraform is a valid engine", () => {
    expect(check("bundle:\n  engine: \"\"\n")).toEqual([]);
    expect(check("bundle:\n  engine: direct\n")).toEqual([]);
    expect(check("bundle:\n  engine: terraform\n", "v0.299.2")).toEqual([]);
  });

  test("a script with no content key at all is reported at the script", () => {
    expect(check("scripts:\n  hello:\n    env:\n      A: x\n")).toEqual([{ kind: "script_no_content", path: "scripts.hello", line: 2 }]);
  });

  test("a script's env may use bundle, workspace and var values", () => {
    const text = "scripts:\n  s:\n    content: echo $A\n    env:\n      A: ${bundle.name}\n      B: ${workspace.root_path}\n      C: ${var.x}\n      D: ${variables.x.value}\n";
    expect(check(text)).toEqual([]);
  });

  test("only reports the first reference in a script's content, once", () => {
    expect(check("scripts:\n  s:\n    content: echo ${var.a} ${var.b}\n")).toEqual([{ kind: "variable_in_script_content", path: "scripts.s.content", line: 3 }]);
  });

  test("an internal resource group with no entries is fine", () => {
    expect(check("resources:\n  internal_immutable_snapshots: {}\n")).toEqual([]);
  });

  test("non-text sign-in settings are not checked", () => {
    expect(check("workspace:\n  azure_use_msi: true\n  host: https://example.cloud.databricks.com\n")).toEqual([]);
  });

  test("secrets are read from the YAML, as the CLI's output hides each value", () => {
    const text = [
      "variables:",
      "  key:",
      "    lookup:",
      "      service_principal: sp",
      "resources:",
      "  secrets:",
      "    a:",
      "      value: ${var.key}",
      "targets:",
      "  prod:",
      "    resources:",
      "      secrets:",
      "        a:",
      "          value: written-here",
      "",
    ].join("\n");
    const output = parse(text);
    output.resources.secrets.a.value = "[redacted]";
    // A lookup isn't a default; the target's plain-text value is reported where it's written.
    expect(check(text, undefined, output)).toEqual([{ kind: "secret_value_not_variable", path: "targets.prod.resources.secrets.a.value", line: 14 }]);
  });

  test("secret rules only run when the CLI's output has secrets, so an older CLI that drops them gets none", () => {
    const text = "resources:\n  secrets:\n    a:\n      value: written-here\n";
    expect(check(text, "v1.11.0", { resources: {} })).toEqual([]);
  });

  test("a secret whose value is a number is reported", () => {
    expect(check("resources:\n  secrets:\n    a:\n      value: 1234\n")).toEqual([{ kind: "secret_value_not_variable", path: "resources.secrets.a.value", line: 4 }]);
  });

  test("a key reached through a YAML merge has no line", () => {
    const text = "base: &base\n  engine: banana\nbundle:\n  <<: *base\n  name: b\n";
    expect(check(text)).toEqual([{ kind: "invalid_engine", path: "bundle.engine", line: undefined }]);
  });

  test("a key in an included file is found there", () => {
    const root = sourceFile("bundle:\n  name: b\ninclude:\n  - resources/*.yml\n");
    const job = sourceFile("resources:\n  jobs:\n    nightly:\n", "/b/resources/job.yml");
    const [finding] = findTargetCheckProblems({ bundle: { name: "b" }, resources: { jobs: { nightly: null } } }, [root, job]);
    expect(finding?.location).toEqual({ file: "/b/resources/job.yml", line: 3, column: 5 });
  });
});
