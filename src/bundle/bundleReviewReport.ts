import type { BundleGraph, BundleGraphNode, ParsedBundleConfig } from "./graph/bundleGraph.js";
import type { InspectorIssue } from "./issues.js";
import { resolveVariableForTarget } from "./targetResolution.js";
import { reportLocation } from "./reportLocation.js";
import { REVIEW_REPORT_MAX_CHARACTERS, REVIEW_REPORT_TASK_LIMIT, startsText, type ReviewReportContext } from "./reviewReport.js";
import { buildBundleOverview, CHECKED_RESOURCE_GROUPS } from "../webview/lib/bundleOverview.js";

export interface BundleReviewContext extends ReviewReportContext {
  /** The bundle definition and loaded include files, including ones defining no resources. */
  bundleFiles?: readonly string[];
  /** Unresolved preview, retained when switching targets, for provenance and usage. */
  writtenBundle?: ParsedBundleConfig;
  resolutionBundle?: ParsedBundleConfig;
  targetName?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
// Escape HTML as well as Markdown: a resource name must not open a details block or a link.
const markdownText = (value: unknown): string => text(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/[\\`*_[\]]/g, "\\$&").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
interface Row { cells: string[]; problems: boolean }
interface Table { heading: string; columns: string[]; rows: Row[] }

/** A whole-bundle inventory. The selected job and the overview's filters never limit it. */
export function bundleReviewReport(
  parsed: ParsedBundleConfig,
  graph: BundleGraph,
  issues: readonly InspectorIssue[],
  context: BundleReviewContext,
): string {
  const written = context.writtenBundle ?? parsed;
  const resolution = context.resolutionBundle ?? parsed;
  const target = context.structuralPreview ? undefined : context.targetName ?? parsed.bundle.target;
  const variableNames = Object.keys({ ...written.variables, ...resolution.variables });
  const hidden: string[] = [];
  const variableResults = new Map(variableNames.map(name => {
    const definition = record(resolution.variables?.[name]);
    const result = resolveVariableForTarget(resolution, name, target);
    const outside = result.source === "outside_files" || (result.source === "cli_resolved" && !definition.lookup && !("default" in definition));
    if (outside) {
      const leaves = (value: unknown): void => {
        if (value && typeof value === "object") Object.values(value).forEach(leaves);
        else if (value !== undefined && value !== null) hidden.push(text(value));
      };
      leaves(definition.value);
    }
    return [name, { definition, result, outside }] as const;
  }));
  const host = text(record(parsed.workspace).host);
  if (host) hidden.push(host);
  const user = record(record(parsed.workspace).current_user);
  for (const field of ["userName", "short_name", "domain_friendly_name", "displayName"]) {
    if (typeof user[field] === "string" && user[field]) hidden.push(user[field] as string);
  }
  const privatePattern = hidden.some(Boolean)
    ? new RegExp([...new Set(hidden)].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegex).join("|"), "g")
    : undefined;
  // Redact values before formatting, so even a one-character override cannot corrupt
  // Markdown tables, Mermaid identifiers or the report's character-budget accounting.
  const publicText = (value: unknown) => {
    let result = text(value).replace(/\[dev [^\]]+\]/g, "[development]");
    if (privatePattern) result = result.replace(privatePattern, "[omitted]");
    return result.includes("@") ? result.replace(/\S+/g, token => token.includes("@") ? "[user omitted]" : token) : result;
  };
  const inline = (value: unknown) => markdownText(publicText(value));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const resources = graph.nodes.filter(node => node.resourceGroup && node.resourceKey && node.id === `resources.${node.resourceGroup}.${node.resourceKey}`);
  const overview = buildBundleOverview(graph, issues);
  const boxes = new Map(overview.groups.flatMap(group => group.items).map(item => [item.id, item]));
  const owner = (issue: InspectorIssue): string | undefined => {
    const task = issue.taskId ? nodes.get(issue.taskId) : undefined;
    return task?.parentId ?? issue.resourceId;
  };
  const issuesFor = (id: string) => issues.filter(issue => owner(issue) === id);
  const important = issues.filter(issue => issue.severity === "error" || issue.severity === "warning");
  const errors = important.filter(issue => issue.severity === "error");
  const warnings = important.filter(issue => issue.severity === "warning");
  const where = (file?: string, line?: number) => inline(reportLocation(file, line, context.bundleRoot));
  const label = (id: string) => {
    const node = nodes.get(id);
    return node?.resourceKey ?? boxes.get(id)?.label ?? node?.taskKey ?? node?.displayName ?? id;
  };
  const links = (id: string, direction: "from" | "to") => overview.links.filter(link => link[direction] === id)
    .map(link => label(link[direction === "from" ? "to" : "from"])).join(", ");
  const summary = (list: readonly InspectorIssue[], checked: boolean) => {
    const rows = list.slice(0, 3).map(issue => `**${issue.severity === "error" ? "Error" : issue.severity === "warning" ? "Warning" : "Note"}** · ${inline(issue.taskName ? `${issue.taskName}: ${issue.title}` : issue.title)}`);
    if (list.length > 3) rows.push(`and ${list.length - 3} more`);
    if (!checked) rows.push("not checked yet");
    return rows.join("<br>") || "none";
  };
  const tables: Table[] = [];
  const groups = new Map<string, BundleGraphNode[]>();
  for (const node of resources) {
    const group = node.resourceGroup!;
    const list = groups.get(group) ?? [];
    list.push(node); groups.set(group, list);
  }
  const groupOrder = ["jobs", "pipelines", "catalogs", "schemas", "volumes", "sql_warehouses", "clusters", "secret_scopes", ...groups.keys()];
  const headings: Record<string, string> = { jobs: "Jobs", pipelines: "Pipelines", catalogs: "Catalogs", schemas: "Schemas", volumes: "Volumes", sql_warehouses: "SQL warehouses", clusters: "Clusters", secret_scopes: "Secret scopes" };
  for (const group of new Set(groupOrder)) {
    const list = groups.get(group);
    if (!list?.length) continue;
    const columns = group === "jobs" ? ["Job", "Name", "Starts", "Tasks", "Uses", "Runs", "Defined in", "Problems"]
      : group === "pipelines" ? ["Pipeline", "Name", "Catalog", "Schema", "Sources", "Run by", "Defined in", "Problems"]
      : ["Resource", "Name", "Used by", "Defined in", "Problems"];
    const rows = list.map(node => {
      const own = issuesFor(node.id);
      const data = record(node.data);
      const name = data.name ?? data.cluster_name ?? data.display_name;
      const fullName = [data.catalog_name, data.schema_name, name].filter(value => value !== undefined).map(text).join(".");
      const common = [where(node.sourceFile, node.sourceLine), summary(own, CHECKED_RESOURCE_GROUPS.includes(group))];
      let cells: string[];
      if (group === "jobs") {
        const tasks = graph.nodes.filter(task => task.nodeType === "task" && task.parentId === node.id);
        const runs = tasks.flatMap(task => [task.taskData, task.taskData?.nestedTask].flatMap(data => data?.fileReferences.map(ref => reportLocation(ref.resolvedPath ?? ref.path, undefined, context.bundleRoot)) ?? []));
        const starts = startsText(data, node.resourceKey!, parsed);
        cells = [inline(node.resourceKey), inline(name), inline(startsTextPlain(starts.text)), String(tasks.length), inline(overview.links.filter(link => link.from === node.id && link.kind === "uses").map(link => label(link.to)).join(", ")), inline([...new Set([...runs, ...overview.links.filter(link => link.from === node.id && link.kind === "runs").map(link => label(link.to))])].join(", ")), ...common];
      } else if (group === "pipelines") {
        const sources = node.pipelineLibraries?.map(source => reportLocation(source.resolvedPath ?? source.path, undefined, context.bundleRoot)) ?? [];
        cells = [inline(node.resourceKey), inline(name), inline(data.catalog), inline(data.schema ?? data.target), inline(sources.join(", ")), inline(links(node.id, "to")), ...common];
      } else cells = [inline(node.resourceKey), inline(fullName), inline(links(node.id, "to")), ...common];
      return { cells, problems: own.length > 0 };
    });
    tables.push({ heading: headings[group] ?? `Other resources: ${group}`, columns, rows });
  }

  const variableRows = variableNames.map(name => {
    const { definition, result, outside } = variableResults.get(name)!;
    const source = outside ? "outside repository; value omitted" : definition.lookup ? "lookup" : result.source === "target_override" ? "target" : result.source === "no_default" ? "not set" : result.source === "unresolved" ? "unresolved" : "default";
    const own = issues.filter(issue => issue.yamlPath?.startsWith(`variables.${name}.`) || issue.yamlPath === `variables.${name}` || issue.yamlPath === `targets.${target}.variables.${name}` || issue.resourceId === `var:${name}`);
    const users: string[] = [];
    for (const [group, values] of Object.entries(written.resources ?? {})) {
      for (const [key, value] of Object.entries(record(values))) {
        if (new RegExp(`\\$\\{var\\.${escapeRegex(name)}(?:[.\\[]|\\})`).test(JSON.stringify(value))) users.push(`${group}.${key}`);
      }
    }
    // The preview does not apply a target's resource overrides. Label those separately
    // rather than pretending to reproduce the CLI's merge and rename rules here.
    const reference = new RegExp(`\\$\\{var\\.${escapeRegex(name)}(?:[.\\[]|\\})`);
    for (const [group, values] of Object.entries(record(record(written.targets?.[target ?? ""]).resources))) {
      for (const [key, value] of Object.entries(record(values))) {
        if (reference.test(JSON.stringify(value))) users.push(`${group}.${key} (${target} override)`);
      }
    }
    for (const [other, definition] of Object.entries(written.variables ?? {})) {
      if (reference.test(JSON.stringify(definition))) users.push(`variable ${other}`);
    }
    const value = outside ? "omitted" : result.value ?? result.expression;
    const status = result.status === "resolved" && !value.includes("${") ? "" : context.structuralPreview ? " (as written; unresolved)" : " (unresolved)";
    return { cells: [inline(name), inline(value + status), inline(source), inline(users.join(", ")), summary(own, true)], problems: own.length > 0 || status.length > 0 };
  });
  if (variableRows.length) tables.push({ heading: "Variables", columns: ["Variable", "Value", "Source", "Used by (as written)", "Problems"], rows: variableRows });

  const files = new Set<string>(context.bundleFiles);
  const fileProblems = new Map<string, InspectorIssue[]>();
  for (const node of graph.nodes) {
    if (node.sourceFile) files.add(node.sourceFile);
    if (node.nodeType === "file") files.add(text(node.data.resolvedPath ?? node.data.path ?? node.displayName));
    for (const ref of [...(node.taskData?.fileReferences ?? []), ...(node.taskData?.nestedTask?.fileReferences ?? []), ...(node.pipelineLibraries ?? [])]) files.add(ref.resolvedPath ?? ref.path);
  }
  for (const issue of issues) {
    if (!issue.file) continue;
    files.add(issue.file);
    const list = fileProblems.get(issue.file) ?? [];
    list.push(issue); fileProblems.set(issue.file, list);
  }
  if (fileProblems.size) tables.push({ heading: "Files with problems", columns: ["File", "Problems"], rows: [...fileProblems].map(([file, own]) => ({ cells: [where(file), summary(own, true)], problems: true })) });
  const unchecked = [...groups.keys()].filter(group => !CHECKED_RESOURCE_GROUPS.includes(group));
  const header = [
    `## Databricks Bundle Review: ${inline(parsed.bundle.name ?? "Unknown bundle")}`, "",
    "| | |", "|---|---|",
    `| Bundle | ${inline(parsed.bundle.name)} |`,
    `| Target | ${inline(context.targetLabel)} |`,
    `| Mode | ${context.structuralPreview ? "structural preview" : inline(record(parsed.bundle).mode ?? record(record(parsed.targets)[target ?? ""]).mode ?? "target")} |`,
    `| Databricks CLI | ${inline(context.cliVersion ?? "Unknown")} |`,
    `| Databricks Bundle Inspector | ${inline(context.extensionVersion)} |`,
    `| Checked | ${inline(context.checkedAt.toISOString())} |`, "",
    `**${errors.length} errors, ${warnings.length} warnings**, ${resources.length} resources, ${variableNames.length} variables, ${files.size} files.`,
  ].join("\n");
  const notChecked = ["### Not checked", "",
    ...(context.structuralPreview ? ["- The workspace: this structural preview reads the bundle's files without a login."] : []),
    "- Whether the workspace objects named in the bundle exist.",
    "- Code that the bundle's files import.",
    ...(unchecked.length ? [`- Resource groups with no checks yet: ${unchecked.map(inline).join(", ")}.`] : []),
    "- Each job's task detail is in that job's own report.",
    "- Values supplied outside the repository, workspace hosts and user names are omitted.",
  ].join("\n");
  const detailLines = important.map(issue => {
    const id = owner(issue);
    const resource = id ? label(id) : "Bundle";
    const subject = issue.taskName ? `${resource} / ${issue.taskName}` : resource;
    return { severity: issue.severity, line: `1. **${issue.severity === "error" ? "Error" : "Warning"}** · **${inline(subject)}**: ${inline(issue.detail && issue.detail !== issue.title ? `${issue.title} ${issue.detail}` : issue.title)}${issue.file ? ` (${where(issue.file, issue.line)})` : ""}` };
  });
  const details = (count: number) => ["error", "warning"].flatMap(severity => {
    const rows = detailLines.slice(0, count).filter(item => item.severity === severity);
    return rows.length ? [`### ${severity === "error" ? "Errors" : "Warnings"} (${severity === "error" ? errors.length : warnings.length})`, "", ...rows.map(item => item.line), ""] : [];
  }).join("\n");
  // Put errors first both in the display and in the omission order.
  detailLines.sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
  const diagram = resources.length <= REVIEW_REPORT_TASK_LIMIT ? bundleDiagram(resources, overview.links, issuesFor, publicText) : `### Bundle diagram\n\nThis bundle has ${resources.length} resources, more than ${REVIEW_REPORT_TASK_LIMIT}, so no diagram is drawn.`;
  let showDiagram = true;
  let showClean = true;
  let detailCount = detailLines.length;
  let problemRowLimit = Infinity;
  const omitted = new Set<string>();
  const render = () => [header, "### Inventory", ...tables.map(table => tableText(table, showClean, problemRowLimit)),
    `${files.size - fileProblems.size} files with no reported problems.`, details(detailCount),
    notChecked, showDiagram ? diagram : "", omitted.size ? `_Left out to stay under GitHub's comment size limit: ${[...omitted].join(", ")}. VS Code's Problems panel has every problem._` : "",
  ].filter(Boolean).join("\n\n");
  let report = render();
  if (report.length > REVIEW_REPORT_MAX_CHARACTERS) { showDiagram = false; omitted.add("the bundle diagram"); report = render(); }
  if (report.length > REVIEW_REPORT_MAX_CHARACTERS) { showClean = false; omitted.add("the folded rows with no problems"); report = render(); }
  while (report.length > REVIEW_REPORT_MAX_CHARACTERS && detailCount > 0) {
    detailCount = Math.max(0, detailCount - Math.max(1, Math.ceil(detailCount / 4)));
    omitted.add("some problem details"); report = render();
  }
  // An inventory of thousands of broken resources can itself exceed GitHub's limit.
  problemRowLimit = Math.max(0, ...tables.map(table => table.rows.length));
  while (report.length > REVIEW_REPORT_MAX_CHARACTERS && problemRowLimit > 0) {
    problemRowLimit = Math.floor(problemRowLimit / 2); omitted.add("some inventory rows"); report = render();
  }
  // Metadata can also be arbitrarily large. Keep a complete, valid report instead of slicing Markdown.
  if (report.length > REVIEW_REPORT_MAX_CHARACTERS) report = `## Databricks Bundle Review\n\n${resources.length} resources, ${errors.length} errors, ${warnings.length} warnings.\n\n_Left out to stay under GitHub's comment size limit: the inventory and problem details._\n\n${notChecked.length < 10_000 ? notChecked : "### Not checked\n\nWorkspace objects and imported code. See the inspector for coverage."}`;
  return report;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function startsTextPlain(value: string): string { return value.replace(/`+/g, "").replace(/\\\|/g, "|"); }
function tableText(table: Table, showClean: boolean, limit: number): string {
  const render = (rows: Row[]) => [
    `| ${table.columns.join(" | ")} |`, `|${table.columns.map(() => "---").join("|")}|`,
    ...rows.map(row => `| ${row.cells.join(" | ")} |`),
  ].join("\n");
  const broken = table.rows.filter(row => row.problems).slice(0, limit);
  const clean = table.rows.filter(row => !row.problems);
  return [`#### ${markdownText(table.heading)} (${table.rows.length})`, broken.length ? render(broken) : "",
    showClean && clean.length ? `<details>\n<summary>${clean.length} ${markdownText((clean.length === 1 ? table.heading.replace(/s$/, "") : table.heading).toLowerCase())} with no reported problems</summary>\n\n${render(clean)}\n\n</details>` : "",
  ].filter(Boolean).join("\n\n");
}
function bundleDiagram(resources: BundleGraphNode[], links: Array<{ from: string; to: string }>, issuesFor: (id: string) => InspectorIssue[], publicText: (value: unknown) => string): string {
  if (!resources.length) return "";
  const ids = new Map(resources.map((node, i) => [node.id, `r${i}`]));
  const lines = resources.map(node => {
    const own = issuesFor(node.id);
    const style = own.some(issue => issue.severity === "error") ? "error" : own.some(issue => issue.severity === "warning") ? "warn" : "resource";
    const label = publicText(`${node.resourceGroup}: ${node.resourceKey}`).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\r\n]/g, " ");
    return `  ${ids.get(node.id)}["${label}"]:::${style}`;
  });
  for (const link of links) if (ids.has(link.from) && ids.has(link.to)) lines.push(`  ${ids.get(link.from)} --> ${ids.get(link.to)}`);
  return ["### Bundle diagram", "", "```mermaid", "flowchart LR", ...lines,
    "  classDef resource fill:#f4f5f7,stroke:#9aa3b4,color:#1d2330",
    "  classDef error fill:#fdeceb,stroke:#b42318,stroke-width:3px,color:#5c120c",
    "  classDef warn fill:#fdf3e1,stroke:#9a5b00,stroke-width:3px,color:#4a2c00", "```"].join("\n");
}
