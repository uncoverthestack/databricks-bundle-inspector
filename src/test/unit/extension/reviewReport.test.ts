import { describe, expect, test } from "@jest/globals";
import { extractBundleGraph } from "../../../bundle/graph/bundleGraph.js";
import type { ParsedBundleConfig } from "../../../bundle/graph/bundleGraph.js";
import type { InspectorIssue } from "../../../bundle/issues.js";
import {
  REVIEW_REPORT_MAX_CHARACTERS,
  REVIEW_REPORT_TASK_LIMIT,
  jobReviewReport,
  type ReviewReportContext,
} from "../../../bundle/reviewReport.js";

const context: ReviewReportContext = {
  targetLabel: "dev",
  structuralPreview: false,
  cliVersion: "1.21.0",
  extensionVersion: "0.6.0",
  checkedAt: new Date(2026, 9, 28, 9, 14),
};

const bundle = (job: Record<string, unknown>, more: Record<string, unknown> = {}): ParsedBundleConfig =>
  ({ bundle: { name: "sales_analytics" }, resources: { jobs: { nightly: job, ...more } } }) as ParsedBundleConfig;

async function report(parsed: ParsedBundleConfig, issues: (jobId: string) => InspectorIssue[] = () => [], ctx = context) {
  const graph = await extractBundleGraph(parsed);
  const jobId = graph.nodes.find((node) => node.nodeType === "job" && node.resourceKey === "nightly")!.id;
  return jobReviewReport(parsed, graph, "nightly", issues(jobId), ctx);
}

const issue = (jobId: string, task: string, severity: "error" | "warning", detail: string, n = 1): InspectorIssue => ({
  id: `${task}-${severity}-${n}`,
  severity,
  kind: "missing_file",
  title: detail,
  detail,
  taskId: `${jobId}.tasks.${task}`,
  taskName: task,
  file: "/repo/resources/nightly.job.yml",
  line: 18,
});

const SALES_JOB = {
  name: "Nightly sales",
  schedule: { quartz_cron_expression: "0 0 2 * * ?", timezone_id: "Europe/London" },
  parameters: [{ name: "run_date", default: "2026-01-01" }],
  tasks: [
    { task_key: "extract", notebook_task: { notebook_path: "./src/extract.py" } },
    { task_key: "load", depends_on: [{ task_key: "extract" }], spark_python_task: { python_file: "./src/load.py" } },
    { task_key: "refresh", depends_on: [{ task_key: "load" }], pipeline_task: { pipeline_id: "${resources.pipelines.bronze.id}" } },
    { task_key: "check", depends_on: [{ task_key: "load" }], condition_task: { op: "GREATER_THAN", left: "{{tasks.load.values.rows}}", right: "0" } },
    {
      task_key: "per_region",
      depends_on: [{ task_key: "check", outcome: "true" }],
      for_each_task: { inputs: '["emea","amer"]', task: { task_key: "region_report", notebook_task: { notebook_path: "./src/region.py" } } },
    },
  ],
};

describe("jobReviewReport", () => {
  test("long YAML metadata cannot exceed the report's hard character budget", async () => {
    const markdown = await report(bundle({ name: "name".repeat(20_000), tasks: [] }));
    expect(markdown.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
    expect(markdown).toContain("### Not checked");
  });

  test("a starts URL containing a backtick still occupies one escaped table cell", async () => {
    const markdown = await report(bundle({
      trigger: { file_arrival: { url: "s3://bucket/`folder|name" } }, tasks: [],
    }));
    expect(markdown).toContain("s3://bucket/`folder\\|name");
  });

  test("backtick runs in a file name cannot close its inline code", async () => {
    const markdown = await report(bundle({ tasks: [{
      task_key: "t", notebook_task: { notebook_path: "./src/``name.py" },
    }] }));
    expect(markdown).toContain("``` ./src/``name.py ```");
  });

  test("an omitted oversized parameter table is explicitly disclosed", async () => {
    const markdown = await report(bundle({
      parameters: Array.from({ length: 1000 }, (_, i) => ({ name: `p${i}`, default: "x".repeat(120) })),
      tasks: [],
    }));
    expect(markdown).toContain("the job parameters");
    expect(markdown.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
  });

  test("copies all job parameters, including those beyond the graph's three-row summary", async () => {
    const markdown = await report(bundle({
      parameters: Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, default: `v${i}` })), tasks: [],
    }));
    for (let i = 0; i < 7; i++) expect(markdown).toContain(`| \`p${i}\` | \`v${i}\` |`);
  });

  test("a caller's inner for-each task is recognized as starting the reviewed job", async () => {
    const markdown = await report(bundle({ tasks: [] }, { caller: { tasks: [{ task_key: "each", for_each_task: {
      inputs: "[1,2]", task: { task_key: "run", run_job_task: { job_id: "${resources.jobs.nightly.id}" } },
    } }] } }));
    expect(markdown).toContain("| Starts | By the job caller, in this bundle |");
  });

  test("includes a for-each inner task's files and the script it runs", async () => {
    const parsed = bundle({ tasks: [SALES_JOB.tasks[4]] });
    // Give extraction a root, as a real inspection does, to resolve task file references.
    const graph = await extractBundleGraph(parsed, "/repo");
    const markdown = jobReviewReport(parsed, graph, "nightly", [], context);
    expect(markdown).toContain("### Files (1)");
    expect(markdown).toContain("./src/region.py");
    expect(markdown).toContain("| per_region → region_report | For each → Notebook | `./src/region.py`");
  });

  test("large generated jobs at the picture boundary keep every problem in the right job", async () => {
    for (const size of [0, 1, 49, 50, 51, 100, 1000]) {
      const tasks = Array.from({ length: size }, (_, i) => ({
        task_key: `task_${i}`, spark_python_task: { python_file: `./src/${i}.py` },
        ...(i ? { depends_on: [{ task_key: `task_${i - 1}` }] } : {}),
      }));
      const markdown = await report(bundle({ tasks }), (id) => size ? [
        issue(id, `task_${size - 1}`, "error", "selected job error"),
        issue("resources.jobs.other", "task_0", "error", "OTHER JOB ERROR"),
      ] : []);
      expect(markdown.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
      expect(markdown.includes("```mermaid")).toBe(size > 0 && size <= 50);
      expect(markdown).not.toContain("OTHER JOB ERROR");
      if (size) expect(markdown).toContain("selected job error");
    }
  });

  test("a header table with its own rows for the CLI and the inspector, then the counts", async () => {
    const markdown = await report(bundle(SALES_JOB), (jobId) => [
      issue(jobId, "load", "error", "File not found: ../src/load.py"),
      issue(jobId, "extract", "warning", "Widget run_date is read but not set"),
    ]);
    expect(markdown).toContain("## Databricks Bundle Review: Nightly sales");
    expect(markdown).toContain("| Job | Nightly sales (nightly) |");
    expect(markdown).toContain("| Starts | Every day at 02:00 (Europe/London), cron `0 0 2 * * ?` |");
    expect(markdown).toContain("| Databricks CLI | 1.21.0 |");
    expect(markdown).toContain("| Databricks Bundle Inspector | 0.6.0 |");
    expect(markdown).toContain("| Checked | 2026-10-28 09:14 |");
    expect(markdown).toContain("**1 error, 1 warning** in 5 tasks and");
  });

  test("errors and warnings are listed apart, each labelled, with the task, file and line", async () => {
    const markdown = await report(bundle(SALES_JOB), (jobId) => [
      issue(jobId, "extract", "warning", "Widget run_date is read but not set"),
      issue(jobId, "load", "error", "File not found: ../src/load.py"),
    ]);
    expect(markdown).toContain("### Errors (1)\n\n1. **Error** · **load**: File not found: ../src/load.py (`nightly.job.yml:18`)");
    expect(markdown).toContain("### Warnings (1)\n\n1. **Warning** · **extract**: Widget run_date is read but not set");
    expect(markdown.indexOf("### Errors")).toBeLessThan(markdown.indexOf("### Warnings"));
  });

  test("the picture: a start node, grey tasks, a red one with its count, shapes for pipeline, if/else and loop", async () => {
    const markdown = await report(bundle(SALES_JOB), (jobId) => [issue(jobId, "load", "error", "File not found")]);
    const mermaid = markdown.split("```mermaid\n")[1]!.split("```")[0]!;
    expect(mermaid).toMatch(/^flowchart LR\n/);
    expect(mermaid).toContain('start(("Every day at 02:00 (Europe/London)")):::start');
    expect(mermaid).toContain('t1["<b>extract</b><br/>Notebook"]:::task');
    expect(mermaid).toContain('t2["<b>load</b><br/>Python script<br/>1 error"]:::error');
    expect(mermaid).toContain('t3(["<b>refresh</b><br/>Pipeline"]):::task');
    expect(mermaid).toContain('t4{"<b>check</b><br/>If/else"}:::task');
    expect(mermaid).toContain('subgraph t5["per_region · for each of [#quot;emea#quot;,#quot;amer#quot;]"]');
    expect(mermaid).toContain('t5_task["<b>region_report</b><br/>Notebook"]:::task');
    expect(mermaid).toContain("start --> t1");
    expect(mermaid).toContain("t1 --> t2");
    expect(mermaid).toContain("t4 -- true --> t5");
    expect(mermaid).not.toContain("start --> t2");
  });

  test("tasks with problems come first in the task table", async () => {
    const markdown = await report(bundle(SALES_JOB), (jobId) => [issue(jobId, "refresh", "error", "x")]);
    const rows = markdown.split("### Tasks (5)")[1]!.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Task"));
    expect(rows[0]).toMatch(/^\| refresh \| Pipeline \|/);
    expect(markdown).toContain("| per_region → region_report | For each → Notebook |  | check (true) |");
    expect(markdown).toContain("| refresh | Pipeline | `pipeline bronze` | load |");
    expect(markdown).toContain("check (true)");
  });

  test("a | in a name or > in a label can't break the table or the picture", async () => {
    const loop = { ...SALES_JOB.tasks[4]!, depends_on: [], for_each_task: { ...SALES_JOB.tasks[4]!.for_each_task, inputs: '["<b>x</b>"]' } };
    const markdown = await report(bundle({ ...SALES_JOB, name: "Sales | nightly", tasks: [loop] }));
    expect(markdown).toContain("| Job | Sales \\| nightly (nightly) |");
    expect(markdown).toContain('subgraph t1["per_region · for each of [#quot;#lt;b#gt;x#lt;/b#gt;#quot;]"]');
  });

  test(`more than ${REVIEW_REPORT_TASK_LIMIT} tasks: no picture, the note says so, and the table stops at ${REVIEW_REPORT_TASK_LIMIT} rows`, async () => {
    const tasks = Array.from({ length: 60 }, (_, i) => ({ task_key: `t_${i}`, notebook_task: { notebook_path: `./src/n${i}.py` } }));
    const markdown = await report(bundle({ name: "big", tasks }), (jobId) => [issue(jobId, "t_59", "error", "broken")]);
    expect(markdown).not.toContain("```mermaid");
    expect(markdown).toContain(
      "Unfortunately, this job has 60 tasks, more than 50, which would be difficult to view as a picture.",
    );
    const rows = markdown.split("### Tasks (60)")[1]!.split("### ")[0]!.split("\n").filter((line) => /^\| t_\d+ \|/.test(line));
    expect(rows).toHaveLength(50);
    expect(rows[0]).toMatch(/^\| t_59 \|/);
    expect(markdown).toContain("...and 10 more tasks.");
  });

  test(`stays under ${REVIEW_REPORT_MAX_CHARACTERS} characters: errors kept before warnings, and it says what was left out`, async () => {
    const long = "x".repeat(1_000);
    const markdown = await report(bundle(SALES_JOB), (jobId) => [
      issue(jobId, "load", "error", "File not found: ../src/load.py"),
      ...Array.from({ length: 400 }, (_, i) => issue(jobId, "extract", "warning", `${i} ${long}`, i)),
    ]);
    expect(markdown.length).toBeLessThanOrEqual(REVIEW_REPORT_MAX_CHARACTERS);
    expect(markdown).toContain("### Errors (1)");
    expect(markdown).toContain("### Warnings (400)");
    expect(markdown).toMatch(/\.\.\.and \d+ more warnings\. VS Code's Problems panel has them all\./);
    // A long message is cut, never the whole report.
    expect(markdown).toContain("…");
    expect(markdown).toContain("| Databricks CLI | 1.21.0 |");
    expect(markdown).toContain("### Not checked");
  });

  test("how the job starts: continuous, run by another job in the bundle, or neither", async () => {
    const continuous = await report(bundle({ name: "c", continuous: { pause_status: "PAUSED" }, tasks: SALES_JOB.tasks.slice(0, 1) }));
    expect(continuous).toContain("| Starts | Continuously, paused |");
    expect(continuous).toContain('start(("Always running, paused")):::start');

    const runner = { name: "r", tasks: [{ task_key: "go", run_job_task: { job_id: "${resources.jobs.nightly.id}" } }] };
    const started = await report(bundle({ name: "n", tasks: SALES_JOB.tasks.slice(0, 1) }, { runner }));
    expect(started).toContain("| Starts | By the job runner, in this bundle |");
    expect(started).toContain("The bundle's 1 other job. Copy its report from the graph.");

    const manual = await report(bundle({ name: "m", tasks: SALES_JOB.tasks.slice(0, 1) }));
    expect(manual).toContain("| Starts | By hand or from outside this bundle |");
    expect(manual).not.toContain("start((");
  });

  // Shapes from the Databricks CLI's acceptance bundles (undefined_resources, variables/issue_2436).
  test("another job with no body, or with tasks from a complex variable, doesn't stop the report", async () => {
    const tasks = SALES_JOB.tasks.slice(0, 1);
    const runner = { name: "r", tasks: [{ task_key: "go", run_job_task: { job_id: "${resources.jobs.nightly.id}" } }] };
    const others = { empty: null, from_variable: { tasks: "${var.job_tasks}" }, runner };
    expect(await report(bundle({ name: "n", tasks }, others))).toContain("| Starts | By the job runner, in this bundle |");

    const tables = await report(bundle({ name: "t", trigger: { table_update: { table_names: "${var.tables}" } }, tasks }));
    expect(tables).toContain("| Starts | By hand or from outside this bundle |");
  });

  test("the structural preview says the workspace wasn't contacted; an unknown CLI says so", async () => {
    const { cliVersion: _known, ...unknownCli } = context;
    const markdown = await report(bundle(SALES_JOB), () => [], {
      ...unknownCli,
      targetLabel: "structural preview",
      structuralPreview: true,
    });
    expect(markdown).toContain("| Target | structural preview |");
    expect(markdown).toContain("| Databricks CLI | Unknown |");
    expect(markdown).toContain("- The workspace: this is the structural preview, read from the bundle's files only.");
  });
});
