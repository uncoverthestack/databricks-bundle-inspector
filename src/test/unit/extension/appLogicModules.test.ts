import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";
import { buildDagFlow, compactTaskName, dependencyOutcomeLabel, dependencyOutcomeTone, NODE_H, NODE_W } from "../../../webview/lib/dagFlow.js";
import { buildSearchItems, buildStatPanelItems, displayResolvedValue, variableResolutionLabel } from "../../../webview/lib/headerItems.js";
import { buildIssueItems } from "../../../webview/lib/issueItems.js";
import {
  basename,
  buildTaskAdjacency,
  collectReachable,
  formatSourceLocation,
  getCurrentJobTaskNodes,
  getFileStatus,
  getTaskIssueCounts,
  getTaskPath,
  summarizeTaskIssues,
  type GraphLike,
  type TaskIssue,
} from "../../../webview/lib/taskIssues.js";
import type { TaskProblemIssue } from "../../../webview/lib/taskProblems.js";
import { UI_COLOR } from "../../../webview/lib/vscodeTheme.js";

// The panel's job screen logic, moved out of App.jsx (#392), on a graph built from a real bundle.
const YAML = `bundle:
  name: app-logic
variables:
  catalog:
    default: main
  no_default:
    description: set per target
  unused:
    default: x
targets:
  dev:
    variables:
      catalog: dev_main
      no_default: set
resources:
  secret_scopes:
    app_scope:
      name: app-secrets
    spare:
      name: spare
  jobs:
    nightly:
      name: nightly
      tasks:
        - task_key: check
          condition_task:
            op: EQUAL_TO
            left: "1"
            right: "1"
        - task_key: load
          depends_on: [{ task_key: check, outcome: "true" }]
          notebook_task:
            notebook_path: ./missing_notebook.py
            base_parameters:
              catalog: \${var.catalog}
              other: \${var.no_default}
              typo: \${var.not_defined}
          libraries:
            - whl: ./dist/missing.whl
        - task_key: skip
          depends_on: [{ task_key: check, outcome: "false" }]
          spark_python_task:
            python_file: ./present.py
        - task_key: a_task_with_a_name_longer_than_twenty_six
          depends_on: [{ task_key: load }, { task_key: skip }]
          sql_task:
            warehouse_id: 0f0f0f0f0f0f0f0f
            file:
              path: /Workspace/Shared/report.sql
`;

let dir: string;
let graph: GraphLike;
let bundle: ParsedBundleConfig;
let issues: Array<TaskIssue & TaskProblemIssue>;
const job = () => graph.nodes.find((node) => node.nodeType === "job")!;
const task = (key: string) => graph.nodes.find((node) => node.nodeType === "task" && node.displayName === key)!;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dbi-392-"));
  writeFileSync(path.join(dir, "databricks.yml"), YAML);
  writeFileSync(path.join(dir, "present.py"), "print(1)\n");
  bundle = parse(YAML) as ParsedBundleConfig;
  const built = await enrichGraphWithFileContent(await extractBundleGraph(bundle, dir));
  // The panel gets the graph as JSON.
  graph = JSON.parse(JSON.stringify(built)) as GraphLike;
  issues = JSON.parse(JSON.stringify(buildInspectorIssues(built, bundle, [], dir))) as Array<TaskIssue & TaskProblemIssue>;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("task problems (#392)", () => {
  test("a file's status chip", () => {
    expect(getFileStatus({ path: "./x.py", resolvedPath: "/b/x.py", exists: false })).toEqual({ key: "missing", label: "MISSING", color: UI_COLOR.error });
    expect(getFileStatus({ path: "/Workspace/x" })).toEqual({ key: "remote", label: "REMOTE", color: UI_COLOR.link });
    expect(getFileStatus({ path: "${var.x}" })).toMatchObject({ key: "template", label: "TEMPLATE", color: UI_COLOR.warning });
    expect(getFileStatus({ path: "./x.py", exists: true })).toEqual({ key: "found", label: "FOUND", color: UI_COLOR.ok });
    expect(getFileStatus({})).toEqual({ key: "unknown", label: "UNKNOWN", color: UI_COLOR.muted });
  });

  test("a task's own recount: missing file, missing library, and a variable the bundle doesn't define", () => {
    expect(getTaskIssueCounts(task("load"), bundle, null)).toEqual({ missingFiles: 1, missingLibraries: 1, unresolvedVariables: 1, total: 3 });
    expect(getTaskIssueCounts(task("load"), bundle, "dev")).toEqual({ missingFiles: 1, missingLibraries: 1, unresolvedVariables: 1, total: 3 });
    expect(getTaskIssueCounts(task("skip"), bundle, null).total).toBe(0);
  });

  test("with the inspector's problems, a task's details list those", () => {
    const summary = summarizeTaskIssues(task("load"), bundle, null, issues);
    expect(summary.length).toBe(issues.filter((issue) => issue.taskId === task("load").id).length);
    expect(summary.every((item) => item.location === null || /databricks\.yml(:\d+)?$/.test(item.location))).toBe(true);
  });

  test("without them, the task's own recount, one line per unresolved variable", () => {
    const summary = summarizeTaskIssues(task("load"), bundle, null, []);
    expect(summary.map((item) => item.title)).toEqual(["Missing notebook file", "Missing local library", "Unresolved variable not_defined"]);
    expect(summary.every((item) => item.severity === "error")).toBe(true);
  });

  test("small helpers", () => {
    expect(basename("a/b/c.py")).toBe("c.py");
    expect(basename("a/b/")).toBe("b");
    expect(basename(undefined)).toBe("");
    expect(formatSourceLocation("/b/res/job.yml", 12)).toBe("job.yml:12");
    expect(formatSourceLocation("/b/res/job.yml", 0)).toBe("job.yml");
    expect(formatSourceLocation(undefined, 3)).toBeNull();
    expect(getTaskPath(task("load"), job())).toEqual(["nightly", "load"]);
    expect(getTaskPath(task("load"), null)).toEqual(["load"]);
    expect(getCurrentJobTaskNodes(graph, job()).map((node) => node.displayName)).toEqual([
      "check",
      "load",
      "skip",
      "a_task_with_a_name_longer_than_twenty_six",
    ]);
    expect(getCurrentJobTaskNodes(null, job())).toEqual([]);
  });

  test("upstream and downstream tasks", () => {
    const ids = new Set(getCurrentJobTaskNodes(graph, job()).map((node) => node.id));
    const { upstream, downstream } = buildTaskAdjacency(graph.edges, ids);
    const last = task("a_task_with_a_name_longer_than_twenty_six").id;
    expect([...collectReachable(last, upstream)].sort()).toEqual([task("check").id, task("load").id, task("skip").id].sort());
    expect([...collectReachable(task("check").id, downstream)].sort()).toEqual([task("load").id, task("skip").id, last].sort());
    expect(collectReachable(task("check").id, upstream).size).toBe(0);
  });
});

describe("Issues list (#392)", () => {
  test("with a job, its tasks' problems and bundle-wide ones, grouped by kind", () => {
    const items = buildIssueItems(graph, job(), bundle, null, [], issues);
    expect(items.length).toBe(issues.filter((issue) => !issue.resourceId || issue.taskId || issue.resourceId === job().id).length);
    expect(items.find((item) => item.title?.includes("missing_notebook"))?.group).toBe("Missing Files");
  });

  test("a problem on another resource is left out of a job's list, kept in the bundle-wide one", () => {
    const other: TaskIssue = { id: "x", kind: "missing_pipeline_source", severity: "error", title: "t", resourceId: "resources.pipelines.p" };
    expect(buildIssueItems(graph, job(), bundle, null, [], [other])).toEqual([]);
    expect(buildIssueItems(graph, null, bundle, null, [], [other]).map((item) => item.group)).toEqual(["Missing Pipeline Sources"]);
  });

  test("without the inspector's problems, the recount and the CLI's diagnostics", () => {
    const validation = [{ message: "m", diagnostics: [{ message: "d", path: "databricks.yml", line: 4, severity: "error" }, {}] }];
    const items = buildIssueItems(graph, job(), bundle, null, validation, []);
    expect(items.map((item) => [item.group, item.title])).toEqual([
      ["Missing Files", "./missing_notebook.py"],
      ["Missing Libraries", "./dist/missing.whl"],
      ["Unresolved Variables", "not_defined"],
      ["Validation Diagnostics", "d"],
      ["Validation Diagnostics", "m"],
    ]);
    expect(items[3]).toMatchObject({ subtitle: "databricks.yml:4", severity: "error" });
    expect(items[4]).toMatchObject({ subtitle: "m", severity: "warning" });
  });
});

describe("header panels and search (#392)", () => {
  test("the count panels", () => {
    const panels = buildStatPanelItems(graph, job(), bundle, null, [], issues);
    expect(panels.tasks.map((item) => item.title)).toEqual(["a_task_with_a_name_longer_than_twenty_six", "check", "load", "skip"]);
    expect(panels.files.map((item) => [item.title, item.subtitle, item.severity])).toEqual([
      ["missing_notebook.py", "MISSING · 1 task", "error"],
      ["present.py", "FOUND · 1 task", undefined],
      ["report.sql", "REMOTE · 1 task", undefined],
    ]);
    expect(panels.variables.map((item) => [item.title, item.group, item.subtitle])).toEqual([
      ["catalog", "Variables", "DEFAULT · 1 task"],
      ["no_default", "Variables", "NO DEFAULT · 1 task"],
      ["not_defined", "Variables", "UNRESOLVED · 1 task"],
      ["unused", "Defined, Not Used By This Job", "Not used by this job"],
    ]);
    expect(panels.secrets.map((item) => [item.title, item.group])).toEqual([
      ["app-secrets", "Defined, Not Used By This Job"],
      ["spare", "Defined, Not Used By This Job"],
    ]);
    expect(panels.compute.map((item) => [item.title, item.subtitle])).toEqual([
      ["0f0f0f0f0f0f0f0f", "warehouse · 1 task"],
      ["Serverless / inherited compute", "cluster · 2 tasks"],
    ]);
    expect(panels.issues).toEqual(buildIssueItems(graph, job(), bundle, null, [], issues));
  });

  test("with a target picked, a variable's value comes from the target", () => {
    const panels = buildStatPanelItems(graph, job(), bundle, "dev", [], issues);
    expect(panels.variables.find((item) => item.title === "catalog")?.subtitle).toBe("TARGET · 1 task");
  });

  test("search lists the job's tasks with their own problem counts", () => {
    const items = buildSearchItems(graph, job(), bundle, null);
    expect(items.find((item) => item.label === "load")).toMatchObject({ issueCount: 3, taskId: task("load").id });
    expect(buildSearchItems(graph, null, bundle, null)).toEqual([]);
  });

  test("a variable's chip and a resolved value", () => {
    expect(variableResolutionLabel({ unresolved: true, resolutionSource: "target_override" })).toBe("UNRESOLVED");
    expect(variableResolutionLabel({ source: "lookup" })).toBe("LOOKUP");
    expect(variableResolutionLabel({ resolutionSource: "outside_files" })).toBe("ENV / FILE");
    expect(variableResolutionLabel({})).toBe("BUNDLE");
    expect(displayResolvedValue("${var.catalog}.raw", bundle, "dev")).toBe("dev_main.raw");
    expect(displayResolvedValue("${var.catalog}.raw", bundle, null)).toBe("${var.catalog}.raw");
    expect(displayResolvedValue(42, bundle, "dev")).toBe(42);
  });
});

describe("job graph layout (#392)", () => {
  test("one column per level, left to right, each box the same size", () => {
    const { flowNodes, jobNode, taskCount } = buildDagFlow(graph, "nightly", bundle, null, issues);
    expect(jobNode?.id).toBe(job().id);
    expect(taskCount).toBe(4);
    const x = (key: string) => (flowNodes.find((node) => node.id === task(key).id)?.position as { x: number }).x;
    expect([x("check"), x("load"), x("skip"), x("a_task_with_a_name_longer_than_twenty_six")]).toEqual([60, 400, 400, 740]);
    expect(flowNodes.every((node) => node.width === NODE_W && node.height === NODE_H)).toBe(true);
  });

  test("a condition task's branches are labelled lines, and the box lists its outcomes", () => {
    const { flowNodes, flowEdges } = buildDagFlow(graph, "nightly", bundle, null, issues);
    expect(flowEdges.map((edge) => edge.label).filter(Boolean).sort()).toEqual(["False", "True"]);
    expect(flowEdges).toHaveLength(4);
    const check = flowNodes.find((node) => node.id === task("check").id)?.data as { branchOutcomes: string[] };
    expect(check.branchOutcomes.sort()).toEqual(["False", "True"]);
  });

  test("a box's problems: the inspector's list when there is one, else its own recount", () => {
    const withIssues = buildDagFlow(graph, "nightly", bundle, null, issues).flowNodes.find((node) => node.id === task("load").id)?.data;
    const recount = buildDagFlow(graph, "nightly", bundle, null, []).flowNodes.find((node) => node.id === task("load").id)?.data;
    expect(withIssues).toMatchObject({ problemTone: "error" });
    expect(recount).toMatchObject({ issueCounts: { errors: 3, warnings: 0, infos: 0, total: 3 }, problemTone: "error" });
  });

  test("an unknown job is empty; no job key picks the first job", () => {
    expect(buildDagFlow(graph, "nope", bundle, null)).toEqual({ flowNodes: [], flowEdges: [], jobNode: null, taskCount: 0 });
    expect(buildDagFlow(graph, null, bundle, null).jobNode?.id).toBe(job().id);
  });

  test("names, outcome labels and colours", () => {
    expect(compactTaskName("x".repeat(26))).toBe("x".repeat(26));
    expect(compactTaskName("x".repeat(27))).toBe(`${"x".repeat(24)}...`);
    expect(dependencyOutcomeLabel({ data: { outcome: " TRUE " } })).toBe("True");
    expect(dependencyOutcomeLabel({ data: { outcome: "" } })).toBeNull();
    expect(dependencyOutcomeLabel({ data: { outcome: "maybe" } })).toBe("maybe");
    expect(dependencyOutcomeTone("True").stroke).toBe(UI_COLOR.ok);
    expect(dependencyOutcomeTone("False").stroke).toBe(UI_COLOR.muted);
    expect(dependencyOutcomeTone(null).stroke).toBe(UI_COLOR.link);
  });
});
