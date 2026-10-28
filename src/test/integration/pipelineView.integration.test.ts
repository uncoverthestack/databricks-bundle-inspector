import { describe, expect, test } from "@jest/globals";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { enrichGraphWithFileContent } from "../../bundle/graph/enrichGraph.js";
import { extractBundleGraph } from "../../bundle/graph/bundleGraph.js";
import { buildInspectorIssues } from "../../bundle/issues.js";
import { validateBundle } from "../../bundle/validateBundle.js";
import { buildPipelineView, pipelineKeysOf, pipelineReviewSummary } from "../../webview/lib/pipelineView.js";
import { resourceAtLine } from "../../bundle/resourceFiles.js";

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
  test.each(["42", "null", "~", "true"])("resource selection agrees with the CLI for the YAML key %s", async (key) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dbi-scalar-resource-"));
    try {
      const text = `bundle:\n  name: scalar-resource\nresources:\n  pipelines:\n    first: {name: first}\n    ${key}:\n      name: selected\n`;
      await writeFile(path.join(root, "databricks.yml"), text);
      const result = await validateBundle(root, undefined, cli);
      if (key === "42" || key === "true") {
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("CLI unexpectedly accepted a non-string resource key");
        expect(result.error.details).toContain("invalid key tag");
        return;
      }
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(Object.keys(result.data.resources?.pipelines ?? {})).toContain(key);
      expect(resourceAtLine(text, 6)).toEqual({ group: "pipelines", key });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shows each pipeline of a bundle as its YAML defines it", async () => {
    const { parsed, graph, issues } = await inspect(FIXTURE);
    // The CLI lists resources by key, whatever order the YAML has them in.
    expect(pipelineKeysOf(parsed)).toEqual(["broken_pipeline", "looped_pipeline", "ok_pipeline", "workspace_pipeline"]);
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

    // A notebook listed as a file is a notebook, and a for_each_task's inner task runs the pipeline.
    const looped = buildPipelineView(graph, parsed, "looped_pipeline", issues)!;
    expect(looped.sources.map((s) => [s.kind, s.status])).toEqual([["file", "is_a_notebook"]]);
    expect(looped.issues.map((i) => i.kind)).toEqual(["file_is_a_notebook"]);
    expect(looped.runBy).toEqual([{ jobKey: "refresh_job", jobName: "refresh_job", taskKey: "refresh_each" }]);
    // Its copied review holds none of the other pipelines' problems.
    const review = pipelineReviewSummary(looped, { bundleName: "pipeline-sources", targetLabel: "dev" });
    expect(review).toContain("Pipeline: looped_pipeline");
    expect(review).not.toMatch(/Job:|missing_notebook|bogus_pipeline_field|missing_file/);
    expect(review).toContain("- 1 a notebook listed as a file");
  });
});
