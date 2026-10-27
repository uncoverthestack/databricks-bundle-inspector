import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { validateBundle } from "../../bundle/validateBundle.js";
import { buildPipelineView, pipelineKeysOf } from "../../webview/lib/pipelineView.js";

/**
 * The pipeline view from a bundle the real CLI resolved: every value it shows comes from
 * the CLI's output and the inspector's own checks, as in the extension.
 */

const cli = process.env.SEMANTIC_CLI_COMMAND?.trim() || "databricks";
const FIXTURE = path.resolve("src/test/fixtures/pipeline-sources");

async function inspect(dir: string) {
  const result = await validateBundle(dir, undefined, cli);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const graph = await enrichGraphWithFileContent(await extractBundleGraph(result.data, dir));
  const issues = buildInspectorIssues(graph, result.data, result.issues ?? [], dir);
  return { parsed: result.data, graph, issues };
}

describe(`pipeline view (${cli})`, () => {
  test("shows each pipeline of a bundle as its YAML defines it", async () => {
    const { parsed, graph, issues } = await inspect(FIXTURE);
    // The CLI lists resources by key, whatever order the YAML has them in.
    expect(pipelineKeysOf(parsed)).toEqual(["broken_pipeline", "ok_pipeline", "workspace_pipeline"]);
    const pipelinesFile = path.join(FIXTURE, "resources", "pipelines.yml");

    const broken = buildPipelineView(graph, parsed, "broken_pipeline", issues)!;
    expect(broken).toMatchObject({
      name: "broken_pipeline",
      file: pipelinesFile,
      line: 15,
      catalog: "main",
      schema: "silver",
      mode: "Triggered",
      serverless: true,
      runBy: [{ jobKey: "refresh_job", jobName: "refresh_job", taskKey: "refresh_broken" }],
    });
    expect(broken.sources.map((s) => [s.kind, s.path, s.status, s.line])).toEqual([
      ["notebook", "../src/dlt/missing_notebook.py", "missing", 21],
      ["file", "../src/dlt/missing_file.py", "missing", 23],
      ["glob", "../src/dlt/empty/**", "no_files", 25],
    ]);
    // Every source problem is in the issue list, each at its line.
    expect(broken.issues.map((i) => [i.kind, i.line]).sort()).toEqual([
      ["missing_pipeline_source", 21],
      ["missing_pipeline_source", 23],
      ["missing_pipeline_source", 25],
    ]);

    const ok = buildPipelineView(graph, parsed, "ok_pipeline", issues)!;
    expect(ok.runBy).toEqual([]);
    // The CLI's warning about an unknown field is the pipeline's, not bundle-wide.
    expect(ok.issues.map((i) => [i.kind, i.line])).toEqual([["unknown_or_deprecated_field", 8]]);
    expect(ok.sources[0]).toMatchObject({
      kind: "notebook",
      status: "found",
      resolvedPath: path.join(FIXTURE, "src", "dlt", "bronze.py"),
    });

    const workspace = buildPipelineView(graph, parsed, "workspace_pipeline", issues)!;
    expect(workspace.sources).toEqual([
      expect.objectContaining({ path: "/Users/someone@example.com/pipelines/gold", status: "not_checked" }),
    ]);
    // A workspace path is never reported as missing.
    expect(workspace.issues.filter((i) => i.kind === "missing_pipeline_source")).toEqual([]);
  });
});
