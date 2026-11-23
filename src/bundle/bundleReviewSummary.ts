/**
 * The short Copy review summary for one job: its problems, parameter flows, schedule and file
 * counts, as Markdown. Shared by the panel and the command-line tool (#348, #392).
 */

import { fileStatusKey, type FileStatusReference } from "./fileStatus.js";
import { orderBySeverity, severityLabel } from "./issueSeverity.js";
import { getCurrentJobTaskNodes } from "./jobTasks.js";
import { parameterFlowMarkdownLabel, type ParameterFlow } from "./parameterFlows.js";
import { reportLocation } from "./reportLocation.js";

/** How many problems the summary lists before "...and N more." */
export const REVIEW_SUMMARY_ISSUE_LIMIT = 12;

export interface ReviewSummaryIssue {
  severity?: string | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
}

export interface ReviewSummaryTaskNode {
  nodeType?: string | undefined;
  parentId?: string | undefined;
  taskData?: { fileReferences?: readonly (FileStatusReference & { path?: string | undefined })[] | undefined } | undefined;
}

export interface BundleReviewSummaryInput {
  parsedBundle?: { bundle?: { name?: string | undefined } | undefined } | null | undefined;
  bundleRoot?: string | undefined;
  graph?: { nodes: readonly ReviewSummaryTaskNode[] } | null | undefined;
  jobNode?: { id: string; displayName?: string | undefined; trigger?: string | undefined } | null | undefined;
  targetLabel: string;
  /** The header's panels; only `issues` is read. */
  headerPanelItems: { issues?: readonly ReviewSummaryIssue[] | undefined };
  parameterFlows?: readonly ParameterFlow[] | null | undefined;
}

export function buildBundleReviewSummary({
  parsedBundle,
  bundleRoot,
  graph,
  jobNode,
  targetLabel,
  headerPanelItems,
  parameterFlows,
}: BundleReviewSummaryInput): string {
  const bundleName = parsedBundle?.bundle?.name ?? "Unknown bundle";
  const jobName = jobNode?.displayName ?? "Selected job";
  const lines = [
    "## Databricks Bundle Review",
    "",
    `Bundle: ${bundleName}`,
    `Target: ${targetLabel}`,
    `Job: ${jobName}`,
    "",
    "### Issues",
  ];

  const issues = headerPanelItems.issues ?? [];
  if (issues.length === 0) {
    lines.push("- No issues detected in this job.");
  } else {
    for (const issue of orderBySeverity(issues).slice(0, REVIEW_SUMMARY_ISSUE_LIMIT)) {
      const taskPrefix =
        issue.subtitle && issue.subtitle !== issue.title
          ? `${issue.subtitle}: `
          : "";
      const location = reportLocation(issue.file, issue.line, bundleRoot);
      lines.push(
        `- **${severityLabel(issue.severity)}** · ${taskPrefix}${issue.title}${location ? ` (${location})` : ""}`,
      );
    }
    if (issues.length > REVIEW_SUMMARY_ISSUE_LIMIT) {
      lines.push(`- ...and ${issues.length - REVIEW_SUMMARY_ISSUE_LIMIT} more.`);
    }
  }

  lines.push("", "### Parameter Flow");
  const flows = parameterFlows ?? [];
  if (flows.length === 0) {
    lines.push("- No job/task parameter to notebook or SQL usage detected.");
  } else {
    const seen = new Set<string>();
    for (const flow of flows) {
      const chain = flow.segments.map(parameterFlowMarkdownLabel).join(" -> ");
      const key = `${flow.taskName}:${flow.name}:${chain}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- \`${flow.name}\` (${flow.taskName}): ${chain}`);
    }
  }

  if (jobNode?.trigger && jobNode.trigger !== "Not specified") {
    lines.push("", "### Schedule", `- ${jobNode.trigger}`);
  }

  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  const fileKeys = new Set<string | undefined>();
  let missingFileCount = 0;
  for (const task of tasks) {
    for (const ref of task.taskData?.fileReferences ?? []) {
      fileKeys.add(ref.resolvedPath ?? ref.path);
      if (fileStatusKey(ref) === "missing") {
        missingFileCount += 1;
      }
    }
  }

  lines.push(
    "",
    "### Files",
    `- ${fileKeys.size} file reference${fileKeys.size === 1 ? "" : "s"}`,
    `- ${missingFileCount} missing file${missingFileCount === 1 ? "" : "s"}`,
  );

  return lines.join("\n");
}
