import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

// Expected answers for c0 to c7 come from the live run in the fixture README (issue 539,
// 2026-11-24, CLI v1.27.0, two runs): a warning on exactly the tasks whose run failed.
// `bundle validate --target __bundle_inspector_probe__` returns the fixture's YAML with the
// same content (only key order differs), so the YAML stands in for the CLI output.
const bundleRoot = path.resolve(__dirname, "../../fixtures/pipeline-selection");

async function findings(edit: (text: string) => string = (text) => text): Promise<string[]> {
  const text = edit(readFileSync(path.join(bundleRoot, "resources/selection.yml"), "utf8"));
  const config = {
    bundle: { name: "pipeline_selection" },
    include: ["resources/selection.yml"],
    resources: (parse(text) as { resources: ParsedBundleConfig["resources"] }).resources,
  } as ParsedBundleConfig;
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, bundleRoot));
  return buildInspectorIssues(graph, config, [], bundleRoot)
    .filter((issue) => issue.kind === "pipeline_selection_not_found")
    .map((issue) => `${issue.taskName}: ${issue.title} @ ${path.basename(issue.file ?? "")}:${issue.line}`)
    .sort();
}

describe("pipeline task selections (issue 539)", () => {
  test("warns on exactly the selections that failed live, and the three cases added here", async () => {
    expect(await findings()).toEqual([
      'c10_loop: Rename "t_silvr" in refresh_selection: pipeline "p" may not have this table, so the run may fail. Did you mean "t_silver"? @ selection.yml:110',
      'c2_unknown: Remove "t_nope" from refresh_selection: pipeline "p" may not have this table, so the run may fail. @ selection.yml:59',
      'c3_case: Rename "T_SILVER" in refresh_selection: pipeline "p" may not have this table, so the run may fail. Did you mean "t_silver"? @ selection.yml:66',
      'c4_mixed: Remove "t_nope" from refresh_selection: pipeline "p" may not have this table, so the run may fail. @ selection.yml:73',
      'c5_full_unknown: Remove "t_nope" from full_refresh_selection: pipeline "p" may not have this table, so the run may fail. @ selection.yml:80',
      'c6_flow_unknown: Remove "t_nope" from refresh_flow_selection: pipeline "p" may not have this flow, so the run may fail. @ selection.yml:87',
      'c8_plain_full: Rename "main.other.t_silver" in refresh_selection: pipeline "plain" may not have this table, so the run may fail. Did you mean "main.sales.t_silver"? @ selection.yml:98',
    ]);
  });

  test("no warning when the names can't all be known: a selection written as a variable", async () => {
    const found = await findings((text) => text.replace('refresh_selection: ["t_nope"]\n        - task_key: c3_case', 'refresh_selection: "${var.tables}"\n        - task_key: c3_case'));
    expect(found.some((line) => line.startsWith("c2_unknown"))).toBe(false);
  });

  test("a selection naming a flow by its table's name is the table's own flow, so no warning", async () => {
    const found = await findings((text) => text.replace('refresh_flow_selection: ["t_nope"]', 'refresh_flow_selection: ["t_silver"]'));
    expect(found.some((line) => line.startsWith("c6_flow_unknown"))).toBe(false);
  });
});
