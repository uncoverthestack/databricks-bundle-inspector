import { describe, test, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../../../bundle/issues.js";

const bundleRoot = path.resolve(__dirname, "../../fixtures/schema-renamed-in-target");
const RESOURCE_FILES = ["resources/schemas.yml"];

// The structural preview keeps names as written and lists every target with its mode and
// presets (checked with `bundle validate -o json`, CLI v1.25.0), so the fixture YAML stands
// in for the CLI output. Both targets pass validate.
function fixtureConfig(targets: Record<string, unknown>, extra: Record<string, unknown> = {}): ParsedBundleConfig {
  const parsed = parse(readFileSync(path.join(bundleRoot, RESOURCE_FILES[0]!), "utf8")) as { resources: Record<string, unknown> };
  return {
    bundle: { name: "schema_renamed_in_target" },
    include: RESOURCE_FILES,
    resources: parsed.resources,
    targets,
    ...extra,
  } as unknown as ParsedBundleConfig;
}

async function findings(config: ParsedBundleConfig, targetName?: string): Promise<InspectorIssue[]> {
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
  return buildInspectorIssues(graph, config, [], bundleRoot, targetName).filter((issue) => issue.kind === "schema_renamed_in_target");
}

function summary(issue: InspectorIssue): string {
  const file = path.relative(bundleRoot, issue.file ?? "").split(path.sep).join("/");
  return `${issue.taskName ?? issue.resourceId}: ${issue.title} @ ${file}:${issue.line}`;
}

const FIXTURE_TARGETS = { dev: { mode: "development", default: true }, staging: {} };
const IN_DEV = 'in target "dev" it deploys as "dev_<you>_dbi_sales", so this name may not exist there.';

describe("schema names a target renames (issue 235)", () => {
  // See the fixture README for why each case is or isn't reported.
  test("reports written names in code and parameters, once per file or parameter", async () => {
    expect((await findings(fixtureConfig(FIXTURE_TARGETS))).map(summary).sort()).toEqual([
      `literal_parameter: Parameter "schema" names schema "dbi_sales", which this bundle defines; ${IN_DEV} @ resources/schemas.yml:30`,
      `literal_parameter: Parameter "table" names schema "dbi_sales", which this bundle defines; ${IN_DEV} @ resources/schemas.yml:31`,
      `python_code: Code names schema "dbi_sales", which this bundle defines; ${IN_DEV} @ src/writes_table.py:7`,
      `resources.jobs.uses_schema: Job parameter "target_schema" names schema "dbi_sales", which this bundle defines; ${IN_DEV} @ resources/schemas.yml:10`,
      `sql_code: Code names schema "dbi_sales", which this bundle defines; ${IN_DEV} @ src/reads_table.sql:2`,
    ]);
  });

  test("says how to fix it with the schema's own reference", async () => {
    const issues = await findings(fixtureConfig(FIXTURE_TARGETS));
    expect(issues.find((issue) => issue.taskName === "python_code")?.fixHint).toBe(
      "Pass ${resources.schemas.sales.name} to the task as a parameter and read it in the code, instead of writing the name.",
    );
    expect(issues.find((issue) => issue.taskName === "literal_parameter")?.fixHint).toBe(
      "Use ${resources.schemas.sales.name} instead of the written name.",
    );
  });

  test("says nothing when no target renames schemas", async () => {
    expect(await findings(fixtureConfig({ staging: {}, prod: { mode: "production" } }))).toEqual([]);
    // A target's empty prefix wins over the bundle's (CLI v1.25.0).
    expect(await findings(fixtureConfig({ qa: { presets: { name_prefix: "" } } }, { presets: { name_prefix: "root_" } }))).toEqual([]);
    expect(await findings(fixtureConfig(FIXTURE_TARGETS, { experimental: { skip_name_prefix_for_schema: true } }))).toEqual([]);
    expect(await findings(fixtureConfig({ odd: { presets: { name_prefix: "[ ] " } } }))).toEqual([]);
  });

  test("names the targets that rename, and doesn't guess a custom prefix's result", async () => {
    const [qa] = await findings(fixtureConfig({ qa: { presets: { name_prefix: "qa_" } } }));
    expect(qa?.title).toContain('in target "qa" it deploys with the target\'s name prefix, so');
    // Development mode with the bundle's prefix uses that prefix, not dev_<you>_ (CLI v1.25.0).
    const [devRoot] = await findings(fixtureConfig({ dev: { mode: "development" } }, { presets: { name_prefix: "root_" } }));
    expect(devRoot?.title).toContain('in target "dev" it deploys with the target\'s name prefix, so');
    // An empty prefix in development mode still gives dev_<you>_ (CLI v1.24.0, issue 235).
    const [devEmpty] = await findings(fixtureConfig({ dev: { mode: "development", presets: { name_prefix: "" } } }));
    expect(devEmpty?.title).toContain('"dev_<you>_dbi_sales"');
    const [both] = await findings(fixtureConfig({ dev: { mode: "development" }, qa: { presets: { name_prefix: "qa_" } } }));
    expect(both?.title).toContain('targets "dev", "qa" deploy it with a name prefix, so');
  });

  test("is not checked with a target, where the CLI has already renamed the schemas", async () => {
    expect(await findings(fixtureConfig(FIXTURE_TARGETS), "dev")).toEqual([]);
  });

  test("a schema named by a variable is skipped", async () => {
    const config = fixtureConfig(FIXTURE_TARGETS);
    (config.resources!.schemas as Record<string, { name: string }>).sales!.name = "${var.schema}";
    expect(await findings(config)).toEqual([]);
  });
});
