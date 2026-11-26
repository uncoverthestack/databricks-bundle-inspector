import { describe, expect, test } from "@jest/globals";
import { buildBundleReviewSummary } from "../../../bundle/bundleReviewSummary.js";
import type { BundleGraph, BundleGraphNode } from "../../../bundle/graph/bundleGraph.js";
import { dataFlowNotChecked, notCheckedForTasks, notCheckedIn } from "../../../bundle/notChecked.js";
import type { PipelineDataFlow } from "../../../bundle/pipelineDataFlow.js";
import type { FileReference, TaskNodeData } from "../../../bundle/resources/task.js";
import { pipelineReviewSummary, type PipelineViewModel } from "../../../webview/lib/pipelineView.js";

function ref(path: string, extra: Partial<FileReference> = {}): FileReference {
  return {
    path,
    resolvedPath: `/b/${path.replace(/^\.\//, "")}`,
    exists: true,
    source: undefined,
    isInGitignore: false,
    referenceType: "notebook",
    sourceFile: "/b/databricks.yml",
    sourceLine: 1,
    ...extra,
  } as FileReference;
}

function task(key: string, fileReferences: FileReference[], extra: Partial<TaskNodeData> = {}): BundleGraphNode {
  return {
    id: `resources.jobs.j.tasks.${key}`,
    kind: "task",
    nodeType: "task",
    displayName: key,
    taskKey: key,
    parentId: "resources.jobs.j",
    data: {},
    taskData: { taskKey: key, taskType: "notebook", fileReferences, nestedTask: undefined, ...extra } as TaskNodeData,
  };
}

function fileNode(path: string, widgetUsage: Record<string, unknown>): BundleGraphNode {
  return { id: `file:/b/${path}`, kind: "file", nodeType: "file", displayName: path, data: { widgetUsage } };
}

const graphOf = (...nodes: BundleGraphNode[]): BundleGraph => ({ nodes, edges: [] });

describe("notCheckedIn", () => {
  test("a fully read bundle has nothing to say", () => {
    expect(notCheckedIn(graphOf(task("load", [ref("./nb.py")])))).toEqual([]);
  });

  test("a notebook in the workspace (#611)", () => {
    const [item] = notCheckedIn(graphOf(task("load", [ref("/Workspace/Shared/etl", { resolvedPath: undefined, exists: false })])));
    expect(item).toMatchObject({ reason: "code_in_workspace", taskId: "resources.jobs.j.tasks.load" });
    expect(item?.text).toBe("Code outside the bundle isn't read: /Workspace/Shared/etl (task load).");
  });

  test("a notebook in the job's Git repository", () => {
    expect(notCheckedIn(graphOf(task("load", [ref("etl/nb", { source: "GIT", exists: false })])))[0]?.reason).toBe("code_in_git");
  });

  test("a path from a variable is left to path_not_checked", () => {
    expect(notCheckedIn(graphOf(task("load", [ref("${var.nb}", { exists: false })])))).toEqual([]);
  });

  test("wheel and JAR tasks, said once per task", () => {
    const items = notCheckedIn(
      graphOf(
        task("train", [ref("./dist/x.whl", { referenceType: "python_wheel" })], { taskType: "python_wheel" }),
        task("jar", [], { taskType: "spark_jar" }),
      ),
    );
    expect(items.map((item) => item.text)).toEqual(["Python wheel code isn't read (task train).", "JAR code isn't read (task jar)."]);
  });

  test("R and Scala are read for dbutils calls only", () => {
    expect(notCheckedIn(graphOf(task("r", [ref("./nb.r")]), task("s", [ref("./Job.SCALA")]))).map((item) => item.text)).toEqual([
      "R code is read for dbutils calls only: ./nb.r (task r).",
      "Scala code is read for dbutils calls only: ./Job.SCALA (task s).",
    ]);
  });

  test("a %run that couldn't be followed and widget names set at run time", () => {
    const items = notCheckedIn(graphOf(task("load", [ref("./nb.py")]), fileNode("nb.py", { hasUnresolvedRuns: true, hasDynamicReads: true })));
    expect(items.map((item) => item.reason)).toEqual(["run_not_followed", "dynamic_widget_names"]);
  });

  test("a for_each loop's inner task's files belong to the loop's task", () => {
    const loop = task("loop", [], {
      taskType: "for_each",
      nestedTask: { taskKey: "inner", taskType: "notebook", fileReferences: [ref("/Workspace/x")] } as TaskNodeData,
    });
    expect(notCheckedIn(graphOf(loop))).toMatchObject([{ taskId: "resources.jobs.j.tasks.loop", text: "Code outside the bundle isn't read: /Workspace/x (task loop)." }]);
  });

  test("a pipeline's data flow is left to the pipeline's own review", () => {
    const pipeline: BundleGraphNode = {
      id: "resources.pipelines.p",
      kind: "pipeline",
      nodeType: "resource",
      displayName: "p",
      data: {},
      pipelineDataFlow: { nodes: [], edges: [], sqlFiles: 0, notRead: [{ file: "/b/x.py", reason: "Python" }], unread: [] } as unknown as PipelineDataFlow,
    };
    expect(notCheckedIn(graphOf(pipeline))).toEqual([]);
  });

  test("a pipeline's data flow: Python sources and statements it couldn't read", () => {
    const pipeline: BundleGraphNode = {
      id: "resources.pipelines.p",
      kind: "pipeline",
      nodeType: "resource",
      displayName: "p",
      resourceKey: "p",
      data: {},
      pipelineDataFlow: {
        nodes: [],
        edges: [],
        sqlFiles: 1,
        notRead: [{ file: "/b/src/ingest.py", reason: "Python" }],
        unread: [{ file: "/b/src/t.sql", line: 3, reason: "a table named by a setting: IDENTIFIER('main.sales.orders')" }],
      } as unknown as PipelineDataFlow,
    };
    expect(dataFlowNotChecked(pipeline.pipelineDataFlow!, "p").map((item) => item.text)).toEqual([
      "Not in the data flow (Python): ingest.py (pipeline p).",
      "Not followed by the data flow: t.sql:3 (pipeline p), a table named by a setting: IDENTIFIER('main.sales.orders').",
    ]);
  });

  test("the same line twice is listed once; a job's items only", () => {
    const graph = graphOf(task("a", [ref("/Workspace/x"), ref("/Workspace/x")]), task("b", [ref("/Workspace/y")]));
    const items = notCheckedIn(graph);
    expect(items).toHaveLength(2);
    expect(notCheckedForTasks(items, new Set(["resources.jobs.j.tasks.b"]))).toHaveLength(1);
  });
});

describe("copied review (#611)", () => {
  const job = { id: "resources.jobs.j", displayName: "j" };

  test("No issues detected says what wasn't read", () => {
    const graph = graphOf(task("load", [ref("/Workspace/Shared/etl", { resolvedPath: undefined, exists: false })]));
    const summary = buildBundleReviewSummary({ graph, jobNode: job, targetLabel: "preview", headerPanelItems: { issues: [] }, notChecked: notCheckedIn(graph) });
    expect(summary).toContain("- No issues detected in this job.");
    expect(summary).toContain("### Not checked\n- Code outside the bundle isn't read: /Workspace/Shared/etl (task load).");
  });

  test("a for_each loop's inner file is counted", () => {
    const loop = task("loop", [], {
      taskType: "for_each",
      nestedTask: { taskKey: "inner", taskType: "notebook", fileReferences: [ref("./missing.py", { exists: false })] } as TaskNodeData,
    });
    const summary = buildBundleReviewSummary({ graph: graphOf(loop), jobNode: job, targetLabel: "preview", headerPanelItems: { issues: [] } });
    expect(summary).toContain("- 1 file reference\n- 1 missing file");
  });

  test("a fully read job has no Not checked section", () => {
    const graph = graphOf(task("load", [ref("./nb.py")]));
    const summary = buildBundleReviewSummary({ graph, jobNode: job, targetLabel: "preview", headerPanelItems: { issues: [] }, notChecked: notCheckedIn(graph) });
    expect(summary).not.toContain("Not checked");
  });

  test("past eight lines, the rest are counted", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, [ref(`/Workspace/n${i}`)]));
    const graph = graphOf(...tasks);
    const summary = buildBundleReviewSummary({ graph, jobNode: job, targetLabel: "preview", headerPanelItems: { issues: [] }, notChecked: notCheckedIn(graph) });
    expect(summary).toContain("- ...and 2 more.");
  });

  test("a pipeline's copied review lists what its data flow didn't read", () => {
    const view = {
      key: "p",
      name: "p",
      issues: [],
      runBy: [],
      sources: [],
      dataFlow: { nodes: [], edges: [], sqlFiles: 1, notRead: [], unread: [{ file: "/b/t.sql", line: 2, reason: "reads from the function read_files(…)" }] },
    } as unknown as PipelineViewModel;
    expect(pipelineReviewSummary(view, { bundleName: "b", targetLabel: "preview" })).toContain(
      "### Not checked\n- Not followed by the data flow: t.sql:2 (pipeline p), reads from the function read\\_files(…).",
    );
  });
});
