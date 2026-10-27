import { describe, expect, test } from "@jest/globals";
import {
  buildPipelineView,
  pipelineIssueCounts,
  pipelineKeysOf,
  pipelineRunners,
  referencedPipelineKey,
} from "../../../webview/lib/pipelineView.js";

const library = (kind: "notebook" | "file" | "glob", path: string, extra: Record<string, unknown> = {}) => ({
  kind,
  path,
  resolvedPath: `/b/${path}`,
  exists: true,
  checked: true,
  sourceFile: "/b/resources/p.yml",
  sourceLine: 10,
  ...extra,
});

const bundle = (pipelines: Record<string, unknown>, jobs: Record<string, unknown> = {}) => ({
  resources: { pipelines, jobs },
});

describe("referencedPipelineKey", () => {
  test("reads this bundle's pipeline references", () => {
    expect(referencedPipelineKey("${resources.pipelines.bronze.id}")).toBe("bronze");
    expect(referencedPipelineKey(" ${resources.pipelines.my-pipe_1.id} ")).toBe("my-pipe_1");
  });

  test("ignores ids that aren't a reference to one of its pipelines", () => {
    expect(referencedPipelineKey("1234-abcd")).toBeUndefined();
    expect(referencedPipelineKey("${resources.pipelines.bronze.name}")).toBeUndefined();
    expect(referencedPipelineKey("${resources.jobs.bronze.id}")).toBeUndefined();
    expect(referencedPipelineKey("${var.pipeline_id}")).toBeUndefined();
    expect(referencedPipelineKey(undefined)).toBeUndefined();
    expect(referencedPipelineKey(42)).toBeUndefined();
  });
});

describe("pipelineKeysOf", () => {
  test("lists pipelines in order, and none when there are none", () => {
    expect(pipelineKeysOf(bundle({ b: {}, a: {} }))).toEqual(["b", "a"]);
    expect(pipelineKeysOf({ resources: { jobs: {} } })).toEqual([]);
    expect(pipelineKeysOf(undefined)).toEqual([]);
    expect(pipelineKeysOf({ resources: { pipelines: [] } })).toEqual([]);
  });
});

describe("pipelineRunners", () => {
  test("finds pipeline tasks, including inside for_each_task", () => {
    const runners = pipelineRunners(
      bundle(
        { p: {} },
        {
          refresh: {
            name: "Refresh",
            tasks: [
              { task_key: "run_p", pipeline_task: { pipeline_id: "${resources.pipelines.p.id}" } },
              { task_key: "other", notebook_task: { notebook_path: "x.py" } },
            ],
          },
          loop: {
            tasks: [
              {
                task_key: "each",
                for_each_task: { inputs: "[1]", task: { task_key: "inner", pipeline_task: { pipeline_id: "${resources.pipelines.p.id}" } } },
              },
            ],
          },
          external: { tasks: [{ task_key: "ext", pipeline_task: { pipeline_id: "abcd-1234" } }] },
        },
      ),
    );
    expect(runners.get("p")).toEqual([
      { jobKey: "refresh", jobName: "Refresh", taskKey: "run_p" },
      { jobKey: "loop", jobName: "loop", taskKey: "each" },
    ]);
    expect(runners.size).toBe(1);
  });

  test("copes with jobs that have no task list", () => {
    expect(pipelineRunners(bundle({}, { a: {}, b: { tasks: "nope" }, c: { tasks: [null, 3] } })).size).toBe(0);
  });
});

describe("buildPipelineView", () => {
  const graph = {
    nodes: [
      {
        id: "resources.pipelines.p",
        nodeType: "resource",
        resourceGroup: "pipelines",
        resourceKey: "p",
        sourceFile: "/b/resources/p.yml",
        sourceLine: 3,
        pipelineLibraries: [
          library("notebook", "../src/a.py"),
          library("file", "../src/gone.py", { exists: false }),
          library("glob", "../src/empty/**", { exists: false }),
          library("notebook", "/Workspace/x", { checked: false, exists: false, resolvedPath: undefined }),
          library("notebook", "../src/plain.py", { notebookProblem: { kind: "missing_header" } }),
        ],
      },
      { id: "secret:a", nodeType: "secret_scope", data: { scope: "kv" } },
      { id: "secret:b", nodeType: "secret_scope", displayName: "other" },
    ],
    edges: [
      { source: "resources.pipelines.p", target: "secret:a", kind: "references", data: { file: "/b/src/a.py", line: 4 } },
      { source: "resources.pipelines.p", target: "secret:a", kind: "references", data: { file: "/b/src/a.py", line: 9 } },
      { source: "resources.pipelines.p", target: "secret:b", kind: "references", data: {} },
      { source: "resources.pipelines.q", target: "secret:b", kind: "references", data: {} },
    ],
  };
  const parsed = bundle(
    { p: { name: "Pipe P", catalog: "main", schema: "silver", serverless: true, continuous: true, development: true }, q: {} },
    { j: { tasks: [{ task_key: "t", pipeline_task: { pipeline_id: "${resources.pipelines.p.id}" } }] } },
  );
  const issues = [
    { id: "1", severity: "error" as const, kind: "missing_pipeline_source", title: "x", resourceId: "resources.pipelines.p", file: "/b/resources/p.yml", line: 12 },
    { id: "2", severity: "warning" as const, kind: "cli_diagnostic", title: "y", resourceId: "resources.pipelines.q" },
    { id: "3", severity: "error" as const, kind: "missing_file", title: "z", resourceId: "resources.jobs.j", taskId: "resources.jobs.j.tasks.t" },
    { id: "4", severity: "warning" as const, kind: "include_matches_nothing", title: "bundle-wide" },
  ];

  test("shows the pipeline's settings, sources, runners, secrets and own issues", () => {
    const view = buildPipelineView(graph, parsed, "p", issues)!;
    expect(view).toMatchObject({
      key: "p",
      name: "Pipe P",
      file: "/b/resources/p.yml",
      line: 3,
      catalog: "main",
      schema: "silver",
      mode: "Continuous",
      serverless: true,
      development: true,
      runBy: [{ jobKey: "j", jobName: "j", taskKey: "t" }],
    });
    expect(view.sources.map((s) => s.status)).toEqual(["found", "missing", "no_files", "not_checked", "not_a_notebook"]);
    expect(view.sources[0]!.resolvedPath).toBe("/b/../src/a.py");
    expect(view.sources[1]!.resolvedPath).toBeUndefined();
    expect(view.secrets).toEqual([{ scope: "kv", file: "/b/src/a.py", line: 4 }, { scope: "other" }]);
    expect(view.issues.map((i) => i.id)).toEqual(["1"]);
  });

  test("defaults: triggered, no serverless, no catalog, the key as its name", () => {
    const view = buildPipelineView({ nodes: [], edges: [] }, parsed, "q")!;
    expect(view).toMatchObject({ name: "q", mode: "Triggered", serverless: false, development: false, sources: [], runBy: [], secrets: [], issues: [] });
    expect(view.catalog).toBeUndefined();
    expect(view.schema).toBeUndefined();
    expect(view.file).toBeUndefined();
  });

  test("reads the older `target` field as the schema", () => {
    expect(buildPipelineView({ nodes: [], edges: [] }, bundle({ old: { target: "legacy" } }), "old")!.schema).toBe("legacy");
  });

  test("gives nothing for a pipeline the bundle doesn't have", () => {
    expect(buildPipelineView(graph, parsed, "missing")).toBeUndefined();
  });
});

describe("pipelineIssueCounts", () => {
  test("counts each pipeline's own errors and warnings", () => {
    const counts = pipelineIssueCounts(["p", "q", "r"], [
      { id: "1", severity: "error", kind: "k", title: "", resourceId: "resources.pipelines.p" },
      { id: "2", severity: "warning", kind: "k", title: "", resourceId: "resources.pipelines.p" },
      { id: "3", severity: "info", kind: "k", title: "", resourceId: "resources.pipelines.q" },
      { id: "4", severity: "error", kind: "k", title: "", resourceId: "resources.pipelines.gone" },
      { id: "5", severity: "error", kind: "k", title: "" },
    ]);
    expect([...counts]).toEqual([["p", 2], ["q", 0], ["r", 0]]);
  });
});
