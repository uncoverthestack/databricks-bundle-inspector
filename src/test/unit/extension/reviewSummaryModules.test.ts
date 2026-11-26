import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { buildBundleReviewSummary, REVIEW_SUMMARY_ISSUE_LIMIT, type ReviewSummaryIssue } from "../../../bundle/bundleReviewSummary.js";
import { extractBundleGraph, type ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { normalizeSeverity, orderBySeverity, severityLabel, severityRank } from "../../../bundle/issueSeverity.js";
import { getCurrentJobTaskNodes } from "../../../bundle/jobTasks.js";
import {
  buildParameterFlowsForJob,
  buildParameterFlowsForTask,
  buildParameterLinkageMaps,
  getPrimaryFileNode,
  parameterFlowMarkdownLabel,
  parameterLinkageForName,
  type FlowGraph,
  type FlowGraphNode,
  type ParameterFlow,
} from "../../../bundle/parameterFlows.js";
import { severityMeta } from "../../../webview/lib/issueSeverity.js";

// The Copy review summary and parameter flows, moved out of App.jsx into the core (#392 step 2),
// on a graph built from a real bundle.
const YAML = `bundle:
  name: review-summary
resources:
  jobs:
    daily:
      name: daily
      schedule:
        quartz_cron_expression: "0 0 6 * * ?"
        timezone_id: UTC
      parameters:
        - name: run_date
          default: "2026-01-01"
        - name: region
          default: eu
      tasks:
        - task_key: load
          notebook_task:
            notebook_path: ./load.py
            base_parameters:
              region: us
              catalog: main
        - task_key: report
          depends_on: [{ task_key: load }]
          sql_task:
            warehouse_id: abc
            file:
              path: ./report.sql
            parameters:
              run_date: x
        - task_key: gone
          notebook_task:
            notebook_path: ./missing.py
`;

let dir: string;
let graph: FlowGraph;
const job = () => graph.nodes.find((node) => node.nodeType === "job")!;
const task = (key: string) => graph.nodes.find((node) => node.nodeType === "task" && node.displayName === key)!;
const nodeById = () => new Map(graph.nodes.map((node) => [node.id, node]));

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dbi-392-2-"));
  writeFileSync(path.join(dir, "databricks.yml"), YAML);
  writeFileSync(
    path.join(dir, "load.py"),
    "# Databricks notebook source\nregion = dbutils.widgets.get('region')\ncatalog = dbutils.widgets.get('catalog')\nrun_date = dbutils.widgets.get('run_date')\n",
  );
  writeFileSync(path.join(dir, "report.sql"), "select * from t where d = :run_date\n");
  const bundle = parse(YAML) as ParsedBundleConfig;
  const built = await enrichGraphWithFileContent(await extractBundleGraph(bundle, dir));
  // The panel gets the graph as JSON.
  graph = JSON.parse(JSON.stringify(built)) as FlowGraph;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lines = (all: string[], ...starts: string[]) => all.filter((line) => starts.some((start) => line.startsWith(start)));
const chains = (flows: ParameterFlow[]) =>
  flows.map((flow) => `${flow.taskName}:${flow.name}:${flow.segments.map((segment) => `${segment.label}@${segment.line}`).join(">")}`);

describe("parameter flows (#392)", () => {
  test("a job's flows: task parameters and a job parameter to notebook widgets, and to a SQL parameter", () => {
    // region and run_date are also job parameters, which win over the task's own value
    // (issue 537, https://docs.databricks.com/aws/en/jobs/job-parameters).
    expect(chains(buildParameterFlowsForJob(graph, job()))).toEqual([
      "load:region:JOB@13>NOTEBOOK@2",
      "load:catalog:TASK@21>NOTEBOOK@3",
      "load:run_date:JOB@11>NOTEBOOK@4",
      "report:run_date:JOB@11>SQL@1",
    ]);
  });

  test("a segment's file: the bundle file for parameters, the task's file for the widget", () => {
    const [flow] = buildParameterFlowsForTask(graph, nodeById(), task("load"));
    expect(flow!.segments[0]!.file).toMatch(/databricks\.yml$/);
    expect(flow!.segments[1]!.file).toMatch(/load\.py$/);
    expect(flow!.segments[1]!.column).toBeNull();
    expect(flow!.id).toBe("resources.jobs.daily.tasks.load:region:JOB>NOTEBOOK");
  });

  test("a task whose file is missing: its file box has no widgets, so no flows", () => {
    expect(getPrimaryFileNode(graph, nodeById(), task("gone").id)).toMatchObject({ nodeType: "file", displayName: "missing.py" });
    expect(buildParameterFlowsForTask(graph, nodeById(), task("gone"))).toEqual([]);
  });

  test("a task with no file box: no flows", () => {
    const node: FlowGraphNode = { id: "t", nodeType: "task", displayName: "t", taskData: { taskParameterReferences: [{ name: "p" }] } };
    const small: FlowGraph = { nodes: [node], edges: [] };
    expect(getPrimaryFileNode(small, new Map([["t", node]]), "t")).toBeUndefined();
    expect(buildParameterFlowsForTask(small, new Map([["t", node]]), node)).toEqual([]);
  });

  test("no graph or no job: no flows", () => {
    expect(buildParameterFlowsForJob(null, job())).toEqual([]);
    expect(buildParameterFlowsForJob(graph, null)).toEqual([]);
  });

  test("where a parameter is set: task, job over task, job, or nowhere", () => {
    const taskParams = new Map([
      ["a", { name: "a", value: "1", isOverriddenByJob: false, sourceLine: 5, sourceColumn: 3 }],
      ["b", { name: "b", value: "2", isOverriddenByJob: true, jobParameterDefault: "9", effectiveValue: "9", sourceLine: 6 }],
    ]);
    const jobParams = new Map([
      ["b", { name: "b", default: "9", sourceLine: 2, sourceColumn: 7 }],
      ["c", { name: "c", default: "3", sourceLine: 3 }],
    ]);
    expect(parameterLinkageForName("a", taskParams, jobParams)).toMatchObject({ kind: "task", taskValue: "1", sourceLine: 5, sourceColumn: 3 });
    expect(parameterLinkageForName("b", taskParams, jobParams)).toMatchObject({ kind: "job_override", effectiveValue: "9", sourceLine: 6, jobSourceLine: 2, jobSourceColumn: 7 });
    expect(parameterLinkageForName("c", taskParams, jobParams)).toEqual({ kind: "job", jobParameterDefault: "3", effectiveValue: "3", sourceLine: 3, sourceColumn: undefined });
    expect(parameterLinkageForName("d", taskParams, jobParams)).toBeNull();
  });

  test("a job overriding a task parameter gives a JOB, TASK, widget chain", () => {
    const node: FlowGraphNode = {
      id: "t",
      nodeType: "task",
      displayName: "t",
      taskData: {
        sourceFile: "/b/databricks.yml",
        fileReferences: [{ referenceType: "python_script" }],
        taskParameterReferences: [{ name: "p", isOverriddenByJob: true, sourceLine: 8 }],
        jobParameterReferences: [{ name: "p", sourceLine: 4 }],
      },
    };
    const small: FlowGraph = {
      nodes: [node, { id: "f", nodeType: "file", displayName: "f", data: { resolvedPath: "/b/f.py" } }, { id: "w", nodeType: "widget", displayName: "p" }],
      edges: [
        { source: "t", target: "f", kind: "references" },
        { source: "f", target: "w", kind: "uses", data: { line: 12 } },
        // The same widget read twice on one line: one flow.
        { source: "f", target: "w", kind: "uses", data: { line: 12 } },
      ],
    };
    const flows = buildParameterFlowsForTask(small, new Map(small.nodes.map((n) => [n.id, n])), node);
    expect(chains(flows)).toEqual(["t:p:JOB@4>TASK@8>NOTEBOOK@12"]);
    expect(buildParameterLinkageMaps(node).taskParams.get("p")?.sourceLine).toBe(8);
  });

  test("a renamed job parameter keeps its own name in the flow (#592)", () => {
    const node: FlowGraphNode = { id: "t", nodeType: "task", displayName: "t", taskData: {
      fileReferences: [{ referenceType: "notebook" }],
      taskParameterReferences: [{ name: "input", jobParameterName: "source", isOverriddenByJob: true }],
      jobParameterReferences: [{ name: "source", sourceLine: 4 }],
    } };
    const small: FlowGraph = { nodes: [node, { id: "f", nodeType: "file", displayName: "f" }, { id: "w", nodeType: "widget", displayName: "input" }], edges: [
      { source: "t", target: "f", kind: "references" }, { source: "f", target: "w", kind: "uses" },
    ] };
    const [flow] = buildParameterFlowsForTask(small, new Map(small.nodes.map((n) => [n.id, n])), node);
    expect(flow!.segments.map(({ label, name }) => [label, name])).toEqual([["JOB", "source"], ["TASK", "input"], ["NOTEBOOK", "input"]]);
  });

  test("a renamed parameter flows from YAML through the notebook graph (#592)", async () => {
    const yaml = `bundle: {name: renamed}
resources:
  jobs:
    sample:
      parameters: [{name: source, default: red}]
      tasks:
        - task_key: load
          notebook_task:
            notebook_path: ./renamed.py
            base_parameters: {input: "{{job.parameters.source}}"}
`;
    writeFileSync(path.join(dir, "renamed.py"), "# Databricks notebook source\ndbutils.widgets.get('input')\n");
    const built = await enrichGraphWithFileContent(await extractBundleGraph(parse(yaml) as ParsedBundleConfig, dir));
    const jobNode = built.nodes.find((node) => node.nodeType === "job")!;
    const [flow] = buildParameterFlowsForJob(built as FlowGraph, jobNode as FlowGraphNode);
    expect(flow!.segments.map(({ label, name }) => [label, name])).toEqual([["JOB", "source"], ["TASK", "input"], ["NOTEBOOK", "input"]]);
  });

  test("a same-name job parameter still wins over a task reference to another parameter (#537)", () => {
    const taskParams = new Map([["input", { name: "input", jobParameterName: "source", isOverriddenByJob: true, ignoredByJob: true }]]);
    const jobParams = new Map([["input", { name: "input", sourceLine: 3 }], ["source", { name: "source", sourceLine: 5 }]]);
    expect(parameterLinkageForName("input", taskParams, jobParams)).toMatchObject({ ignoredByJob: true, jobParameterName: "input", jobSourceLine: 3 });
  });

  test("a segment's words in the summary", () => {
    expect(["JOB", "TASK", "NOTEBOOK", "SQL", "FILE"].map((label) => parameterFlowMarkdownLabel({ label: label as "JOB" }))).toEqual([
      "job parameter",
      "task parameter",
      "notebook widget",
      "SQL parameter",
      "file usage",
    ]);
  });
});

describe("Copy review summary (#392)", () => {
  const input = (issues: ReviewSummaryIssue[]) => ({
    parsedBundle: { bundle: { name: "review-summary" } },
    bundleRoot: dir,
    graph: graph as Parameters<typeof buildBundleReviewSummary>[0]["graph"],
    jobNode: job() as { id: string; displayName: string; trigger?: string },
    targetLabel: "Structural preview",
    headerPanelItems: { issues },
    parameterFlows: buildParameterFlowsForJob(graph, job()),
  });

  test("the whole summary for a real job", () => {
    const issues: ReviewSummaryIssue[] = [
      { severity: "warning", title: "Parameter not read", subtitle: "load", file: path.join(dir, "databricks.yml"), line: 21 },
      { severity: "error", title: "Missing notebook file", subtitle: "gone", file: path.join(dir, "databricks.yml"), line: 33 },
      { severity: "info", title: "Same title", subtitle: "Same title" },
    ];
    expect(buildBundleReviewSummary(input(issues)).split("\n")).toEqual([
      "## Databricks Bundle Review",
      "",
      "Bundle: review-summary",
      "Target: Structural preview",
      "Job: daily",
      "",
      "### Issues",
      "- **Error** · gone: Missing notebook file (databricks.yml:33)",
      "- **Warning** · load: Parameter not read (databricks.yml:21)",
      "- **Note** · Same title",
      "",
      "### Parameter Flow",
      "- `region` (load): job parameter -> notebook widget",
      "- `catalog` (load): task parameter -> notebook widget",
      "- `run_date` (load): job parameter -> notebook widget",
      "- `run_date` (report): job parameter -> SQL parameter",
      "",
      "### Schedule",
      "- Schedule: 0 0 6 \\* \\* ? (UTC)",
      "",
      "### Files",
      "- 3 file references",
      "- 1 missing file",
    ]);
  });

  test("names from the bundle show as text: never a link, an image, HTML or a mention (#486)", () => {
    const text = buildBundleReviewSummary({
      parsedBundle: { bundle: { name: "@platform-team" } },
      bundleRoot: "/b",
      graph: { nodes: [] },
      jobNode: { id: "j", displayName: "nightly [click](https://example.com) <img src=x>", trigger: "Schedule: *_x_*" },
      targetLabel: "dev_<b>",
      headerPanelItems: { issues: [{ severity: "error", title: "Missing file ![x](https://example.com/p.png)", subtitle: "@someone", file: "/b/a_[b].yml", line: 3 }] },
      parameterFlows: [{ id: "f", name: "a`b", taskName: "load*", segments: [{ label: "TASK", name: "a`b", file: null, line: 1, column: null }, { label: "NOTEBOOK", name: "a`b", file: null, line: 2, column: null }] }],
    }).split("\n");
    expect(lines(text, "Bundle:", "Target:", "Job:")).toEqual([
      "Bundle: @\u200bplatform-team",
      "Target: dev\\_&lt;b&gt;",
      "Job: nightly \\[click\\](https:\u200b//example.com) &lt;img src=x&gt;",
    ]);
    expect(text).toContain("- **Error** · @\u200bsomeone: Missing file !\\[x\\](https:\u200b//example.com/p.png) (a\\_\\[b\\].yml:3)");
    expect(text).toContain("- `` a`b `` (load\\*): task parameter -> notebook widget");
    expect(text).toContain("- Schedule: \\*\\_x\\_\\*");
  });

  test("no problems, no flows, no schedule", () => {
    const text = buildBundleReviewSummary({ ...input([]), parameterFlows: [], jobNode: { ...job(), trigger: "Not specified" } });
    expect(text).toContain("- No issues detected in this job.");
    expect(text).toContain("- No job/task parameter to notebook or SQL usage detected.");
    expect(text).not.toContain("### Schedule");
  });

  test("more problems than the limit: the first ones by severity, then a count", () => {
    const issues = Array.from({ length: REVIEW_SUMMARY_ISSUE_LIMIT + 3 }, (_, i) => ({ severity: i === 14 ? "error" : "warning", title: `p${i}` }));
    const lines = buildBundleReviewSummary(input(issues)).split("\n");
    const listed = lines.filter((line) => line.startsWith("- **"));
    expect(listed).toHaveLength(REVIEW_SUMMARY_ISSUE_LIMIT);
    expect(listed[0]).toBe("- **Error** · p14");
    expect(lines).toContain("- ...and 3 more.");
  });

  test("an unknown severity reads as a warning; no bundle or job names fall back", () => {
    const text = buildBundleReviewSummary({ ...input([{ severity: "toString", title: "x" }]), parsedBundle: null, jobNode: null, graph: null });
    expect(text).toContain("- **Warning** · x");
    expect(text).toContain("Bundle: Unknown bundle");
    expect(text).toContain("Job: Selected job");
    expect(text).toContain("- 0 file references");
  });

  test("the same file used twice counts once; one reference is singular", () => {
    const small = {
      nodes: [
        { nodeType: "task", parentId: "j", taskData: { fileReferences: [{ path: "./a.py", resolvedPath: "/b/a.py", exists: true }] } },
        { nodeType: "task", parentId: "j", taskData: { fileReferences: [{ path: "./a.py", resolvedPath: "/b/a.py", exists: true }] } },
        { nodeType: "task", parentId: "other", taskData: { fileReferences: [{ path: "./c.py", exists: false }] } },
      ],
    };
    const text = buildBundleReviewSummary({ ...input([]), graph: small, jobNode: { id: "j" } });
    expect(text).toContain("- 1 file reference\n- 0 missing files");
  });
});

describe("severity words and order (#392)", () => {
  test("labels, ranks and the fallback", () => {
    expect(["error", "warning", "info"].map(severityLabel)).toEqual(["Error", "Warning", "Note"]);
    expect(["error", "warning", "info"].map(severityRank)).toEqual([0, 1, 2]);
    expect([undefined, "", "fatal", "toString", "__proto__"].map(normalizeSeverity)).toEqual(["warning", "warning", "warning", "warning", "warning"]);
  });

  test("errors first, then warnings, then notes, keeping the order within each", () => {
    const items = [{ severity: "info", n: 1 }, { severity: "warning", n: 2 }, { severity: "error", n: 3 }, { n: 4 }, { severity: "error", n: 5 }];
    expect(orderBySeverity(items).map((item) => item.n)).toEqual([3, 5, 2, 4, 1]);
  });

  test("the panel's look adds colour and icon to the same words and order", () => {
    expect(severityMeta("error")).toEqual({ label: "Error", colorClass: "text-error", icon: "circle-x", rank: 0 });
    expect(severityMeta("info")).toEqual({ label: "Note", colorClass: "text-info", icon: "info", rank: 2 });
    expect(severityMeta("toString")).toEqual(severityMeta("warning"));
  });
});

describe("a job's tasks (#392)", () => {
  test("only task boxes of that job, in graph order", () => {
    expect(getCurrentJobTaskNodes(graph, job()).map((node) => node.displayName)).toEqual(["load", "report", "gone"]);
    expect(getCurrentJobTaskNodes(graph, { id: "resources.jobs.nope" })).toEqual([]);
    expect(getCurrentJobTaskNodes(undefined, job())).toEqual([]);
  });
});
