import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { resolveVariableForTarget } from "../../../bundle/targetResolution.js";
import { variableSourceLocation } from "../../../webview/lib/variableSource.js";

// The two variable fixtures, read from the Databricks CLI's own output (validated-bundle.json,
// structural preview). Expected values are what CLI 1.21.0 deploys; see each fixture's README.

async function load(fixture: string) {
  const root = path.resolve("src/test/fixtures", fixture);
  const bundle = JSON.parse(readFileSync(path.join(root, "validated-bundle.json"), "utf8")) as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(bundle, root));
  const issues = buildInspectorIssues(graph, bundle, [], root);
  const tasks = new Map(
    graph.nodes.filter((node) => node.nodeType === "task").map((node) => [node.id.split(".").pop()!, node]),
  );
  /** What the task panel shows for one of a task's references, and the line its click opens. */
  const panel = (task: string, reference: string, target: string | null = null) => {
    const ref = tasks.get(task)?.taskData?.variableReferences.find((r) => r.variableName === reference);
    if (!ref) throw new Error(`${task} has no reference ${reference}`);
    const resolution = resolveVariableForTarget(bundle, reference, target);
    const location = variableSourceLocation(
      graph.variableSources,
      reference,
      resolution.source === "target_override" ? target : null,
    );
    const problem = issues.some(
      (issue) => issue.kind === "unresolved_variable" && issue.taskId === tasks.get(task)!.id && issue.detail === reference,
    );
    return {
      value: resolution.value,
      source: resolution.source,
      problem,
      opens: location && `${path.relative(root, location.file).split(path.sep).join("/")}:${location.line}`,
    };
  };
  /** `file:line` of the one line in a fixture file that contains `text`. */
  const lineOf = (file: string, text: string) => {
    const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
    const matches = lines.flatMap((line, index) => (line.includes(text) ? [index + 1] : []));
    if (matches.length !== 1) throw new Error(`${file} has ${matches.length} lines with ${text}`);
    return `${file}:${matches[0]}`;
  };
  return { panel, lineOf, issues };
}

describe("variables fixture, structural preview", () => {
  test("plain values show their default and open its line", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("whole_values", "catalog")).toEqual({ value: "main", source: "global_default", problem: false, opens: lineOf("databricks.yml", "default: main") });
    expect(panel("whole_values", "retries")).toMatchObject({ value: "3", opens: lineOf("databricks.yml", "default: 3") });
    expect(panel("inside_strings", "schema")).toMatchObject({ value: "raw", opens: lineOf("databricks.yml", "default: raw") });
  });

  test("a variable from an included file, and one the last included file sets, open those files", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("whole_values", "from_include")).toMatchObject({ value: "defined_in_an_include", opens: lineOf("resources/shared_vars.yml", "default: defined_in_an_include") });
    expect(panel("whole_values", "duplicated")).toMatchObject({ value: "from_the_last_included_file", opens: lineOf("resources/zz_later.yml", "default: from_the_last_included_file") });
  });

  test("fields and items of complex variables show their value, with no problem", async () => {
    const { panel, lineOf } = await load("variables");
    // A block default opens at its first line.
    const cluster = lineOf("databricks.yml", "node_type_id: i3.xlarge");
    expect(panel("complex_fields", "cluster.node_type_id")).toEqual({ value: "i3.xlarge", source: "global_default", problem: false, opens: cluster });
    expect(panel("complex_fields", "cluster.custom_tags.owner")).toMatchObject({ value: "data-platform", problem: false });
    expect(panel("complex_fields", "cluster.init_scripts[0].workspace.destination")).toMatchObject({ value: "/Shared/init.sh", problem: false });
    expect(panel("complex_fields", "regions[1]")).toMatchObject({ value: "us-west-2", problem: false, opens: lineOf("databricks.yml", "- us-east-1") });
    expect(panel("complex_fields", "labels.team")).toMatchObject({ value: "data", problem: false });
  });

  test("no default is NO DEFAULT, not a problem: a target sets it", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("whole_values", "owner_email")).toEqual({ value: undefined, source: "no_default", problem: false, opens: lineOf("databricks.yml", "description: No default. Every target sets it.") });
  });

  test("a lookup opens its lookup", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("lookup_value", "warehouse_id")).toMatchObject({ source: "lookup", problem: false, opens: lineOf("databricks.yml", "warehouse: shared-warehouse") });
  });

  test("the fixture reports no unresolved variable", async () => {
    const { issues } = await load("variables");
    expect(issues.filter((issue) => issue.kind === "unresolved_variable")).toEqual([]);
  });
});

// The panel with a target picked reads the same targets section; the values are the CLI's for each target.
describe("variables fixture, with a target picked", () => {
  test("staging: a full-form override, a complex shorthand, and an override from an included file", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("whole_values", "catalog", "staging")).toMatchObject({ value: "staging_catalog", source: "target_override", opens: lineOf("databricks.yml", "default: staging_catalog") });
    expect(panel("complex_fields", "cluster.node_type_id", "staging")).toMatchObject({ value: "i3.2xlarge", source: "target_override" });
    expect(panel("complex_fields", "cluster.init_scripts[0].workspace.destination", "staging")).toMatchObject({ value: "/Shared/staging-init.sh" });
    expect(panel("inside_strings", "schema", "staging")).toMatchObject({ value: "staging_schema_from_include", opens: lineOf("resources/shared_vars.yml", "schema: staging_schema_from_include") });
  });

  test("qa: the later anchor in a merge wins, and opens where the anchor writes it", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("whole_values", "catalog", "qa")).toMatchObject({ value: "catalog_from_later_anchor", opens: lineOf("databricks.yml", "catalog: catalog_from_later_anchor") });
  });

  test("prod: a mapping with a non-setting key is the value, and a repeated key keeps the last", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("complex_fields", "labels.team", "prod")).toMatchObject({ value: "prod-team", opens: lineOf("databricks.yml", "labels: {default: kept_as_a_field") });
    expect(panel("whole_values", "retries", "prod")).toMatchObject({ value: "5", opens: lineOf("databricks.yml", "retries: 5") });
  });

  test("dev: no override, so the default", async () => {
    const { panel, lineOf } = await load("variables");
    expect(panel("whole_values", "catalog", "dev")).toMatchObject({ value: "main", opens: lineOf("databricks.yml", "default: main") });
    expect(panel("whole_values", "owner_email", "dev")).toMatchObject({ value: "dev-team@example.com", source: "target_override" });
  });
});

describe("variable-mistakes fixture, structural preview", () => {
  test("a missing field, an undefined variable and a misspelled one are problems", async () => {
    const { panel } = await load("variable-mistakes");
    expect(panel("missing_field", "cluster.nope")).toMatchObject({ source: "unresolved", problem: true });
    expect(panel("undefined_variable", "not_defined")).toMatchObject({ source: "unresolved", problem: true, opens: undefined });
    expect(panel("misspelled_variable", "clustr.node_type_id")).toMatchObject({ source: "unresolved", problem: true });
  });

  test("a required variable is not a problem in the preview: a target or the environment may set it", async () => {
    const { panel } = await load("variable-mistakes");
    expect(panel("required_never_set", "needs_value")).toMatchObject({ source: "no_default", problem: false });
  });

  test.todo("a cycle between defaults (loop_a, loop_b) is reported, as the CLI fails every target on it (#228)");
});
