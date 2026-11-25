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

/** Replaces `from` with `to`, and fails the test if `from` isn't there, so an edit never silently does nothing. */
function swap(from: string, to: string): (text: string) => string {
  return (text) => {
    expect(text).toContain(from);
    return text.replace(from, to);
  };
}

async function findings(edit: (text: string) => string = (text) => text): Promise<string[]> {
  // Windows checks the fixture out with \r\n line endings; the edits below are written with \n.
  const text = edit(readFileSync(path.join(bundleRoot, "resources/selection.yml"), "utf8").replace(/\r\n/g, "\n"));
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
    const found = await findings(swap('refresh_selection: ["t_nope"]\n        - task_key: c3_case', 'refresh_selection: "${var.tables}"\n        - task_key: c3_case'));
    expect(found.some((line) => line.startsWith("c2_unknown"))).toBe(false);
  });

  test("a selection naming a flow by its table's name is the table's own flow, so no warning", async () => {
    const found = await findings(swap('refresh_flow_selection: ["t_nope"]', 'refresh_flow_selection: ["t_silver"]'));
    expect(found.some((line) => line.startsWith("c6_flow_unknown"))).toBe(false);
  });
});

describe("full names after USE (issue 539)", () => {
  test("a table created after USE SCHEMA may live elsewhere, so full names aren't judged", async () => {
    const { mkdtempSync, cpSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(path.join(tmpdir(), "selection-use-"));
    try {
      cpSync(bundleRoot, root, { recursive: true });
      writeFileSync(path.join(root, "src/silver.sql"), "USE SCHEMA other;\nCREATE OR REFRESH MATERIALIZED VIEW t_silver AS SELECT id * 2 AS id2 FROM main.sales.t_bronze;\n");
      const text = readFileSync(path.join(root, "resources/selection.yml"), "utf8");
      const config = {
        bundle: { name: "pipeline_selection" },
        include: ["resources/selection.yml"],
        resources: (parse(text) as { resources: ParsedBundleConfig["resources"] }).resources,
      } as ParsedBundleConfig;
      const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
      const found = buildInspectorIssues(graph, config, [], root).filter((issue) => issue.kind === "pipeline_selection_not_found");
      expect(found.some((issue) => issue.taskName === "c8_plain_full")).toBe(false);
      // Short names are still compared.
      expect(found.some((issue) => issue.taskName === "c2_unknown")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pipelines with more source files than the scan reads (issue 587)", () => {
  // A temp bundle whose pipeline glob holds `count` SQL files, v0 to v<count - 1>, and a
  // task selecting `selected`. The scan reads up to 200 files from a pipeline's globs.
  async function selectionFindings(count: number, selected: string) {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(path.join(tmpdir(), "selection-cap-"));
    try {
      mkdirSync(path.join(root, "sql"));
      for (let i = 0; i < count; i++) {
        writeFileSync(path.join(root, "sql", `q${String(i).padStart(3, "0")}.sql`), `CREATE OR REFRESH MATERIALIZED VIEW v${i} AS SELECT 1 AS n;\n`);
      }
      const config = {
        bundle: { name: "cap" },
        resources: {
          pipelines: { p: { name: "p", catalog: "main", schema: "sales", serverless: true, libraries: [{ glob: { include: "./sql/**" } }] } },
          jobs: { j: { name: "j", tasks: [{ task_key: "refresh", pipeline_task: { pipeline_id: "${resources.pipelines.p.id}", refresh_selection: [selected] } }] } },
        },
      } as unknown as ParsedBundleConfig;
      const graph = await enrichGraphWithFileContent(await extractBundleGraph(config, root));
      const flow = graph.nodes.find((node) => node.id === "resources.pipelines.p")?.pipelineDataFlow;
      const issues = buildInspectorIssues(graph, config, [], root).filter((issue) => issue.kind === "pipeline_selection_not_found");
      return { incomplete: flow?.incomplete === true, warned: issues.length > 0 };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("at the limit every file is read, so a missing name still gets its warning", async () => {
    expect(await selectionFindings(200, "v199")).toEqual({ incomplete: false, warned: false });
    expect(await selectionFindings(200, "v_nope")).toEqual({ incomplete: false, warned: true });
  });

  test("past the limit a real table isn't reported as missing", async () => {
    expect(await selectionFindings(201, "v200")).toEqual({ incomplete: true, warned: false });
  });

  test("past the limit no name is judged, since the table may be in a file not read", async () => {
    expect(await selectionFindings(201, "v_nope")).toEqual({ incomplete: true, warned: false });
  });
});
