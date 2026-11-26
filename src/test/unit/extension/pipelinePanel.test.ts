import { describe, expect, test } from "@jest/globals";
import { hasDataFlowPage, pipelinePanel, type PipelineViewModel } from "../../../webview/lib/pipelineView.js";

// Hand-worked cases on the model the panel shows (issue 436). The facts they start from (the
// pipeline's YAML, its sources' state, its SQL data flow) are built and tested elsewhere.
const view = (extra: Partial<PipelineViewModel> = {}): PipelineViewModel => ({
  key: "bronze",
  id: "resources.pipelines.bronze",
  name: "bronze",
  mode: "Triggered",
  serverless: false,
  development: false,
  sources: [],
  runBy: [],
  secrets: [],
  issues: [],
  ...extra,
});
const source = (path: string, line: number) => ({ kind: "file" as const, path, status: "found" as const, file: "/b/p.yml", line });
const issue = (id: string, line: number) => ({ id, severity: "error" as const, kind: "k", title: id, file: "/b/p.yml", line });
const flow = (sqlFiles: number, kinds: string[], notRead: { file: string; reason: string }[] = []) =>
  ({ sqlFiles, notRead, unread: [], edges: [], nodes: kinds.map((kind, i) => ({ id: `n${i}`, kind })) }) as unknown as NonNullable<PipelineViewModel["dataFlow"]>;

describe("pipelinePanel", () => {
  test("names the pipeline only when its name differs from the key, filled in", () => {
    expect(pipelinePanel(view()).name).toBeUndefined();
    expect(pipelinePanel(view({ name: "${bundle.target}-bronze" }), (v) => v.replace("${bundle.target}", "dev")).name).toBe("dev-bronze");
  });

  test("settings on one line; never says classic, since the workspace may pick serverless", () => {
    expect(pipelinePanel(view()).settings).toBe("Triggered");
    expect(pipelinePanel(view({ serverless: true, mode: "Continuous", development: true })).settings).toBe(
      "Serverless · Continuous · Development mode",
    );
  });

  test("says how it runs from the jobs that run it (issue 542)", () => {
    const runner = { jobKey: "j", jobName: "j", taskKey: "t" };
    expect(pipelinePanel(view({ runBy: [runner] })).settings).toBe("Starts when its job runs");
    expect(pipelinePanel(view({ runBy: [runner, { ...runner, jobKey: "c", continuous: true }] })).settings).toBe("Continuous");
    expect(pipelinePanel(view({ mode: "Continuous", runBy: [runner] })).settings).toBe("Continuous");
    expect(pipelinePanel(view({ serverless: true, runBy: [runner] })).settings).toBe("Serverless · Starts when its job runs");
  });

  test("writes to the catalog and schema that are set", () => {
    expect(pipelinePanel(view()).writesTo).toBeUndefined();
    expect(pipelinePanel(view({ catalog: "main", schema: "bronze" })).writesTo).toBe("main.bronze");
    expect(pipelinePanel(view({ schema: "bronze" })).writesTo).toBe("bronze");
  });

  test("each problem sits under the source on its line, and only there", () => {
    const panel = pipelinePanel(view({ sources: [source("a.sql", 5), source("b.py", 6)], issues: [issue("on_a", 5), issue("on_pipeline", 2)] }));
    expect(panel.sources.map((row) => row.issues.map((i) => i.id))).toEqual([["on_a"], []]);
    expect(panel.otherIssues.map((i) => i.id)).toEqual(["on_pipeline"]);
  });

  test("data flow: a summary and a link with SQL sources", () => {
    expect(pipelinePanel(view({ dataFlow: flow(2, ["materialized_view", "streaming_table", "outside"]) })).dataFlow).toEqual({
      summary: "Creates 2 tables and views, reads 1 from outside.",
      opens: true,
    });
    expect(pipelinePanel(view({ dataFlow: flow(1, ["view"]) })).dataFlow?.summary).toBe("Creates 1 table or view.");
    expect(pipelinePanel(view({ dataFlow: flow(1, []) })).dataFlow).toEqual({ summary: "No tables or views found in this pipeline's SQL.", opens: true });
  });

  test("data flow: no link without SQL sources, and says why", () => {
    const python = flow(0, [], [{ file: "a.py", reason: "Python" }]);
    expect(pipelinePanel(view({ dataFlow: python })).dataFlow).toEqual({ summary: "From SQL sources only. This pipeline's are Python.", opens: false });
    const notebook = flow(0, [], [{ file: "a.py", reason: "Python" }, { file: "n.py", reason: "notebook" }]);
    expect(pipelinePanel(view({ dataFlow: notebook })).dataFlow?.summary).toBe("From SQL sources only. This pipeline has none.");
    expect(pipelinePanel(view()).dataFlow).toBeUndefined();
  });
});

describe("hasDataFlowPage", () => {
  test("only a pipeline with SQL sources", () => {
    expect(hasDataFlowPage(view({ dataFlow: flow(1, []) }))).toBe(true);
    expect(hasDataFlowPage(view({ dataFlow: flow(0, []) }))).toBe(false);
    expect(hasDataFlowPage(view())).toBe(false);
    expect(hasDataFlowPage(undefined)).toBe(false);
  });
});
