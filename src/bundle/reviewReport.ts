import type { BundleGraph, BundleGraphNode, JobTask, ParsedBundleConfig } from "./graph/bundleGraph.js";
import { taskTypeLabel } from "./graph/bundleGraph.js";
import { describeCronExpression } from "./graph/cronDescription.js";
import { issueBelongsToJob, type InspectorIssue } from "./issues.js";

/** Past this many tasks the report draws no picture and lists only this many rows. */
export const REVIEW_REPORT_TASK_LIMIT = 50;

/**
 * GitHub refuses a comment longer than 65,536 characters ("Body is too long"). The report
 * stops below that, as other tools do, so a paste into an issue or pull request goes through.
 */
export const REVIEW_REPORT_MAX_CHARACTERS = 60_000;

/** A longer message is cut here; the whole text is in VS Code's Problems panel. */
const MESSAGE_LIMIT = 400;

export interface ReviewReportContext {
  /** The target the graph shows, or "structural preview". */
  targetLabel: string;
  /** The structural preview: read from the files, the workspace not contacted. */
  structuralPreview: boolean;
  /** `1.21.0`, when the CLI's version is known. */
  cliVersion?: string;
  extensionVersion: string;
  checkedAt: Date;
}

interface ReportTask {
  node: BundleGraphNode;
  key: string;
  /** A for-each task's own key; the picture draws the task it runs inside a box. */
  loop?: { innerKey: string; innerType: string; inputs?: string };
  type: string;
  runs?: string;
  dependsOn: Array<{ key: string; outcome?: string }>;
  errors: number;
  warnings: number;
}

/** The Markdown copied by Copy review, Full report, for one job. */
export function jobReviewReport(
  parsedBundle: ParsedBundleConfig,
  graph: BundleGraph,
  jobKey: string,
  issues: readonly InspectorIssue[],
  context: ReviewReportContext,
): string {
  const jobNode = graph.nodes.find((node) => node.nodeType === "job" && node.resourceKey === jobKey);
  if (!jobNode) return `## Databricks Bundle Review\n\nThe job ${jobKey} isn't in this bundle.`;
  const job = (parsedBundle.resources?.jobs?.[jobKey] ?? {}) as Record<string, unknown>;
  const taskNodes = graph.nodes.filter((node) => node.nodeType === "task" && node.parentId === jobNode.id);
  const taskIds = new Set(taskNodes.map((node) => node.id));
  const jobIssues = issues
    .filter((issue) => issueBelongsToJob(issue, jobNode.id, taskIds))
    .filter((issue) => issue.severity === "error" || issue.severity === "warning");
  const tasks = taskNodes.map((node) => reportTask(node, graph, jobIssues));
  const files = jobFiles(taskNodes);
  const errors = jobIssues.filter((issue) => issue.severity === "error");
  const warnings = jobIssues.filter((issue) => issue.severity === "warning");
  const jobName = typeof job.name === "string" && job.name.trim() ? job.name : jobKey;
  const starts = startsText(job, jobKey, parsedBundle);

  const header = [
    `## Databricks Bundle Review: ${inline(jobName)}`,
    "",
    "| | |",
    "|---|---|",
    `| Bundle | ${cell(parsedBundle.bundle?.name ?? "Unknown bundle")} |`,
    `| Target | ${cell(context.targetLabel)} |`,
    `| Job | ${cell(jobName === jobKey ? jobKey : `${jobName} (${jobKey})`)} |`,
    `| Starts | ${starts.markdown ? starts.text : cell(starts.text)} |`,
    `| Databricks CLI | ${cell(context.cliVersion ?? "Unknown")} |`,
    `| Databricks Bundle Inspector | ${cell(context.extensionVersion)} |`,
    `| Checked | ${cell(checkedAtText(context.checkedAt))} |`,
    "",
    `${countsText(errors.length, warnings.length)} in ${plural(tasks.length, "task")} and ${plural(files.length, "file")}.`,
  ].join("\n");
  const notChecked = notCheckedSection(context, parsedBundle, jobKey);

  // Filled in order of importance, each part only as far as the room left allows.
  let room = REVIEW_REPORT_MAX_CHARACTERS - header.length - notChecked.length - 200;
  const take = (text: string): string => {
    if (text.length > room) return "";
    room -= text.length;
    return text;
  };
  const errorSection = take(problemSection("Errors", "Error", errors, room));
  const warningSection = take(problemSection("Warnings", "Warning", warnings, room));
  const picture = take(pictureSection(tasks, starts.node));
  const taskTable = take(tasksSection(tasks));
  const parameters = Array.isArray(job.parameters) ? job.parameters : [];
  const parameterTable = take(parametersSection(parameters));
  const fileTable = take(filesSection(files));
  const left = [
    errors.length > 0 && !errorSection ? "the errors" : "",
    warnings.length > 0 && !warningSection ? "the warnings" : "",
    !picture && tasks.length > 0 ? "the task graph" : "",
    !taskTable && tasks.length > 0 ? "the task table" : "",
    !parameterTable && parameters.length > 0 ? "the job parameters" : "",
    !fileTable && files.length > 0 ? "the file table" : "",
  ].filter(Boolean);

  return [
    header,
    picture,
    errorSection,
    warningSection,
    taskTable,
    parameterTable,
    fileTable,
    left.length > 0
      ? `_Left out to stay under GitHub's comment size limit: ${left.join(", ")}. VS Code's Problems panel has every problem._`
      : "",
    notChecked,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function reportTask(node: BundleGraphNode, graph: BundleGraph, issues: readonly InspectorIssue[]): ReportTask {
  const key = node.taskKey ?? node.displayName;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const forEach = data.for_each_task as { inputs?: unknown; task?: Record<string, unknown> } | undefined;
  const own = issues.filter((issue) => issue.taskId === node.id);
  const dependsOn = graph.edges
    .filter((edge) => edge.kind === "depends_on" && edge.target === node.id)
    .map((edge) => {
      const source = graph.nodes.find((candidate) => candidate.id === edge.source);
      const outcome = typeof edge.data?.outcome === "string" ? edge.data.outcome : undefined;
      return { key: source?.taskKey ?? edge.source.split(".tasks.").pop() ?? edge.source, ...(outcome ? { outcome } : {}) };
    });
  // What the task runs: its file, the pipeline's key, else what the graph shows under its name.
  // A loop's subtitle is its inputs, which the picture shows already.
  const pipeline = /resources\.pipelines\.([^.}]+)/.exec(String(
    (forEach?.task?.pipeline_task as { pipeline_id?: unknown } | undefined)?.pipeline_id ?? node.subtitle ?? "",
  ))?.[1];
  const runs =
    node.taskData?.fileReferences?.[0]?.path ??
    node.taskData?.nestedTask?.fileReferences?.[0]?.path ??
    (pipeline ? `pipeline ${pipeline}` : !forEach && typeof node.subtitle === "string" ? node.subtitle : undefined);
  return {
    node,
    key,
    ...(forEach
      ? {
          loop: {
            innerKey: typeof forEach.task?.task_key === "string" ? forEach.task.task_key : `${key} task`,
            innerType: forEach.task ? taskTypeLabel(forEach.task as JobTask) : "Task",
            ...(typeof forEach.inputs === "string" ? { inputs: forEach.inputs } : {}),
          },
        }
      : {}),
    type: node.taskTypeLabel ?? "Task",
    ...(runs ? { runs } : {}),
    dependsOn,
    errors: own.filter((issue) => issue.severity === "error").length,
    warnings: own.filter((issue) => issue.severity === "warning").length,
  };
}

/** How the job starts, for the Starts row and the picture's first node. */
function startsText(
  job: Record<string, unknown>,
  jobKey: string,
  parsedBundle: ParsedBundleConfig,
): { text: string; node: string; markdown?: boolean } {
  const paused = (value: unknown) =>
    typeof value === "object" && value !== null && (value as { pause_status?: unknown }).pause_status === "PAUSED";
  const schedule = job.schedule as { quartz_cron_expression?: string; timezone_id?: string } | undefined;
  if (schedule?.quartz_cron_expression) {
    const words = describeCronExpression(schedule.quartz_cron_expression, schedule.timezone_id);
    const pause = paused(schedule) ? ", paused" : "";
    return { text: `${cell(words)}${pause}, cron ${code(schedule.quartz_cron_expression)}`, node: `${words}${pause}`, markdown: true };
  }
  if (job.continuous) {
    const pause = paused(job.continuous) ? ", paused" : "";
    return { text: `Continuously${pause}`, node: `Always running${pause}` };
  }
  const trigger = job.trigger as
    | {
        file_arrival?: { url?: string };
        table_update?: { table_names?: string[] };
        periodic?: { interval?: number; unit?: string };
      }
    | undefined;
  if (trigger) {
    const pause = paused(trigger) ? ", paused" : "";
    if (trigger.file_arrival?.url) {
      return { text: `When a file lands in ${trigger.file_arrival.url}${pause}`, node: `When a file lands${pause}` };
    }
    // The structural preview keeps `table_names: ${var.tables}` as its text.
    const tables = Array.isArray(trigger.table_update?.table_names) ? trigger.table_update.table_names : [];
    if (tables.length > 0) {
      return { text: `When ${tables.join(", ")} change${tables.length === 1 ? "s" : ""}${pause}`, node: `When ${plural(tables.length, "table")} change${pause}` };
    }
    if (trigger.periodic?.interval && trigger.periodic.unit) {
      const unit = trigger.periodic.unit.toLowerCase();
      const every = `Every ${trigger.periodic.interval} ${trigger.periodic.interval === 1 ? unit.replace(/s$/, "") : unit}`;
      return { text: `${every}${pause}`, node: `${every}${pause}` };
    }
  }
  if (Array.isArray(job.triggers) && job.triggers.length > 0) {
    return { text: `${plural(job.triggers.length, "trigger")}, set in the bundle file`, node: plural(job.triggers.length, "trigger") };
  }
  // A job with no body is null, and `tasks: ${var.tasks}` stays text in the structural preview.
  const tasksOf = (other: unknown): JobTask[] => {
    const tasks = (other as { tasks?: unknown } | null)?.tasks;
    return Array.isArray(tasks) ? tasks.filter((task): task is JobTask => typeof task === "object" && task !== null) : [];
  };
  const runner = Object.entries(parsedBundle.resources?.jobs ?? {}).find(([key, other]) =>
    key !== jobKey &&
    tasksOf(other).some(
      (task) => {
        const inner = (task.for_each_task as { task?: JobTask } | undefined)?.task;
        return [task, inner].some((candidate) => candidate?.run_job_task?.job_id === `\${resources.jobs.${jobKey}.id}`);
      },
    ),
  );
  if (runner) return { text: `By the job ${runner[0]}, in this bundle`, node: `Started by ${runner[0]}` };
  return { text: "By hand or from outside this bundle", node: "" };
}

function pictureSection(tasks: readonly ReportTask[], startNode: string): string {
  if (tasks.length === 0) return "";
  if (tasks.length > REVIEW_REPORT_TASK_LIMIT) {
    return [
      "### Task graph",
      "",
      `Unfortunately, this job has ${tasks.length} tasks, more than ${REVIEW_REPORT_TASK_LIMIT}, which would be difficult to view as a picture. The tasks with problems are listed first below.`,
    ].join("\n");
  }
  const ids = new Map(tasks.map((task, index) => [task.key, `t${index + 1}`]));
  const lines = ["flowchart LR"];
  if (startNode) lines.push(`  start(("${mermaidText(startNode)}")):::start`);
  for (const task of tasks) {
    const id = ids.get(task.key)!;
    const style = task.errors > 0 ? "error" : task.warnings > 0 ? "warn" : "task";
    const problems = problemCount(task.errors, task.warnings);
    if (task.loop) {
      const over = task.loop.inputs ? `for each of ${task.loop.inputs}` : "for each";
      lines.push(`  subgraph ${id}["${mermaidText(`${task.key} · ${short(over, 60)}`)}"]`);
      lines.push(`    ${id}_task["${label(task.loop.innerKey, task.loop.innerType, problems)}"]:::${style}`);
      lines.push("  end");
      lines.push(`  style ${id} fill:#ffffff,stroke:#9aa3b4,stroke-dasharray:5 4`);
      continue;
    }
    const text = label(task.key, task.type, problems);
    if (task.type === "Pipeline") lines.push(`  ${id}(["${text}"]):::${style}`);
    else if (task.type === "If/else") lines.push(`  ${id}{"${text}"}:::${style}`);
    else lines.push(`  ${id}["${text}"]:::${style}`);
  }
  for (const task of tasks) {
    if (task.dependsOn.length === 0 && startNode) lines.push(`  start --> ${ids.get(task.key)}`);
    for (const dependency of task.dependsOn) {
      const from = ids.get(dependency.key);
      if (!from) continue;
      const arrow = dependency.outcome ? ` -- ${dependency.outcome} --> ` : " --> ";
      lines.push(`  ${from}${arrow}${ids.get(task.key)}`);
    }
  }
  lines.push(
    "  classDef start fill:#e8edf8,stroke:#2f5fd0,color:#1d2330",
    "  classDef task fill:#f4f5f7,stroke:#9aa3b4,color:#1d2330",
    "  classDef error fill:#fdeceb,stroke:#b42318,stroke-width:3px,color:#5c120c",
    "  classDef warn fill:#fdf3e1,stroke:#9a5b00,stroke-width:3px,color:#4a2c00",
  );
  return [
    "### Task graph",
    "",
    "```mermaid",
    ...lines,
    "```",
    "",
    "Red: the task has an error. Amber: a warning. Rounded: runs a pipeline. Diamond: an if/else condition. Dashed box: a for-each loop.",
  ].join("\n");
}

function label(key: string, type: string, problems: string): string {
  return [`<b>${mermaidText(key)}</b>`, mermaidText(type), ...(problems ? [mermaidText(problems)] : [])].join("<br/>");
}

/** Problems first, then up to the task limit. */
function tasksSection(tasks: readonly ReportTask[]): string {
  if (tasks.length === 0) return "";
  const ordered = [...tasks].sort((a, b) => b.errors - a.errors || b.warnings - a.warnings);
  const shown = ordered.slice(0, REVIEW_REPORT_TASK_LIMIT);
  return [
    `### Tasks (${tasks.length})`,
    "",
    "| Task | Type | Runs | Depends on | Problems |",
    "|---|---|---|---|---|",
    ...shown.map((task) => {
      const name = task.loop ? `${task.key} → ${task.loop.innerKey}` : task.key;
      const type = task.loop ? `For each → ${task.loop.innerType}` : task.type;
      const after = task.dependsOn.map((d) => (d.outcome ? `${d.key} (${d.outcome})` : d.key)).join(", ");
      return `| ${cell(name)} | ${cell(type)} | ${task.runs ? code(short(task.runs, 120)) : ""} | ${cell(after)} | ${cell(problemCount(task.errors, task.warnings) || "None")} |`;
    }),
    ...(tasks.length > shown.length ? ["", `...and ${tasks.length - shown.length} more tasks.`] : []),
  ].join("\n");
}

function problemSection(heading: string, word: string, list: readonly InspectorIssue[], room: number): string {
  if (list.length === 0) return "";
  const lines = [`### ${heading} (${list.length})`, ""];
  let used = lines.join("\n").length + 200;
  let shown = 0;
  for (const issue of list) {
    const task = issue.taskName ? `**${inline(issue.taskName)}**: ` : "";
    const where = issue.file ? ` (${code(`${issue.file.split(/[\\/]/).pop()}${issue.line ? `:${issue.line}` : ""}`)})` : "";
    const line = `${shown + 1}. **${word}** · ${task}${inline(short(issue.detail ?? issue.title, MESSAGE_LIMIT))}${where}`;
    if (used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < list.length) {
    lines.push("", `...and ${list.length - shown} more ${heading.toLowerCase()}. VS Code's Problems panel has them all.`);
  }
  return lines.join("\n");
}

/**
 * Names only. With a target picked, a default is the CLI's filled-in value, which can come
 * from outside the repository (a `BUNDLE_VAR_` environment variable, `--var`), and the report
 * is made to be pasted where others read it.
 */
function parametersSection(parameters: Array<{ name?: string }>): string {
  if (parameters.length === 0) return "";
  return [
    "### Job parameters",
    "",
    "Names only: a default can be filled in from outside the repository, such as a `BUNDLE_VAR_` environment variable.",
    "",
    "| Parameter |",
    "|---|",
    ...parameters.map((parameter) => `| ${code(parameter.name ?? "")} |`),
  ].join("\n");
}

interface ReportFile {
  path: string;
  usedBy: string[];
  status: "Found" | "Missing" | "Not checked";
}

function jobFiles(taskNodes: readonly BundleGraphNode[]): ReportFile[] {
  const files = new Map<string, ReportFile>();
  for (const node of taskNodes) {
    for (const ref of [...(node.taskData?.fileReferences ?? []), ...(node.taskData?.nestedTask?.fileReferences ?? [])]) {
      const key = ref.resolvedPath ?? ref.path;
      const file = files.get(key) ?? {
        path: ref.path,
        usedBy: [],
        status: ref.exists === true ? "Found" : ref.exists === false && ref.resolvedPath ? "Missing" : "Not checked",
      };
      const task = node.taskKey ?? node.displayName;
      if (!file.usedBy.includes(task)) file.usedBy.push(task);
      files.set(key, file);
    }
  }
  return [...files.values()];
}

function filesSection(files: readonly ReportFile[]): string {
  if (files.length === 0) return "";
  const ordered = [...files].sort((a, b) => Number(a.status === "Found") - Number(b.status === "Found"));
  const shown = ordered.slice(0, REVIEW_REPORT_TASK_LIMIT);
  return [
    `### Files (${files.length})`,
    "",
    "| File | Used by | Status |",
    "|---|---|---|",
    ...shown.map((file) => `| ${code(short(file.path, 120))} | ${cell(file.usedBy.join(", "))} | ${file.status === "Found" ? "Found" : `**${file.status}**`} |`),
    ...(files.length > shown.length ? ["", `...and ${files.length - shown.length} more files.`] : []),
  ].join("\n");
}

function notCheckedSection(context: ReviewReportContext, parsedBundle: ParsedBundleConfig, jobKey: string): string {
  const otherJobs = Object.keys(parsedBundle.resources?.jobs ?? {}).filter((key) => key !== jobKey).length;
  const pipelines = Object.keys(parsedBundle.resources?.pipelines ?? {}).length;
  const others = [
    otherJobs > 0 ? `${plural(otherJobs, "other job")}` : "",
    pipelines > 0 ? plural(pipelines, "pipeline") : "",
  ].filter(Boolean);
  return [
    "### Not checked",
    "",
    ...(context.structuralPreview
      ? ["- The workspace: this is the structural preview, read from the bundle's files only."]
      : []),
    "- Whether the clusters, warehouses and other workspace objects the job names exist.",
    "- Code that the job's files import.",
    ...(others.length > 0
      ? [`- The bundle's ${others.join(" and ")}. Copy ${otherJobs + pipelines === 1 ? "its report" : "their reports"} from the graph.`]
      : []),
  ].join("\n");
}

function countsText(errors: number, warnings: number): string {
  if (errors === 0 && warnings === 0) return "**No errors or warnings**";
  return `**${plural(errors, "error")}, ${plural(warnings, "warning")}**`;
}

function problemCount(errors: number, warnings: number): string {
  return [errors > 0 ? plural(errors, "error") : "", warnings > 0 ? plural(warnings, "warning") : ""].filter(Boolean).join(", ");
}

function checkedAtText(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function short(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Text in a table cell: one line, `|` escaped. */
function cell(text: string): string {
  return inline(text).replace(/\|/g, "\\|");
}

/** Running text: one line. */
function inline(text: string): string {
  const flat = text.replace(/\r?\n/g, " ");
  return flat.length > 1_000 ? `${flat.slice(0, 999)}…` : flat;
}

/** Inline code that survives backticks and `|` inside it. */
function code(text: string): string {
  const flat = cell(text);
  const runs = flat.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  return runs.length ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
}

/** Text inside a quoted Mermaid label: quotes and angle brackets as entity codes. */
function mermaidText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
}
