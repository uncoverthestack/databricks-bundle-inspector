import type {
  BundleGraph,
  BundleGraphNode,
  GraphCompute,
  GraphParameter,
  Job,
  ParsedBundleConfig,
} from "./graph/bundleGraph.js";
import type { BundleEdge } from "./graph/edges.js";
import type { DocumentationSignal } from "./documentationSignals.js";
import type { InspectorIssue } from "./issues.js";

const MERMAID_TASK_LIMIT = 25;

interface TaskDocumentation {
  id: string;
  key: string;
  type: string;
  source?: string;
  purpose?: string;
  notes: string[];
  dependsOn: string[];
  dependents: string[];
  parameters: GraphParameter[];
  compute: GraphCompute[];
  files: string[];
  variables: string[];
  libraries: string[];
  resources: string[];
  issues: InspectorIssue[];
}

interface JobDocumentation {
  bundleName: string;
  jobKey: string;
  jobName: string;
  purpose?: string;
  notes: string[];
  trigger?: string;
  runAs?: string;
  parameters: GraphParameter[];
  compute: GraphCompute[];
  tasks: TaskDocumentation[];
  issues: InspectorIssue[];
  sourceFiles: string[];
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function bulletList(items: string[], empty = "None."): string {
  const unique = [...new Set(items.filter(Boolean))];
  if (unique.length === 0) return empty;
  return unique.map((item) => `- ${item}`).join("\n");
}

function csv(items: string[], empty = "None"): string {
  const unique = [...new Set(items.filter(Boolean))];
  return unique.length > 0 ? unique.join(", ") : empty;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function documentationFileName(jobKey: string): string {
  return `${sanitizeFileName(jobKey) || "job"}.md`;
}

function nodeById(graph: BundleGraph): Map<string, BundleGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function jobNodeFor(graph: BundleGraph, jobKey: string): BundleGraphNode | undefined {
  return graph.nodes.find(
    (node) =>
      node.nodeType === "job" &&
      (node.resourceKey === jobKey ||
        node.id === `resources.jobs.${jobKey}` ||
        node.id === `resources.job.${jobKey}`),
  );
}

function jobDataFor(
  parsedBundle: ParsedBundleConfig,
  jobKey: string,
): Job | undefined {
  const resources = parsedBundle.resources as
    | (ParsedBundleConfig["resources"] & { job?: Record<string, Job> })
    | undefined;
  const jobs =
    resources?.jobs ?? resources?.job ?? {};
  return jobs[jobKey] as Job | undefined;
}

function taskNodesForJob(
  graph: BundleGraph,
  jobNode: BundleGraphNode,
): BundleGraphNode[] {
  const nodesById = nodeById(graph);
  return graph.edges
    .filter((edge) => edge.kind === "contains" && edge.source === jobNode.id)
    .flatMap((edge) => {
      const node = nodesById.get(edge.target);
      return node?.nodeType === "task" ? [node] : [];
    });
}

function taskKeyFromId(taskId: string): string {
  return taskId.split(".tasks.").at(-1) ?? taskId;
}

function signalTexts(
  signals: DocumentationSignal[],
  jobKey: string,
  taskKey?: string,
): { purpose?: string; notes: string[] } {
  const scoped = signals.filter((signal) => {
    if (signal.jobKey !== jobKey) return false;
    if (taskKey) return signal.scope === "task" && signal.taskKey === taskKey;
    return signal.scope === "job" && !signal.taskKey;
  });

  const native = scoped.find(
    (signal) =>
      signal.source === "native_description" || signal.source === "native_comment",
  );
  const dbi = scoped.filter((signal) => signal.source === "dbi_comment");
  const purpose = native?.text ?? dbi[0]?.text;
  const notes = scoped
    .filter((signal) => signal.text !== purpose)
    .map((signal) => signal.text);

  return {
    ...(purpose ? { purpose } : {}),
    notes,
  };
}

function dependencyMaps(
  graph: BundleGraph,
  taskNodes: BundleGraphNode[],
): {
  dependsOn: Map<string, string[]>;
  dependents: Map<string, string[]>;
} {
  const taskIds = new Set(taskNodes.map((task) => task.id));
  const dependsOn = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();

  for (const task of taskNodes) {
    dependsOn.set(task.id, []);
    dependents.set(task.id, []);
  }

  for (const edge of graph.edges) {
    if (
      edge.kind !== "depends_on" ||
      !taskIds.has(edge.source) ||
      !taskIds.has(edge.target)
    ) {
      continue;
    }
    dependsOn.get(edge.target)?.push(taskKeyFromId(edge.source));
    dependents.get(edge.source)?.push(taskKeyFromId(edge.target));
  }

  return { dependsOn, dependents };
}

function taskIssues(
  issues: InspectorIssue[],
  taskId: string,
): InspectorIssue[] {
  return issues.filter((issue) => issue.taskId === taskId);
}

function jobIssues(
  issues: InspectorIssue[],
  taskIds: Set<string>,
): InspectorIssue[] {
  return issues.filter((issue) => !issue.taskId || taskIds.has(issue.taskId));
}

function sourceLabel(task: BundleGraphNode): string | undefined {
  const refs = task.taskData?.fileReferences ?? [];
  if (refs[0]?.path) return refs[0].path;
  if (typeof task.subtitle === "string" && task.subtitle.trim()) {
    return task.subtitle;
  }
  return undefined;
}

function resourceLabels(task: BundleGraphNode): string[] {
  return (task.taskData?.resourceReferences ?? []).map(
    (ref) => `${ref.resourceType}.${ref.resourceName}.${ref.field}`,
  );
}

function libraryLabels(task: BundleGraphNode): string[] {
  return (task.taskData?.libraryReferences ?? []).map((ref) => ref.identifier);
}

function fileLabels(task: BundleGraphNode): string[] {
  return (task.taskData?.fileReferences ?? []).map((ref) => {
    if (ref.exists === false && ref.resolvedPath) {
      return `${ref.path} (missing)`;
    }
    return ref.path;
  });
}

function variableLabels(task: BundleGraphNode): string[] {
  return (task.taskData?.variableReferences ?? []).map(
    (ref) => ref.variableName,
  );
}

function sourceFilesFor(
  graph: BundleGraph,
  signals: DocumentationSignal[],
  jobDoc: JobDocumentation,
): string[] {
  const files = new Set<string>();
  for (const signal of signals) {
    if (signal.jobKey === jobDoc.jobKey && signal.file) files.add(signal.file);
  }
  for (const task of jobDoc.tasks) {
    const graphTask = graph.nodes.find((node) => node.id === task.id);
    if (graphTask?.taskData?.sourceFile) files.add(graphTask.taskData.sourceFile);
    for (const ref of graphTask?.taskData?.fileReferences ?? []) {
      if (ref.sourceFile) files.add(ref.sourceFile);
    }
  }
  return [...files].sort();
}

export function buildJobDocumentation(
  parsedBundle: ParsedBundleConfig,
  graph: BundleGraph,
  jobKey: string,
  signals: DocumentationSignal[],
  issues: InspectorIssue[],
): JobDocumentation {
  const jobNode = jobNodeFor(graph, jobKey);
  if (!jobNode) {
    throw new Error(`Job "${jobKey}" was not found in the bundle graph.`);
  }

  const jobData = jobDataFor(parsedBundle, jobKey);
  const taskNodes = taskNodesForJob(graph, jobNode);
  const taskIds = new Set(taskNodes.map((task) => task.id));
  const { dependsOn, dependents } = dependencyMaps(graph, taskNodes);
  const jobSignals = signalTexts(signals, jobKey);

  const tasks = taskNodes.map((task) => {
    const key = task.taskKey ?? task.displayName;
    const taskSignals = signalTexts(signals, jobKey, key);
    const source = sourceLabel(task);
    return {
      id: task.id,
      key,
      type: task.taskTypeLabel ?? task.kind,
      ...(source ? { source } : {}),
      ...(taskSignals.purpose ? { purpose: taskSignals.purpose } : {}),
      notes: taskSignals.notes,
      dependsOn: dependsOn.get(task.id) ?? [],
      dependents: dependents.get(task.id) ?? [],
      parameters: task.parameters ?? [],
      compute: task.compute ?? [],
      files: fileLabels(task),
      variables: variableLabels(task),
      libraries: libraryLabels(task),
      resources: resourceLabels(task),
      issues: taskIssues(issues, task.id),
    };
  });

  const doc: JobDocumentation = {
    bundleName: parsedBundle.bundle.name,
    jobKey,
    jobName:
      typeof jobData?.name === "string" && jobData.name.trim()
        ? jobData.name
        : jobNode.displayName,
    ...(jobSignals.purpose ? { purpose: jobSignals.purpose } : {}),
    notes: jobSignals.notes,
    ...(jobNode.trigger ? { trigger: jobNode.trigger } : {}),
    ...(jobNode.runAs ? { runAs: jobNode.runAs } : {}),
    parameters: jobNode.parameters ?? [],
    compute: jobNode.compute ?? [],
    tasks,
    issues: jobIssues(issues, taskIds),
    sourceFiles: [],
  };

  doc.sourceFiles = sourceFilesFor(graph, signals, doc);
  return doc;
}

function renderOverview(doc: JobDocumentation): string {
  return [
    "| Field | Value |",
    "| --- | --- |",
    `| Bundle | ${escapeMarkdown(doc.bundleName)} |`,
    `| Job key | ${escapeMarkdown(doc.jobKey)} |`,
    `| Job name | ${escapeMarkdown(doc.jobName)} |`,
    `| Tasks | ${doc.tasks.length} |`,
    `| Trigger | ${escapeMarkdown(doc.trigger ?? "Not specified")} |`,
    `| Run as | ${escapeMarkdown(doc.runAs ?? "Not specified")} |`,
    `| Compute | ${escapeMarkdown(csv(doc.compute.map((item) => item.label)))} |`,
  ].join("\n");
}

function mermaidId(index: number): string {
  return `task_${index + 1}`;
}

function mermaidLabel(value: string): string {
  return value.replace(/"/g, '\\"');
}

function renderExecutionFlow(doc: JobDocumentation): string {
  const dependencyLines = doc.tasks.flatMap((task) =>
    task.dependsOn.length > 0
      ? task.dependsOn.map((dependency) => `- ${code(task.key)} depends on ${code(dependency)}`)
      : [],
  );
  const entries = doc.tasks
    .filter((task) => task.dependsOn.length === 0)
    .map((task) => task.key);
  const finals = doc.tasks
    .filter((task) => task.dependents.length === 0)
    .map((task) => task.key);

  const summary = [
    `Entry tasks: ${csv(entries)}`,
    `Final tasks: ${csv(finals)}`,
    "",
    dependencyLines.length > 0
      ? dependencyLines.join("\n")
      : "No task dependencies are configured.",
  ].join("\n");

  if (doc.tasks.length === 0) return summary;
  if (doc.tasks.length > MERMAID_TASK_LIMIT) {
    return [
      `Full Mermaid DAG omitted because this job has ${doc.tasks.length} tasks.`,
      "Large jobs are easier to read as dependency summaries and task inventories.",
      "",
      summary,
    ].join("\n");
  }

  const idByTask = new Map(
    doc.tasks.map((task, index) => [task.key, mermaidId(index)]),
  );
  const nodeLines = doc.tasks.map(
    (task, index) => `  ${mermaidId(index)}["${mermaidLabel(task.key)}"]`,
  );
  const edgeLines = doc.tasks.flatMap((task) =>
    task.dependsOn.map((dependency) => {
      const source = idByTask.get(dependency);
      const target = idByTask.get(task.key);
      return source && target ? `  ${source} --> ${target}` : "";
    }),
  ).filter(Boolean);

  return [
    "```mermaid",
    "flowchart LR",
    ...nodeLines,
    ...edgeLines,
    "```",
    "",
    summary,
  ].join("\n");
}

function renderParameters(parameters: GraphParameter[]): string {
  if (parameters.length === 0) return "None.";
  return [
    "| Name | Value |",
    "| --- | --- |",
    ...parameters.map(
      (parameter) =>
        `| ${escapeMarkdown(parameter.name)} | ${escapeMarkdown(parameter.value)} |`,
    ),
  ].join("\n");
}

function renderTask(task: TaskDocumentation): string {
  const lines = [
    `### ${task.key}`,
    "",
    task.purpose ?? "No purpose documented.",
  ];

  if (task.notes.length > 0) {
    lines.push("", "Notes:", bulletList(task.notes));
  }

  lines.push(
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Type | ${escapeMarkdown(task.type)} |`,
    `| Source | ${escapeMarkdown(task.source ?? "Not specified")} |`,
    `| Depends on | ${escapeMarkdown(csv(task.dependsOn))} |`,
    `| Direct dependents | ${escapeMarkdown(csv(task.dependents))} |`,
    `| Compute | ${escapeMarkdown(csv(task.compute.map((item) => item.label)))} |`,
    "",
    "Parameters:",
    "",
    renderParameters(task.parameters),
    "",
    "References:",
    "",
    bulletList([
      ...task.files.map((item) => `File: ${code(item)}`),
      ...task.variables.map((item) => `Variable: ${code(item)}`),
      ...task.libraries.map((item) => `Library: ${code(item)}`),
      ...task.resources.map((item) => `Resource: ${code(item)}`),
    ]),
  );

  return lines.join("\n");
}

function renderReferences(doc: JobDocumentation): string {
  const files = doc.tasks.flatMap((task) => task.files);
  const variables = doc.tasks.flatMap((task) => task.variables);
  const libraries = doc.tasks.flatMap((task) => task.libraries);
  const compute = doc.tasks.flatMap((task) =>
    task.compute.map((item) => item.label),
  );

  return [
    "Files:",
    bulletList(files),
    "",
    "Variables:",
    bulletList(variables),
    "",
    "Libraries:",
    bulletList(libraries),
    "",
    "Compute:",
    bulletList(compute),
  ].join("\n");
}

export function renderJobDocumentationMarkdown(doc: JobDocumentation): string {
  const purpose = doc.purpose ?? "No purpose documented.";
  const notes =
    doc.notes.length > 0 ? ["", "## Notes", "", bulletList(doc.notes)] : [];

  return [
    `# Job: ${doc.jobName}`,
    "",
    "<!-- Generated by Databricks Bundle Inspector. Regenerate this file instead of editing generated facts by hand. -->",
    "",
    "## Purpose",
    "",
    purpose,
    ...notes,
    "",
    "## Overview",
    "",
    renderOverview(doc),
    "",
    "## Execution Flow",
    "",
    renderExecutionFlow(doc),
    "",
    "## Tasks",
    "",
    ...doc.tasks.flatMap((task) => [renderTask(task), ""]),
    "## References",
    "",
    renderReferences(doc),
    "",
    "## Source",
    "",
    bulletList(doc.sourceFiles.map((file) => code(file))),
    "",
  ].join("\n");
}
