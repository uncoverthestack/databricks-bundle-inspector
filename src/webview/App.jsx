import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ReactFlow,
  Background,
  ControlButton,
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
} from "@xyflow/react";
import { Info, LocateFixed } from "lucide-react";
import AppHeader from "./components/AppHeader";
import BundleOverview from "./components/BundleOverview";
import HeaderChipPanel from "./components/HeaderChipPanel";
import PipelineDataFlow from "./components/PipelineDataFlow";
import SeverityIcon from "./components/SeverityIcon";
import TaskNode from "./components/TaskNode";
import UsesRow from "./components/UsesRow";
import { resolveVariableForTarget } from "../bundle/targetResolution";
import { kindMeta } from "./lib/kindMeta";
import TypeDot from "./components/TypeDot";
import { runtimeSecretLabel, taskRuntimeSecrets } from "../bundle/runtimeSecrets";
import { OVERVIEW_VALUE, parseSelectionValue, resolveSelection, selectionValue } from "./lib/jobSelection";
import { buildDisplayNodes, buildDisplayVariants } from "./lib/displayNodes";
import {
  buildPipelineView,
  hasDataFlowPage,
  pipelineKeysOf,
  pipelinePanel,
  pipelineReviewSummary,
  taskPipelineKey,
} from "./lib/pipelineView";
import { orderBySeverity, severityMeta } from "./lib/issueSeverity";
import { hasTextSelection } from "./lib/textSelection";
import { signsInAsLine } from "./lib/signsInAs";
import { buildBundleOverview } from "../bundle/bundleOverview";
import { typeWords } from "./lib/overviewView";
import { resourceSelectionProperties } from "./lib/resourceTelemetry";
import { buildJobUses } from "../bundle/jobUses";
import { buildBundleReviewSummary } from "../bundle/bundleReviewSummary";
import { buildParameterFlowsForJob, buildParameterFlowsForTask, buildParameterLinkageMaps, getPrimaryFileNode, parameterLinkageForName } from "../bundle/parameterFlows";
import { variableSourceLocation } from "./lib/variableSource";
import { basename, buildTaskAdjacency, collectReachable, formatSourceLocation, getFileStatus, getTaskPath, summarizeTaskIssues } from "./lib/taskIssues";
import { buildIssueItems } from "./lib/issueItems";
import { buildSearchItems, buildStatPanelItems, displayResolvedValue, variableResolutionLabel } from "./lib/headerItems";
import { NODE_H, NODE_W, buildDagFlow, compactTaskName, dependencyOutcomeLabel, dependencyOutcomeTone } from "./lib/dagFlow";
import { problemTone } from "./lib/taskProblems";
import { UI_COLOR, colorModeForThemeKind, currentThemeKind } from "./lib/vscodeTheme";
import "@xyflow/react/dist/style.css";

const nodeTypes = { task: TaskNode };

// ── Detail panel helpers ──────────────────────────────────────

function edgeKindLabel(kind) {
  return (
    {
      contains: "CONTAINS",
      depends_on: "DEPENDS",
      references: "USES",
      uses: "USES",
      lookup: "LOOKUP",
    }[kind] ?? kind.toUpperCase()
  );
}

function TaskPill({ task, outcome, onSelectTask }) {
  const outcomeLabel =
    typeof outcome === "string" && outcome.trim()
      ? dependencyOutcomeLabel({ data: { outcome } })
      : null;
  const outcomeTone = dependencyOutcomeTone(outcomeLabel);

  return (
    <button
      type="button"
      onClick={() => onSelectTask?.(task.id)}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-widget px-2 py-0.5 text-[11px] text-link outline-none hover:bg-hover focus:ring-1 focus:ring-accent"
      title={task.displayName}
    >
      <span className="truncate">{compactTaskName(task.displayName)}</span>
      {outcomeLabel && (
        <span
          className="shrink-0 rounded border px-1 text-[9px] font-bold leading-4"
          style={{
            borderColor: outcomeTone.labelBorder,
            backgroundColor: outcomeTone.labelBg,
            color: outcomeTone.labelColor,
          }}
        >
          {outcomeLabel}
        </span>
      )}
    </button>
  );
}

function ConfigRow({ label, value, title, detail, tone = "default", onClick, children }) {
  const [detailOpen, setDetailOpen] = useState(false);
  if (!value && !children) return null;
  const clickable = Boolean(onClick);
  const valueClass =
    tone === "danger"
      ? "text-error"
      : clickable
        ? "text-link underline underline-offset-2 decoration-link/40 group-hover:text-link-active"
        : "text-fg";
  return (
    <div
      className="border-b border-line-soft py-2.5 last:border-0"
    >
      <div
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={onClick}
        onKeyDown={clickable ? (e) => e.key === "Enter" && onClick() : undefined}
        className={[
          "group flex items-start gap-4",
          clickable
            ? "cursor-pointer rounded-lg px-2 -mx-2 outline-none hover:bg-hover focus:bg-hover focus:ring-1 focus:ring-accent"
            : "",
        ].join(" ")}
      >
        <span className="w-24 shrink-0 pt-0.5 text-xs text-muted">
          {label}
        </span>
        {children ? (
          <div className="min-w-0 flex-1">{children}</div>
        ) : (
          <span
            title={title}
            className={[
              "min-w-0 flex-1 [overflow-wrap:anywhere] text-xs leading-relaxed",
              valueClass,
            ].join(" ")}
          >
            {value}
            {clickable && <span className="ml-1 text-[10px] no-underline">↗</span>}
          </span>
        )}
        {detail && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDetailOpen((o) => !o); }}
            className="shrink-0 rounded p-0.5 text-muted transition hover:bg-hover hover:text-fg-soft"
            title="Show description"
          >
            <Info size={12} />
          </button>
        )}
      </div>
      {detail && detailOpen && (
        <p className="mt-1.5 rounded-lg bg-widget px-3 py-2 text-[11px] leading-relaxed text-fg-soft">
          {detail}
        </p>
      )}
    </div>
  );
}

function parameterLinkageLabel(linkage) {
  if (!linkage) return null;
  // Issue 537: a job parameter with the same name wins over the task's value.
  if (linkage.ignoredByJob) return "JOB PARAM WINS";
  if (linkage.kind === "job_override") return "JOB PARAM LINK";
  if (linkage.kind === "task") return "TASK DEFAULT";
  if (linkage.kind === "job") return "JOB DEFAULT";
  return null;
}

function parameterLinkageDetail(linkage) {
  if (!linkage) return null;
  if (linkage.ignoredByJob) {
    return linkage.jobParameterDefault
      ? `A job parameter with the same name wins, so this value isn't used; job default is ${linkage.jobParameterDefault}`
      : "A job parameter with the same name wins, so this value isn't used";
  }
  if (linkage.kind === "job_override") {
    return linkage.jobParameterDefault
      ? `Task value references a job parameter; job default is ${linkage.jobParameterDefault}`
      : "Task value references a job parameter";
  }
  if (linkage.kind === "task") return "Inferred from task base_parameters";
  if (linkage.kind === "job") return "Inferred from job parameter default";
  return null;
}

function widgetLinkageLabel(linkage) {
  if (!linkage) return null;
  if (linkage.ignoredByJob) return "SUPPLIED BY JOB";
  if (linkage.kind === "job_override") return "SUPPLIED VIA JOB";
  if (linkage.kind === "task") return "SUPPLIED BY TASK";
  if (linkage.kind === "job") return "SUPPLIED BY JOB";
  return null;
}

function widgetLinkageDetail(name, linkage) {
  if (!linkage) return null;
  if (linkage.ignoredByJob) {
    return `Notebook widget "${name}" gets the job parameter's value; the task's own value isn't used`;
  }
  if (linkage.kind === "job_override") {
    return `Notebook widget "${name}" is supplied by a task parameter that links to a job parameter`;
  }
  if (linkage.kind === "task") {
    return `Notebook widget "${name}" is supplied by this task`;
  }
  if (linkage.kind === "job") {
    return `Notebook widget "${name}" is supplied by the job default`;
  }
  return null;
}

function parameterUsageLabel(fileReferenceType) {
  if (fileReferenceType === "sql") return "USED IN SQL";
  if (fileReferenceType === "notebook" || fileReferenceType === "python_script") {
    return "USED IN NOTEBOOK";
  }
  return "USED IN FILE";
}

function ParameterBadge({ label, tone = "source" }) {
  if (!label) return null;
  const className =
    tone === "usage"
      ? "border-ok/40 bg-ok/10 text-ok"
      : "border-accent/40 bg-accent/10 text-link-active";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${className}`}
    >
      {label}
    </span>
  );
}

function ParameterRow({
  name,
  value,
  title,
  linkage,
  usageLabel,
  compactLinkage = false,
  onOpenParameterSource,
}) {
  if (!value) return null;
  const linkageLabel = compactLinkage ? null : parameterLinkageLabel(linkage);
  const linkageDetail = compactLinkage ? null : parameterLinkageDetail(linkage);
  const clickable = Boolean(onOpenParameterSource);
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onOpenParameterSource}
      onKeyDown={
        clickable
          ? (event) => event.key === "Enter" && onOpenParameterSource()
          : undefined
      }
      className={[
        "border-b border-line-soft py-3 last:border-0",
        clickable
          ? "cursor-pointer rounded-lg px-2 -mx-2 outline-none hover:bg-hover focus:bg-hover focus:ring-1 focus:ring-accent"
          : "",
      ].join(" ")}
    >
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
        <span>{name}</span>
        <ParameterBadge label={linkageLabel} />
        <ParameterBadge label={usageLabel} tone="usage" />
      </div>
      <div
        title={title}
        className="[overflow-wrap:anywhere] text-xs leading-relaxed text-fg"
      >
        {value}
        {clickable && <span className="ml-1 text-[10px] no-underline">↗</span>}
      </div>
      {linkageDetail && (
        <div className="mt-1 text-[11px] leading-relaxed text-muted">
          {linkageDetail}
        </div>
      )}
    </div>
  );
}

function getFileTargetLabel(ref) {
  const labels = {
    notebook: "Notebook",
    sql: "SQL file",
    python_script: "Python file",
    dbt_project: "dbt project",
    directory: "Directory",
    python_wheel: "Wheel",
    jar: "JAR",
  };
  return labels[ref?.referenceType] ?? "File";
}

function getTaskSubtitleLabel(node) {
  const taskType = node.taskData?.taskType;
  if (taskType === "python_wheel") return "Package";
  if (taskType === "spark_jar") return "Main class";
  if (taskType === "pipeline") return "Pipeline";
  if (taskType === "run_job") return "Job";
  if (taskType === "condition") return "Condition";
  if (taskType === "for_each") return "Inputs";
  if (taskType === "dashboard") return "Dashboard";
  if (taskType === "dbt") return "Commands";
  if (taskType === "dbt_cloud") return "dbt Cloud job";
  if (taskType === "spark_submit") return "Parameters";
  if (taskType === "alert") return "Alert";
  if (taskType === "power_bi") return "Connection";
  if (taskType === "ai_runtime") return "Code source";
  if (taskType === "gen_ai_compute") return "Training script";
  if (taskType === "python_operator") return "Main";
  if (taskType === "ai_function") return "Function";
  if (taskType === "unknown") return "Task type";
  return "Target";
}

function getTaskTargetRows(node, primaryFileRef, primaryFileStatus) {
  const rows = [];
  const subtitle = node.subtitle;
  const fileBackedSubtitle =
    primaryFileRef && subtitle && subtitle === primaryFileRef.path;

  if (primaryFileRef) {
    const fileValue = basename(primaryFileRef.path) || primaryFileRef.path;
    const fileStatusSuffix =
      primaryFileStatus?.key && primaryFileStatus.key !== "found"
        ? ` · ${primaryFileStatus.label.toLowerCase()}`
        : "";
    rows.push({
      key: "file-target",
      label: getFileTargetLabel(primaryFileRef),
      value: `${fileValue}${fileStatusSuffix}`,
      title: primaryFileRef.path,
      tone: primaryFileStatus?.key === "missing" ? "danger" : "default",
      resolvedPath:
        primaryFileStatus?.key === "found" ? primaryFileRef.resolvedPath : null,
    });
  }

  if (subtitle && !fileBackedSubtitle) {
    rows.push({
      key: "task-target",
      label: getTaskSubtitleLabel(node),
      value: subtitle,
      title: subtitle,
      tone: "default",
      resolvedPath: null,
    });
  }

  return rows;
}

function canOpenLinkageSource(sourceFile, linkage) {
  return Boolean(
    sourceFile &&
      linkage &&
      typeof linkage.sourceLine === "number" &&
      linkage.sourceLine > 0,
  );
}

function RefItem({
  name,
  detail,
  kind,
  edgeKind,
  resolvedPath,
  missing,
  status,
  line,
  badge,
  badgeTitle,
  onBadgeClick,
  onOpenFile,
}) {
  const { color } = kindMeta(kind);
  const clickable = Boolean(resolvedPath && onOpenFile && !missing);
  const dotColor = status?.color ?? (missing ? UI_COLOR.error : color);
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpenFile(resolvedPath, line) : undefined}
      onKeyDown={
        clickable
          ? (e) => e.key === "Enter" && onOpenFile(resolvedPath, line)
          : undefined
      }
      className={[
        "flex items-center justify-between border-b border-line-soft px-3 py-2 last:border-0",
        clickable ? "cursor-pointer hover:bg-hover" : "",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-2">
        {kind === "secret_scope" && !missing && !status ? (
          <TypeDot kind={kind} />
        ) : (
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
        )}
        <span className="min-w-0">
          <span
            title={
              missing
                ? `File not found: ${resolvedPath ?? detail ?? name}`
                : detail
            }
            className={[
              "block truncate text-xs",
              missing
                ? "text-error"
                : clickable
                  ? "text-link underline underline-offset-2 decoration-link/40"
                  : "text-fg",
            ].join(" ")}
          >
            {name}
            {missing && <span className="ml-1 text-[10px]">⚠</span>}
            {clickable && (
              <span className="ml-1 text-[10px] no-underline">↗</span>
            )}
            {badge && (
              <button
                type="button"
                title={badgeTitle}
                onClick={
                  onBadgeClick
                    ? (event) => {
                        event.stopPropagation();
                        onBadgeClick();
                      }
                    : undefined
                }
                className={[
                  "ml-1.5 rounded border border-accent/40 bg-accent/10 px-1 py-0.5 text-[9px] font-semibold tracking-wider text-link-active",
                  onBadgeClick
                    ? "cursor-pointer hover:border-accent/70 hover:bg-accent/20"
                    : "",
                ].join(" ")}
              >
                {badge}
              </button>
            )}
          </span>
          {detail && detail !== name && (
            <span className="mt-0.5 block truncate text-[11px] text-muted">
              {detail}
            </span>
          )}
        </span>
      </div>
      <span
        title={line ? undefined : status?.title}
        className="ml-3 shrink-0 text-[10px] font-semibold tracking-widest text-muted"
      >
        {line ? `L${line}` : (status?.label ?? edgeKind)}
      </span>
    </div>
  );
}

function RefSection({ title, items, onOpenFile }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
        {title} · {items.length}
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        {items.map((item, i) => (
          <RefItem key={i} {...item} onOpenFile={onOpenFile} />
        ))}
      </div>
    </section>
  );
}

const ISSUE_SUMMARY_LIMIT = 4;

function IssueSummarySection({ items, onOpenFile }) {
  const itemsKey = items?.map((item) => item.id).join("|") ?? "";
  const [expandedKey, setExpandedKey] = useState(null);
  const expanded = expandedKey === itemsKey;

  if (!items?.length) return null;
  const ordered = orderBySeverity(items);
  const visibleItems = expanded ? ordered : ordered.slice(0, ISSUE_SUMMARY_LIMIT);
  const hiddenCount = ordered.length - ISSUE_SUMMARY_LIMIT;
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
        Issue Summary · {items.length}
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        {visibleItems.map((item) => {
          const clickable = Boolean(item.file && onOpenFile);
          const severity = severityMeta(item.severity);
          return (
            <div
              key={item.id}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={
                clickable
                  ? () => {
                      if (hasTextSelection()) return;
                      onOpenFile(item.file, item.line, item.column);
                    }
                  : undefined
              }
              onKeyDown={
                clickable
                  ? (event) =>
                      event.key === "Enter" &&
                      onOpenFile(item.file, item.line, item.column)
                  : undefined
              }
              className={[
                "flex items-start gap-2 border-b border-line px-3 py-2.5 last:border-0",
                clickable
                  ? "cursor-pointer outline-none hover:bg-hover focus:bg-hover focus:ring-1 focus:ring-accent"
                  : "",
              ].join(" ")}
            >
              <SeverityIcon
                severity={item.severity}
                className={`mt-0.5 shrink-0 ${severity.colorClass}`}
              />
              <div className="min-w-0 flex-1">
                <div className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${severity.colorClass}`}>
                  {severity.label}
                </div>
                <div className="mt-0.5 break-words text-xs font-medium text-fg">
                  {item.title}
                </div>
                {item.detail && (
                  <div className="mt-0.5 break-words text-[11px] text-fg-soft">
                    {item.detail}
                  </div>
                )}
                {item.fixHint && (
                  <div className="mt-1 text-[11px] leading-snug text-fg-soft">
                    {item.fixHint}
                  </div>
                )}
              </div>
              {item.location && (
                <span
                  title={item.location}
                  className="ml-2 max-w-28 shrink-0 truncate text-[10px] font-semibold text-fg-soft"
                >
                  {/* Every row is usually in the same file, so the line is what tells them apart. */}
                  {item.line ? `Ln ${item.line}` : item.location}
                  {clickable && <span className="ml-1">↗</span>}
                </span>
              )}
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpandedKey(expanded ? null : itemsKey)}
            className="w-full px-3 py-2 text-left text-[11px] font-medium text-link outline-none hover:bg-hover hover:text-link-active focus:bg-hover focus:ring-1 focus:ring-accent"
          >
            {expanded ? "Show fewer" : `Show all ${items.length} issues`}
          </button>
        )}
      </div>
    </section>
  );
}

function parameterFlowSegmentDisplay(segment) {
  if (segment.label === "JOB") return "Job default";
  if (segment.label === "TASK") return "Task value";
  if (segment.label === "NOTEBOOK") return "Notebook widget";
  if (segment.label === "SQL") return "SQL parameter";
  return "File usage";
}

function ParameterFlowSection({ flows, onOpenFile }) {
  const flowKey = flows?.map((flow) => flow.id).join("|") ?? "";
  const defaultExpanded = (flows?.length ?? 0) <= 3;
  const [expandedState, setExpandedState] = useState({
    flowKey,
    expanded: defaultExpanded,
  });
  const expanded =
    expandedState.flowKey === flowKey
      ? expandedState.expanded
      : defaultExpanded;

  if (!flows?.length) return null;
  const importantFlows = flows.filter((flow) =>
    flow.segments.some((segment) => segment.label === "TASK"),
  );
  const visibleFlows = expanded
    ? flows
    : importantFlows.length > 0
      ? importantFlows.slice(0, 3)
      : [];
  const hiddenCount = flows.length - visibleFlows.length;
  const canToggle = flows.length > visibleFlows.length || expanded;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
          Parameter Links · {flows.length}
        </div>
        {canToggle && (
          <button
            type="button"
            onClick={() =>
              setExpandedState({
                flowKey,
                expanded: !expanded,
              })
            }
            className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-link outline-none hover:bg-hover focus:ring-1 focus:ring-accent"
          >
            {expanded ? "Hide" : "Show"}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        {!expanded && visibleFlows.length === 0 && (
          <div className="px-3 py-2.5 text-[11px] leading-relaxed text-muted">
            {flows.length} detected link{flows.length === 1 ? "" : "s"} between
            bundle parameters and notebook or SQL inputs.
          </div>
        )}
        {visibleFlows.map((flow) => (
          <div key={flow.id} className="border-b border-line-soft px-3 py-2.5 last:border-0">
            <div className="mb-1.5 truncate text-xs font-medium text-fg-soft">
              {flow.name}
            </div>
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
              {flow.segments.map((segment, index) => {
                const clickable = Boolean(segment.file && onOpenFile);
                return (
                  <span
                    key={`${flow.id}:${segment.label}:${index}`}
                    className="inline-flex items-center gap-1"
                  >
                    {index > 0 && (
                      <span className="text-muted">-&gt;</span>
                    )}
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={
                        clickable
                          ? () =>
                              onOpenFile(
                                segment.file,
                                segment.line,
                                segment.column,
                              )
                          : undefined
                      }
                      title={
                        segment.file
                          ? formatSourceLocation(segment.file, segment.line)
                          : undefined
                      }
                      className={[
                        "rounded-sm text-[11px] outline-none",
                        clickable
                          ? "text-link underline decoration-link/40 underline-offset-2 hover:text-link-active focus:ring-1 focus:ring-accent"
                          : "text-muted",
                      ].join(" ")}
                    >
                      {parameterFlowSegmentDisplay(segment)}
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() =>
              setExpandedState({
                flowKey,
                expanded: true,
              })
            }
            className="w-full px-3 py-2 text-left text-[11px] text-muted outline-none hover:bg-hover hover:text-fg-soft focus:ring-1 focus:ring-accent"
          >
            Show {hiddenCount} more link{hiddenCount === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </section>
  );
}

function ComputeSection({ items }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
        Compute
      </div>
      <div className="rounded-xl border border-line px-3">
        {items.map((item, i) => (
          <div
            key={i}
            className="flex items-baseline gap-3 border-b border-line-soft py-2 last:border-0"
          >
            <span className="w-20 shrink-0 text-xs text-muted">
              Runs on
            </span>
            <span className="min-w-0 text-xs text-fg">
              <span title={item.expression} className="block break-all">
                {item.name}
              </span>
              {item.expression && item.expression !== item.name && (
                <span className="mt-0.5 block break-all text-[11px] text-muted">
                  {item.expression}
                </span>
              )}
              {item.details?.length > 0 && (
                <div className="mt-2 grid gap-1.5">
                  {item.details.map((detail) => (
                    <div
                      key={`${detail.label}:${detail.value}`}
                      className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2 text-[11px]"
                    >
                      <span className="text-muted">{detail.label}</span>
                      <span
                        title={detail.expression}
                        className="[overflow-wrap:anywhere] text-fg-soft"
                      >
                        {detail.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function VariablesSection({ items, onOpenFile, targetName }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
        Variables · {items.length}
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        {items.map((item, i) => {
          const color = item.unresolved
            ? UI_COLOR.error
            : kindMeta("variable").color;
          const { location } = item;
          const clickable = Boolean(location && onOpenFile);
          const open = () => onOpenFile(location.file, location.line, location.column);
          return (
            <div
              key={i}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              title={
                !clickable
                  ? undefined
                  : item.source === "outside_files"
                    ? `Open where ${item.name} is defined. In this target its value is set outside the bundle files, by a BUNDLE_VAR_${item.name} environment variable or .databricks/bundle/${targetName}/variable-overrides.json.`
                    : `Open where ${item.name} is set`
              }
              onClick={
                clickable
                  ? () => {
                      if (hasTextSelection()) return;
                      open();
                    }
                  : undefined
              }
              onKeyDown={
                clickable ? (event) => event.key === "Enter" && open() : undefined
              }
              className={[
                "border-b border-line-soft px-3 py-2 last:border-0",
                clickable
                  ? "cursor-pointer outline-none hover:bg-hover focus:bg-hover focus:ring-1 focus:ring-accent"
                  : "",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className={[
                      "truncate text-xs font-medium",
                      item.unresolved ? "text-error" : "text-fg",
                    ].join(" ")}
                  >
                    {item.name}
                  </span>
                </div>
                <span className="shrink-0 text-[10px] font-semibold tracking-widest text-muted">
                  {variableResolutionLabel(item)}
                  {clickable && <span className="ml-1">↗</span>}
                </span>
              </div>
              {item.value && (
                <p
                  title={item.expression}
                  className="mt-0.5 truncate pl-4 text-[11px] text-muted"
                >
                  {item.value}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TaskImpactSection({
  upstreamCount,
  downstreamCount,
  dependents,
  onSelectTask,
}) {
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
        Impact
      </div>
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line">
        <div className="border-r border-line-soft px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
            Upstream
          </div>
          <div className="mt-1 text-lg font-semibold text-fg">
            {upstreamCount}
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
            Downstream
          </div>
          <div className="mt-1 text-lg font-semibold text-fg">
            {downstreamCount}
          </div>
        </div>
      </div>
      {dependents.length > 0 && (
        <div className="mt-2 space-y-2">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
              Direct Dependents
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dependents.map((item) => (
                <TaskPill
                  key={item.task.id}
                  task={item.task}
                  outcome={item.outcome}
                  onSelectTask={onSelectTask}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Breadcrumb({ items }) {
  if (!items.length) return null;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-muted">
      {items.map((item, index) => (
        <span
          key={`${item}-${index}`}
          className="flex min-w-0 items-center gap-1"
        >
          {index > 0 && <span className="shrink-0 text-muted">/</span>}
          <span className="max-w-32 truncate" title={item}>
            {item}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Chip colours per severity, for the task's most serious issue. */
const ISSUE_CHIP_CLASS = {
  error: "border-error/40 bg-error/10 text-error",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-info/40 bg-info/10 text-info",
};
const PLAIN_CHIP_CLASS = "border-line bg-widget text-fg-soft";

function TaskStatusChips({ node, issueItems, computeItems, fileItems }) {
  // Counts the same list as the Issue Summary, so the two never disagree.
  const issueCount = issueItems.length;
  const worst = orderBySeverity(issueItems)[0]?.severity;
  const issueChip = {
    label: issueCount > 0 ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : "No issues",
    className:
      issueCount > 0
        ? ISSUE_CHIP_CLASS[worst] ?? ISSUE_CHIP_CLASS.warning
        : "border-line bg-widget text-fg-soft",
  };
  const chips = [
    node.taskTypeLabel && { label: node.taskTypeLabel, className: PLAIN_CHIP_CLASS },
    issueChip,
    computeItems[0]?.name && { label: computeItems[0].name, className: PLAIN_CHIP_CLASS },
    fileItems.length > 0 && {
      label: `${fileItems.length} file${fileItems.length === 1 ? "" : "s"}`,
      className: PLAIN_CHIP_CLASS,
    },
  ].filter(Boolean);

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={`rounded-md border px-2 py-0.5 text-[11px] ${chip.className}`}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}

function taskArtifactLabels(taskType) {
  if (taskType === "notebook") {
    return {
      secrets: "Notebook Secret Scopes",
      widgets: "Notebook Parameters",
    };
  }
  if (taskType === "sql") {
    return {
      secrets: "SQL Secret Scopes",
      widgets: "SQL Parameters",
    };
  }
  return {
    secrets: "Detected Secret Scopes",
    widgets: "Detected Parameters",
  };
}

function DetailPanel({
  nodeId,
  graph,
  parsedBundle,
  targetName,
  inspectorIssues,
  onSelectTask,
  pipelineKeys = [],
  onSelectPipeline,
  onClose,
  onOpenFile,
}) {
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph],
  );

  const node = nodeById.get(nodeId);
  if (!node || node.nodeType !== "task") return null;

  const parentJob = nodeById.get(node.parentId);
  const issueSummaryItems = summarizeTaskIssues(
    node,
    parsedBundle,
    targetName,
    inspectorIssues,
  );
  const breadcrumbItems = getTaskPath(node, parentJob);
  const sourceFile = node.taskData?.sourceFile;
  const artifactLabels = taskArtifactLabels(node.taskData?.taskType);

  // Tasks this task depends on (prereqs shown in the config row)
  const dependencyItems = graph.edges
    .filter((e) => e.kind === "depends_on" && e.target === nodeId)
    .map((edge) => ({
      edge,
      task: nodeById.get(edge.source),
      outcome: edge.data?.outcome,
    }))
    .filter((item) => item.task?.nodeType === "task");
  const dependentItems = graph.edges
    .filter((e) => e.kind === "depends_on" && e.source === nodeId)
    .map((edge) => ({
      edge,
      task: nodeById.get(edge.target),
      outcome: edge.data?.outcome,
    }))
    .filter((item) => item.task?.nodeType === "task");
  const currentJobTaskIds = new Set(
    graph.nodes
      .filter(
        (item) => item.nodeType === "task" && item.parentId === node.parentId,
      )
      .map((item) => item.id),
  );
  const taskAdjacency = buildTaskAdjacency(graph.edges, currentJobTaskIds);
  const upstreamImpactCount = collectReachable(
    nodeId,
    taskAdjacency.upstream,
  ).size;
  const downstreamImpactCount = collectReachable(
    nodeId,
    taskAdjacency.downstream,
  ).size;

  // Primary run file (first "references" edge to a file node)
  const primaryFileNode = getPrimaryFileNode(graph, nodeById, nodeId);
  const primaryFileRef = (node.taskData?.fileReferences ?? [])[0];
  const primaryFileStatus = primaryFileRef
    ? getFileStatus(primaryFileRef)
    : undefined;
  // A pipeline task of this bundle's own pipeline can open the pipeline view.
  const runsPipelineKey = (() => {
    const key = taskPipelineKey(node.data);
    return key && pipelineKeys.includes(key) ? key : undefined;
  })();
  const linkedPipelineKey = onSelectPipeline ? runsPipelineKey : undefined;
  // A loop's own row shows its inputs, so the pipeline it runs gets a row of its own.
  const loopPipelineKey = node.data?.pipeline_task ? undefined : linkedPipelineKey;
  const targetPipelineKey = loopPipelineKey ? undefined : linkedPipelineKey;
  const targetRows = getTaskTargetRows(node, primaryFileRef, primaryFileStatus)
    .map((row) => ({
      ...row,
      value: displayResolvedValue(row.value, parsedBundle, targetName),
      title:
        row.title && row.title !== row.value && row.value?.includes?.("${")
          ? `${row.value} → ${displayResolvedValue(row.value, parsedBundle, targetName)}`
          : row.title,
    }));
  const { taskParams, jobParams } = buildParameterLinkageMaps(node);

  // Compute nodes (cluster / warehouse)
  const computeItems = graph.edges
    .filter((e) => e.source === nodeId && e.kind === "uses")
    .map((e) => nodeById.get(e.target))
    .filter(
      (n) => n && (n.nodeType === "cluster" || n.nodeType === "warehouse"),
    )
    .map((n) => ({
      name: displayResolvedValue(
        n.data?.expression ?? n.displayName,
        parsedBundle,
        targetName,
      ),
      expression: n.data?.expression,
      details: Array.isArray(n.data?.details)
        ? n.data.details.map((detail) => ({
            ...detail,
            value: displayResolvedValue(
              detail.expression ?? detail.value,
              parsedBundle,
              targetName,
            ),
          }))
        : [],
      kind: n.kind,
      serverless: Boolean(n.data?.serverless),
    }));

  const fileItems = (node.taskData?.fileReferences ?? []).map((ref) => {
    const status = getFileStatus(ref);
    const resolvedPath =
      status.key === "found" || status.key === "missing"
        ? ref.resolvedPath
        : undefined;
    return {
      name: basename(ref.path) || ref.path,
      detail: ref.source ? `${ref.source} · ${ref.path}` : ref.path,
      kind: "file",
      edgeKind: ref.referenceType,
      resolvedPath,
      missing: status.key === "missing",
      status,
    };
  });

  const variableItems = [
    ...new Map(
      (node.taskData?.variableReferences ?? []).map((ref) => {
        const resolution = resolveVariableForTarget(
          parsedBundle,
          ref.variableName,
          targetName,
        );
        return [
          ref.variableName,
          {
            name: ref.variableName,
            expression: ref.expression,
            value: resolution.value,
            source: resolution.source,
            unresolved: resolution.status === "unresolved",
            // The line the badge names: a target's override only when the CLI used it.
            location: variableSourceLocation(
              graph.variableSources,
              ref.variableName,
              resolution.source === "target_override" ? targetName : null,
            ),
          },
        ];
      }),
    ).values(),
  ];

  // Secrets discovered in the task's referenced file — clickable, jumps to detected line
  const fileSecretItems = primaryFileNode
    ? graph.edges
        .filter(
          (e) => e.source === primaryFileNode.id && e.kind === "references",
        )
        .map((e) => {
          const n = nodeById.get(e.target);
          if (!n || n.nodeType !== "secret_scope") return null;
          return {
            name: n.displayName,
            kind: "secret_scope",
            resolvedPath: primaryFileNode.data?.resolvedPath ?? null,
            line: e.data?.line ?? null,
          };
        })
        .filter(Boolean)
    : [];
  // Secrets in the task's cluster config ({{secrets/scope/key}}): jumps to the YAML line
  const configSecretItems = graph.edges
    .filter((e) => e.source === nodeId && e.kind === "references")
    .map((e) => {
      const n = nodeById.get(e.target);
      if (!n || n.nodeType !== "secret_scope") return null;
      return {
        name: n.displayName,
        kind: "secret_scope",
        resolvedPath: e.data?.file ?? null,
        line: e.data?.line ?? null,
      };
    })
    .filter(Boolean);
  // Secrets the code reads without naming the scope (issue 535): the scope a parameter gives by
  // default, or a row saying it is set at run time, so the task never looks like it reads none.
  const runtimeSecretItems = taskRuntimeSecrets(graph, nodeId, (value) =>
    displayResolvedValue(value, parsedBundle, targetName),
  ).map((read) => ({
    name: read.scope ?? runtimeSecretLabel(read),
    kind: "secret_scope",
    detail: read.scope
      ? `By default, from the ${read.parameter} parameter. A run can pass another value.`
      : read.parameter
        ? `Set when the job runs, from the ${read.parameter} parameter`
        : "Set when the job runs: the code doesn't name the scope",
    resolvedPath: read.file ?? null,
    line: read.line,
  }));
  const secretItems = [...fileSecretItems, ...configSecretItems, ...runtimeSecretItems];

  // Parameters/widgets discovered in the task's referenced file — clickable, jumps to detected line
  const widgetItems = primaryFileNode
    ? graph.edges
        .filter((e) => e.source === primaryFileNode.id && e.kind === "uses")
        .map((e) => {
          const n = nodeById.get(e.target);
          if (!n || n.nodeType !== "widget") return null;
          const linkage = parameterLinkageForName(
            n.displayName,
            taskParams,
            jobParams,
          );
          const linkageLabel = widgetLinkageLabel(linkage);
          const linkageDetail = widgetLinkageDetail(n.displayName, linkage);
          const canOpenBundleSource = canOpenLinkageSource(sourceFile, linkage);
          return {
            name: n.displayName,
            kind: "widget",
            detail: linkageDetail ?? undefined,
            badge: linkageLabel,
            badgeTitle: canOpenBundleSource
              ? "Open matching bundle parameter"
              : undefined,
            onBadgeClick:
              canOpenBundleSource && onOpenFile
                ? () =>
                    onOpenFile(
                      sourceFile,
                      linkage.sourceLine,
                      linkage.sourceColumn,
                    )
                : undefined,
            resolvedPath: primaryFileNode.data?.resolvedPath ?? null,
            line: e.data?.line ?? null,
          };
        })
        .filter(Boolean)
    : [];
  const detectedWidgetNames = new Set(widgetItems.map((item) => item.name));
  const detectedParameterUsageLabel =
    detectedWidgetNames.size > 0 && primaryFileRef
      ? parameterUsageLabel(primaryFileRef.referenceType)
      : null;
  const parameterFlows = buildParameterFlowsForTask(graph, nodeById, node);

  // REFERENCES: only explicit references (no depends_on, no compute, no variables)
  const references = graph.edges
    .filter(
      (e) =>
        e.source === nodeId && e.kind !== "depends_on" && e.kind !== "uses",
    )
    .map((e) => {
      const tgt = nodeById.get(e.target);
      if (!tgt) return null;
      const isFile = tgt.nodeType === "file";
      if (isFile) return null;
      const resolvedPath = isFile ? (tgt.data?.resolvedPath ?? null) : null;
      const exists = isFile ? Boolean(tgt.data?.exists ?? true) : true;
      return {
        name: tgt.displayName,
        kind: tgt.kind,
        edgeKind: edgeKindLabel(e.kind),
        resolvedPath: exists && resolvedPath ? resolvedPath : null,
        missing: isFile && resolvedPath !== null && !exists,
      };
    })
    .filter(Boolean);

  return (
    <aside
      className="flex w-[400px] shrink-0 flex-col overflow-hidden border-l border-line"
      style={{ backgroundColor: UI_COLOR.panel }}
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-line px-5 pb-4 pt-5">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
            Task
          </div>
          <div className="truncate text-[17px] font-semibold leading-tight text-fg">
            {node.displayName}
          </div>
          <Breadcrumb items={breadcrumbItems} />
          <TaskStatusChips
            node={node}
            issueItems={issueSummaryItems}
            computeItems={computeItems}
            fileItems={fileItems}
          />
        </div>
        <button
          onClick={onClose}
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-xs text-muted transition hover:bg-hover hover:text-fg-soft"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-5 overflow-auto p-5">
        <IssueSummarySection
          items={issueSummaryItems}
          onOpenFile={onOpenFile}
        />

        {/* Task Configuration */}
        <section>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
            Task Configuration
          </div>
          <div className="rounded-xl border border-line px-3">
            <ConfigRow
              label="Parent job"
              value={displayResolvedValue(
                parentJob?.displayName,
                parsedBundle,
                targetName,
              )}
              title={parentJob?.displayName}
            />
            {parentJob?.trigger && parentJob.trigger !== "Not specified" && (
              <ConfigRow
                label={parentJob.trigger.startsWith("Schedule:") ? "Schedule" : "Trigger"}
                value={parentJob.trigger}
                detail={parentJob.triggerTooltip}
              />
            )}
            <ConfigRow label="Kind" value={node.taskTypeLabel} />
            <ConfigRow
              label="Source"
              value={sourceFile ? basename(sourceFile) : undefined}
              title={sourceFile}
              onClick={
                sourceFile && onOpenFile
                  ? () =>
                      onOpenFile(
                        sourceFile,
                        node.taskData?.sourceLine,
                        node.taskData?.sourceColumn,
                      )
                  : undefined
              }
            />
            {targetRows.map((row) => (
              <ConfigRow
                key={row.key}
                label={row.label}
                // The pipeline's key, not its `${resources.pipelines.<key>.id}` reference.
                value={row.key === "task-target" && targetPipelineKey ? targetPipelineKey : row.value}
                title={
                  row.key === "task-target" && targetPipelineKey
                    ? `${row.title}. Click to show the pipeline.`
                    : row.title
                }
                tone={row.tone}
                onClick={
                  row.key === "task-target" && targetPipelineKey
                    ? () => onSelectPipeline(targetPipelineKey)
                    : row.resolvedPath && onOpenFile
                      ? () => onOpenFile(row.resolvedPath)
                      : undefined
                }
              />
            ))}
            {loopPipelineKey && (
              <ConfigRow
                label="Pipeline"
                value={loopPipelineKey}
                title="Run inside the loop. Click to show the pipeline."
                onClick={() => onSelectPipeline(loopPipelineKey)}
              />
            )}
            {dependencyItems.length > 0 && (
              <ConfigRow label="Depends on">
                <div className="flex flex-wrap gap-1.5">
                  {dependencyItems.map((dependency) => (
                    <TaskPill
                      key={dependency.task.id}
                      task={dependency.task}
                      outcome={dependency.outcome}
                      onSelectTask={onSelectTask}
                    />
                  ))}
                </div>
              </ConfigRow>
            )}
          </div>
        </section>

        <TaskImpactSection
          upstreamCount={upstreamImpactCount}
          downstreamCount={downstreamImpactCount}
          dependents={dependentItems}
          onSelectTask={onSelectTask}
        />

        <ParameterFlowSection
          flows={parameterFlows}
          onOpenFile={onOpenFile}
        />

        {/* Parameters */}
        {node.parameters?.length ? (
          <section>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
              Parameters
            </div>
            <div className="rounded-xl border border-line px-3">
              {node.parameters.map((p, i) => (
                (() => {
                  const linkage = parameterLinkageForName(
                    p.name,
                    taskParams,
                    jobParams,
                  );
                  const displayValue = displayResolvedValue(
                    p.expression ?? p.value,
                    parsedBundle,
                    targetName,
                  );
                  const value =
                    linkage?.kind === "job_override" &&
                    linkage.effectiveValue
                      ? `${displayValue} -> ${linkage.effectiveValue}`
                      : displayValue;
                  const titleParts = [
                    p.expression ? `${p.expression} -> ${p.value}` : p.value,
                    parameterLinkageDetail(linkage),
                  ].filter(Boolean);
                  const canOpenParameterSource = canOpenLinkageSource(
                    sourceFile,
                    linkage,
                  );
                  return (
                    <ParameterRow
                      key={i}
                      name={p.name}
                      value={value}
                      title={titleParts.join(" | ")}
                      linkage={linkage}
                      usageLabel={
                        detectedWidgetNames.has(p.name)
                          ? detectedParameterUsageLabel
                          : null
                      }
                      compactLinkage={
                        parameterFlows.length > 0 &&
                        detectedWidgetNames.has(p.name)
                      }
                      onOpenParameterSource={
                        canOpenParameterSource && onOpenFile
                          ? () =>
                              onOpenFile(
                                sourceFile,
                                linkage.sourceLine,
                                linkage.sourceColumn,
                              )
                          : undefined
                      }
                    />
                  );
                })()
              ))}
            </div>
          </section>
        ) : null}

        <ComputeSection items={computeItems} />
        <VariablesSection items={variableItems} onOpenFile={onOpenFile} targetName={targetName} />
        <RefSection
          title="File References"
          items={fileItems}
          onOpenFile={onOpenFile}
        />
        <RefSection
          title={artifactLabels.secrets}
          items={secretItems}
          onOpenFile={onOpenFile}
        />
        <RefSection
          title={artifactLabels.widgets}
          items={widgetItems}
          onOpenFile={onOpenFile}
        />
        <RefSection
          title="References"
          items={references}
          onOpenFile={onOpenFile}
        />
      </div>
    </aside>
  );
}

function RecenterJobControl() {
  const { fitView } = useReactFlow();

  function recenterJob() {
    void fitView({ padding: 0.24, duration: 350 });
  }

  return (
    <ControlButton
      onClick={recenterJob}
      title="Recenter job graph"
      aria-label="Recenter job graph"
    >
      <LocateFixed size={14} strokeWidth={2.2} />
    </ControlButton>
  );
}

function FocusViewportSync({ focusRequest, flowNodes }) {
  const { setCenter } = useReactFlow();

  useEffect(() => {
    if (!focusRequest) return;
    const node = flowNodes.find((item) => item.id === focusRequest.nodeId);
    if (!node) return;
    void setCenter(node.position.x + NODE_W / 2, node.position.y + NODE_H / 2, {
      zoom: 1,
      duration: 350,
    });
  }, [focusRequest, flowNodes, setCenter]);

  return null;
}

function subscribeToThemeKind(onChange) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-vscode-theme-kind"] });
  return () => observer.disconnect();
}

/** React Flow's colour mode, kept in step with the VS Code theme while the graph is open. */
function useVscodeColorMode() {
  return colorModeForThemeKind(useSyncExternalStore(subscribeToThemeKind, currentThemeKind));
}

// ── App ───────────────────────────────────────────────────────

const BANNER_BUTTON =
  "rounded-md border border-accent/60 px-2 py-0.5 font-medium text-fg hover:bg-accent/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const BANNER_LINK =
  "underline decoration-dotted underline-offset-2 text-fg-soft hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The name the sign-in will use, and why, on its own line under the banner's first state. */
function SignsInAs({ target, signsInAs, onChooseProfile }) {
  const { lead, profile, rest, change } = signsInAsLine(target, signsInAs);
  return (
    <span data-signs-in-as={signsInAs.source} className="basis-full text-fg-soft">
      {lead} <code className="text-fg">{profile}</code>
      {rest}
      {change && onChooseProfile && (
        <>
          {" "}
          <button type="button" onClick={onChooseProfile} className={BANNER_LINK}>
            Change
          </button>
        </>
      )}
    </span>
  );
}

/**
 * The banner for a target that fell back for want of a sign-in. One state at a time, each
 * replacing the one before: needs sign-in, press Enter in the terminal, sign-in saved,
 * checking. The graph below stays usable throughout: it shows the structural preview.
 */
function SignInBanner({ signIn, fallbackMessage, onOpenTerminal, onCheckAgain, onOpenGuide, onChooseProfile }) {
  const { target, stage, blockedReason, signsInAs } = signIn;
  const warning = stage === "needed";
  const guide = (
    <button type="button" onClick={onOpenGuide} className={BANNER_LINK}>
      What does this do?
    </button>
  );
  let content;
  if (blockedReason) {
    // Once the reason is fixed (a profile or the config file), checking again plans again.
    content = (
      <>
        <span>Couldn't check {target}: you need to sign in, and {blockedReason}.</span>
        <button type="button" onClick={onCheckAgain} className={BANNER_BUTTON}>
          Check {target} again
        </button>
        {guide}
      </>
    );
  } else if (stage === "needed") {
    content = (
      <>
        <span>Couldn't check {target}. Sign in to try again.</span>
        <button type="button" onClick={onOpenTerminal} className={BANNER_BUTTON}>
          Open Sign-in Terminal
        </button>
        <button type="button" onClick={onCheckAgain} className={BANNER_BUTTON}>
          Check {target} again
        </button>
        {guide}
        {signsInAs && <SignsInAs target={target} signsInAs={signsInAs} onChooseProfile={onChooseProfile} />}
      </>
    );
  } else if (stage === "terminal") {
    content = (
      <>
        <span>Press Enter in the terminal to start sign-in.</span>
        <button type="button" onClick={onCheckAgain} className={BANNER_BUTTON}>
          Check {target} again
        </button>
        {guide}
      </>
    );
  } else if (stage === "updated") {
    content = (
      <>
        <span>The Databricks CLI saved a sign-in.</span>
        <button type="button" onClick={onCheckAgain} className={BANNER_BUTTON}>
          Check {target} again
        </button>
      </>
    );
  } else {
    content = <span>Checking {target}…</span>;
  }
  return (
    <div
      role="status"
      data-sign-in-stage={blockedReason ? "blocked" : stage}
      title={fallbackMessage ? `Databricks CLI: ${fallbackMessage}` : undefined}
      className={`flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2 text-xs text-fg ${
        warning || blockedReason ? "border-warning/40 bg-warning/10" : "border-accent/40 bg-accent/10"
      }`}
    >
      {content}
    </div>
  );
}

export default function App({
  parsedBundle,
  bundleRoot,
  resolutionBundle,
  graph,
  validationIssues = [],
  inspectorIssues = [],
  inspectedTarget,
  inspectedTargetMode,
  requestedTarget,
  targetOptions: providedTargetOptions = [],
  targetFallbackMessage,
  targetFallbackReason,
  profileChoice,
  onChooseProfile,
  signIn,
  onOpenSignInTerminal,
  onCheckTargetAgain,
  onOpenSignInGuide,
  focusIssuesNonce,
  initialResource,
  onSelectTarget,
  onOpenFile,
  onCopyReviewSummary,
  onCopyReviewReport,
  onTelemetry,
}) {
  const colorMode = useVscodeColorMode();
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [userSelection, setUserSelection] = useState(undefined);
  const [searchValue, setSearchValue] = useState("");
  const [focusRequest, setFocusRequest] = useState(null);
  const [activeHeaderPanel, setActiveHeaderPanel] = useState(() =>
    focusIssuesNonce ? "issues" : null,
  );
  const [graphMode, setGraphMode] = useState(() =>
    focusIssuesNonce ? "issues" : "all",
  );

  // Stable across renders: the graph hands its click handler to every task box, and a new
  // function would redraw them all (issue 500).
  const selectTaskNode = useCallback((nodeId) => {
    // The Issues list sits above the task details, so picking a task closes it.
    setActiveHeaderPanel(null);
    setSelectedNodeId(nodeId);
    setFocusRequest({ nodeId, nonce: Date.now() });
  }, []);

  const clearSelectedTask = useCallback(() => {
    setSelectedNodeId(null);
    setFocusRequest(null);
  }, []);

  // The clicked box's own `selected`, which is what the graph shows, decides select or clear.
  const handleNodeClick = useCallback(
    (_, node) => (node.selected ? clearSelectedTask() : selectTaskNode(node.id)),
    [clearSelectedTask, selectTaskNode],
  );

  const jobsByKey = useMemo(
    () => parsedBundle?.resources?.jobs ?? parsedBundle?.resources?.job ?? {},
    [parsedBundle],
  );
  const jobKeys = useMemo(() => Object.keys(jobsByKey), [jobsByKey]);
  const pipelineKeys = useMemo(() => pipelineKeysOf(parsedBundle), [parsedBundle]);

  const effectiveTargetName =
    inspectedTargetMode === "target"
      ? inspectedTarget || parsedBundle?.bundle?.target || requestedTarget
      : null;
  const effectiveResolutionBundle = resolutionBundle ?? parsedBundle;
  const resolveName = useCallback(
    (value) => displayResolvedValue(value, effectiveResolutionBundle, effectiveTargetName),
    [effectiveResolutionBundle, effectiveTargetName],
  );
  // Every pipeline's details for the overview's side panel, by box id (issue 436).
  const pipelineModels = useMemo(() => {
    const models = new Map();
    if (!graph) return models;
    for (const key of pipelineKeys) {
      const view = buildPipelineView(graph, parsedBundle, key, inspectorIssues);
      if (view) models.set(view.id, { view, panel: pipelinePanel(view, resolveName) });
    }
    return models;
  }, [graph, parsedBundle, pipelineKeys, inspectorIssues, resolveName]);
  // Only a pipeline with SQL sources has a page of its own: its data flow.
  const dataFlowKeys = useMemo(
    () => pipelineKeys.filter((key) => hasDataFlowPage(pipelineModels.get(`resources.pipelines.${key}`)?.view)),
    [pipelineKeys, pipelineModels],
  );

  const selection = useMemo(
    () =>
      resolveSelection(
        jobKeys,
        dataFlowKeys,
        userSelection,
        // A cursor in a pipeline selects its box on the overview instead (issue 436).
        initialResource?.group === "jobs" ? initialResource : undefined,
      ),
    [jobKeys, dataFlowKeys, userSelection, initialResource],
  );
  // Empty while a pipeline is shown, so everything about tasks stands aside.
  const selectedJobKey = selection?.group === "jobs" ? selection.key : "";
  const selectedPipelineKey = selection?.group === "pipelines" ? selection.key : undefined;

  const targetOptions = useMemo(
    () =>
      providedTargetOptions.length > 0
        ? providedTargetOptions
        : Object.keys(parsedBundle?.targets ?? {}),
    [providedTargetOptions, parsedBundle],
  );
  const targetLabel =
    inspectedTargetMode === "probe"
      ? "structural preview"
      : inspectedTarget || parsedBundle?.bundle?.target || "target";
  const targetTitle =
    inspectedTargetMode === "probe"
      ? targetFallbackMessage
        ? `Could not inspect the requested target. Showing structural preview. ${targetFallbackMessage}`
        : "Inspected as a structural preview. Use this as structural feedback, not a deploy-target guarantee."
      : `${
          inspectedTarget
            ? `Inspected target: ${inspectedTarget}.`
            : "No explicit Databricks target was reported by the bundle output."
        } The Problems panel and status bar show the structural preview.`;
  const jobOptions = useMemo(
    () =>
      jobKeys.map((key) => {
        const name = jobsByKey[key]?.name;
        const displayName =
          typeof name === "string" && name.trim()
            ? displayResolvedValue(
                name,
                effectiveResolutionBundle,
                effectiveTargetName,
              )
            : "";
        return {
          value: selectionValue({ group: "jobs", key }),
          key,
          label: displayName && displayName !== key ? `${key} (${displayName})` : key,
        };
      }),
    [jobKeys, jobsByKey, effectiveResolutionBundle, effectiveTargetName],
  );
  const pickerGroups = useMemo(() => {
    // A pipeline's details are on the overview; the picker lists the data flow pages.
    const pipelineOptions = dataFlowKeys.map((key) => ({
      value: selectionValue({ group: "pipelines", key }),
      key,
      label: `${key} · data flow`,
    }));
    return [
      ...(jobOptions.length > 0 ? [{ label: "Jobs", options: jobOptions }] : []),
      ...(pipelineOptions.length > 0 ? [{ label: "Pipelines", options: pipelineOptions }] : []),
    ];
  }, [jobOptions, dataFlowKeys]);

  const pipelineView =
    selectedPipelineKey !== undefined ? pipelineModels.get(`resources.pipelines.${selectedPipelineKey}`)?.view : undefined;

  const { flowNodes, flowEdges, jobNode } = useMemo(
    () =>
      graph && selectedJobKey
        ? buildDagFlow(
            graph,
            selectedJobKey,
            effectiveResolutionBundle,
            effectiveTargetName,
            inspectorIssues,
          )
        : { flowNodes: [], flowEdges: [], jobNode: null },
    [graph, selectedJobKey, effectiveResolutionBundle, effectiveTargetName, inspectorIssues],
  );

  const searchItems = useMemo(
    () =>
      graph && jobNode
        ? buildSearchItems(
            graph,
            jobNode,
            effectiveResolutionBundle,
            effectiveTargetName,
            inspectorIssues,
          )
        : [],
    [graph, jobNode, effectiveResolutionBundle, effectiveTargetName, inspectorIssues],
  );

  const headerPanelItems = useMemo(
    () =>
      graph && jobNode
        ? buildStatPanelItems(
            graph,
            jobNode,
            effectiveResolutionBundle,
            effectiveTargetName,
            validationIssues,
            inspectorIssues,
          )
        : {
            tasks: [],
            files: [],
            pipelines: [],
            variables: [],
            secrets: [],
            compute: [],
            // A bundle without jobs (e.g. pipelines only) still has bundle-wide issues.
            issues: graph
              ? buildIssueItems(
                  graph,
                  null,
                  effectiveResolutionBundle,
                  effectiveTargetName,
                  validationIssues,
                  inspectorIssues,
                )
              : [],
          },
    [
      graph,
      jobNode,
      effectiveResolutionBundle,
      effectiveTargetName,
      validationIssues,
      inspectorIssues,
    ],
  );

  const activeHeaderPanelItems = activeHeaderPanel
    ? (headerPanelItems[activeHeaderPanel] ?? [])
    : [];
  const activeHeaderPanelTitle =
    {
      tasks: "Tasks",
      files: "Files",
      pipelines: "Pipelines",
      variables: "Variables",
      secrets: "Secret Scopes",
      compute: "Compute",
      issues: selectedJobKey ? "Issues in This Job" : "Bundle Issues",
    }[activeHeaderPanel] ?? "";
  const selectedJobIssueCount = headerPanelItems.issues?.length ?? 0;
  // With no problem in view, Issues has nothing to filter: it is dimmed and says why, and a
  // panel that opened on Issues (from the status bar) shows All instead. A save that adds a
  // problem makes Issues available again without switching to it (issue 390).
  const nothingToFilterNote =
    graph && selectedJobIssueCount === 0
      ? selectedJobKey
        ? "No problems found in this job."
        : "No problems found in this bundle."
      : undefined;
  // Adjusted while rendering, as React advises for state that follows other state: the
  // guard makes it run once, and the panel never shows a frame in the empty Issues view.
  if (nothingToFilterNote && (graphMode === "issues" || activeHeaderPanel === "issues")) {
    if (graphMode === "issues") setGraphMode("all");
    if (activeHeaderPanel === "issues") setActiveHeaderPanel(null);
  }
  const parameterFlowsForJob = useMemo(
    () => buildParameterFlowsForJob(graph, jobNode),
    [graph, jobNode],
  );
  // The Uses row: the warehouses, clusters and secret scopes the job's tasks use (issue 363).
  const jobUses = useMemo(
    () =>
      graph && jobNode && !pipelineView
        ? buildJobUses(graph, jobNode.id, (value) =>
            displayResolvedValue(value, effectiveResolutionBundle, effectiveTargetName),
          )
        : [],
    [graph, jobNode, pipelineView, effectiveResolutionBundle, effectiveTargetName],
  );
  const [usesHoverId, setUsesHoverId] = useState(null);
  // A kept chip belongs to the job it was clicked in, so another job starts with none.
  const [usesPin, setUsesPin] = useState({ job: "", id: null });
  const usesPinnedId = usesPin.job === selectedJobKey ? usesPin.id : null;
  const activeUses = jobUses.find((item) => item.id === (usesHoverId ?? usesPinnedId));
  const usesTaskIds = useMemo(
    () => (activeUses ? new Set(activeUses.taskIds) : null),
    [activeUses],
  );
  const issueTaskIds = useMemo(() => {
    const ids = new Set();
    for (const node of flowNodes) {
      if ((node.data?.issueCounts?.total ?? 0) > 0) {
        ids.add(node.id);
      }
    }
    for (const issue of inspectorIssues) {
      if (issue.taskId) ids.add(issue.taskId);
    }
    return ids;
  }, [flowNodes, inspectorIssues]);

  const focusedTaskIds = useMemo(() => {
    if (usesTaskIds) return usesTaskIds;
    if (graphMode !== "issues" || issueTaskIds.size === 0) return null;
    return issueTaskIds;
  }, [graphMode, issueTaskIds, usesTaskIds]);

  // Built once per job; each click picks from them, so boxes that did not change keep their
  // object and only those it changed are redrawn (issue 500).
  const displayVariants = useMemo(() => buildDisplayVariants(flowNodes), [flowNodes]);
  const displayFlowNodes = useMemo(
    () =>
      buildDisplayNodes(flowNodes, displayVariants, {
        selectedNodeId,
        focusedTaskIds,
        graphMode,
        issueTaskIds,
      }),
    [flowNodes, displayVariants, focusedTaskIds, selectedNodeId, graphMode, issueTaskIds],
  );

  const displayFlowEdges = useMemo(
    () =>
      flowEdges.map((edge) => {
        // Tasks sharing a warehouse aren't linked by that, so a Uses chip fades every arrow.
        const highlighted =
          !usesTaskIds && focusedTaskIds?.has(edge.source) && focusedTaskIds?.has(edge.target);
        const dimmed = focusedTaskIds && !highlighted;
        return {
          ...edge,
          animated: highlighted,
          style: {
            ...edge.style,
            opacity: dimmed ? 0.18 : 1,
            stroke: highlighted ? UI_COLOR.accent : edge.style?.stroke,
            strokeDasharray: highlighted
              ? undefined
              : edge.style?.strokeDasharray,
            strokeWidth: highlighted ? 2.8 : edge.style?.strokeWidth,
          },
          markerEnd: {
            ...edge.markerEnd,
            color: highlighted ? UI_COLOR.accent : edge.markerEnd?.color,
          },
        };
      }),
    [flowEdges, focusedTaskIds, usesTaskIds],
  );

  const nonJobResourceTypes = useMemo(() => {
    if (!graph || jobKeys.length > 0) return [];
    const seen = new Set();
    graph.nodes
      .filter((n) => n.nodeType === "resource")
      .forEach((n) => seen.add(n.resourceGroup));
    return [...seen];
  }, [graph, jobKeys]);

  // Every bundle opens on its overview: each resource it has, and what uses what.
  const bundleOverview = useMemo(() => {
    if (!graph) return null;
    const overview = buildBundleOverview(graph, inspectorIssues, (value) =>
      displayResolvedValue(value, effectiveResolutionBundle, effectiveTargetName),
    );
    return overview.groups.length > 0 ? overview : null;
  }, [graph, inspectorIssues, effectiveResolutionBundle, effectiveTargetName]);
  // The box kept selected on the overview. It stays while a job or pipeline is open, so
  // going back shows the overview as it was left.
  const [overviewSelectedId, setOverviewSelectedId] = useState(() =>
    initialResource?.group === "pipelines" ? `resources.pipelines.${initialResource.key}` : null,
  );
  const overviewScroll = useRef(null);
  const [overviewOpenedGroups, setOverviewOpenedGroups] = useState(() => new Set());
  const atOverview = !selection && bundleOverview !== null;
  // On the overview, the header's search finds boxes instead of tasks.
  const overviewSearchItems = useMemo(
    () =>
      atOverview
        ? bundleOverview.groups.flatMap((group) =>
            group.items.map((item) => ({
              id: `overview:${item.id}`,
              overviewId: item.id,
              label: item.label,
              subtitle: typeWords(item),
              kind: item.kind,
              issueCount: item.problems.errors + item.problems.warnings,
              problemTone: problemTone(item.problems),
            })),
          )
        : [],
    [atOverview, bundleOverview],
  );

  if (!graph) {
    return (
      <div
        className="flex h-screen items-center justify-center text-sm text-fg-soft"
        style={{ backgroundColor: UI_COLOR.surface }}
      >
        Graph not available. Close this panel and use{" "}
        <span
          className="mx-1 rounded px-1.5 py-0.5 font-mono text-fg"
          style={{ backgroundColor: UI_COLOR.widget }}
        >
          Open Graph
        </span>{" "}
        again.
      </div>
    );
  }

  const rfStyle = {
    backgroundColor: UI_COLOR.surface,
    backgroundImage: `radial-gradient(circle at 1px 1px, color-mix(in srgb, ${UI_COLOR.fg} 6%, transparent) 1px, transparent 0)`,
    backgroundSize: "16px 16px",
  };

  function selectPanelItem(item) {
    onTelemetry?.("issue_item_selected");
    if (item.taskId) {
      // From the overview, a task's problem opens the task's job first.
      const jobId = graph.nodes.find((node) => node.id === item.taskId)?.parentId;
      const job = graph.nodes.find((node) => node.id === jobId);
      if (!selectedJobKey && job?.resourceKey) setUserSelection({ group: "jobs", key: job.resourceKey });
      selectTaskNode(item.taskId);
    }
    if (item.file && onOpenFile) {
      onOpenFile(item.file, item.line, item.column);
    }
    setActiveHeaderPanel(null);
  }

  function handleSearchSelect(item) {
    onTelemetry?.("search_result_selected");
    setSearchValue(item.label);
    if (item.overviewId) {
      handleOverviewSelect(item.overviewId);
      return;
    }
    selectTaskNode(item.taskId);
  }

  function handleOverviewSelect(id) {
    const item = bundleOverview?.groups.flatMap((group) => group.items).find((entry) => entry.id === id);
    const properties = resourceSelectionProperties(item, overviewSelectedId);
    if (properties) onTelemetry?.("resource_selected", properties);
    setOverviewSelectedId(id);
  }

  function handleSelectionChange(next) {
    if (!next) return;
    onTelemetry?.(next.group === "pipelines" ? "pipeline_selected" : "job_selected");
    setUserSelection(next);
    setSelectedNodeId(null);
    setSearchValue("");
    setActiveHeaderPanel(null);
    setGraphMode("all");
  }

  /** A pipeline's details live on the overview: show it there, selected (issue 436). */
  function showPipelineOnOverview(key) {
    onTelemetry?.("pipeline_selected");
    handleOverviewSelect(`resources.pipelines.${key}`);
    showOverview();
  }

  function showOverview() {
    setUserSelection({ group: "overview" });
    setSelectedNodeId(null);
    setFocusRequest(null);
    setSearchValue("");
    setActiveHeaderPanel(null);
    setGraphMode("all");
  }

  /** Opens a job or pipeline from its box on the overview. */
  function openFromOverview(item) {
    if (!item.resourceKey || (item.kind !== "job" && item.kind !== "pipeline")) return;
    if (item.kind === "pipeline" && !dataFlowKeys.includes(item.resourceKey)) return;
    if (item.kind === "job") {
      // A selected warehouse, cluster or secret scope the job uses stays lit in its Uses row.
      const kept = overviewSelectedId
        ? bundleOverview?.groups.flatMap((group) => group.items).find((entry) => entry.id === overviewSelectedId)
        : undefined;
      const usesIt =
        kept && bundleOverview.links.some((link) => link.from === item.id && link.to === kept.id && link.kind === "uses");
      if (usesIt) setUsesPin({ job: item.resourceKey, id: kept.usesId ?? kept.id });
    }
    // With nothing selected, the opened box is the one selected on the way back.
    if (!overviewSelectedId) handleOverviewSelect(item.id);
    handleSelectionChange({ group: item.kind === "job" ? "jobs" : "pipelines", key: item.resourceKey });
  }

  function handleGraphModeChange(value) {
    if (value !== graphMode) onTelemetry?.("graph_mode_changed", { mode: value });
    setGraphMode(value);
    // Issues pressed again while on Issues: open or close its list, as the list's x does.
    // The view stays on Issues either way.
    if (value === "issues" && graphMode === "issues") {
      setActiveHeaderPanel((panel) => (panel === "issues" ? null : "issues"));
      return;
    }
    setActiveHeaderPanel(value === "issues" ? "issues" : null);
  }

  function handleCopyReviewSummary() {
    if (atOverview) {
      onCopyReviewReport?.();
      return;
    }
    if (!onCopyReviewSummary) return;
    if (pipelineView) {
      onCopyReviewSummary(
        pipelineReviewSummary(pipelineView, {
          bundleName: parsedBundle?.bundle?.name ?? "Unknown bundle",
          targetLabel,
          bundleRoot,
          resolveName: (value) => displayResolvedValue(value, effectiveResolutionBundle, effectiveTargetName),
        }),
      );
      return;
    }
    onCopyReviewSummary(
      buildBundleReviewSummary({
        parsedBundle,
        bundleRoot,
        graph,
        jobNode,
        targetLabel,
        headerPanelItems,
        parameterFlows: parameterFlowsForJob,
      }),
    );
  }

  return (
    // overflow-hidden: a floating panel taller than a short webview (the Problems panel
    // open below it) must not make the page scroll, which would push the header out of view.
    <div
      className="relative flex h-screen flex-col overflow-hidden"
      style={{ backgroundColor: UI_COLOR.surface }}
    >
      <AppHeader
        copyReviewTitle={atOverview ? "Copy the full bundle report as Markdown" : undefined}
        bundleName={parsedBundle?.bundle?.name}
        targetLabel={targetLabel}
        targetTitle={targetTitle}
        targetMode={inspectedTargetMode}
        targetOptions={targetOptions}
        // What is shown, not what was asked for: a target that fell back shows the preview.
        selectedTarget={inspectedTargetMode === "target" ? requestedTarget : undefined}
        onTargetChange={onSelectTarget}
        pickerGroups={pickerGroups}
        selectedValue={selection ? selectionValue(selection) : atOverview ? OVERVIEW_VALUE : ""}
        onPickerChange={(value) =>
          value === OVERVIEW_VALUE ? showOverview() : handleSelectionChange(parseSelectionValue(value))
        }
        overviewValue={bundleOverview ? OVERVIEW_VALUE : undefined}
        onBack={selection && bundleOverview ? showOverview : undefined}
        showTaskTools={!pipelineView}
        searchPlaceholder={atOverview ? "Find a resource" : undefined}
        searchValue={searchValue}
        searchItems={atOverview ? overviewSearchItems : searchItems}
        onSearchChange={setSearchValue}
        onSearchSelect={handleSearchSelect}
        graphMode={graphMode}
        onGraphModeChange={handleGraphModeChange}
        issueCount={selectedJobIssueCount}
        nothingToFilterNote={nothingToFilterNote}
        onCopyReviewSummary={
          onCopyReviewSummary ? handleCopyReviewSummary : undefined
        }
        // The full report is for a job; a pipeline has the summary only, for now.
        onCopyReviewReport={
          onCopyReviewReport && !pipelineView && jobNode?.resourceKey
            ? () => onCopyReviewReport(jobNode.resourceKey)
            : undefined
        }
      />

      {/* With several matching profiles, the profile note below says why and offers the fix.
          A fallback signing in can fix gets the sign-in banner instead. */}
      {inspectedTargetMode === "probe" && requestedTarget && targetFallbackMessage && !profileChoice && !signIn && (
        <div
          role="status"
          title={`Databricks CLI: ${targetFallbackMessage}`}
          className="shrink-0 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-fg"
        >
          Couldn't check {requestedTarget}
          {targetFallbackReason ? `: ${targetFallbackReason}` : ""}. Pick it again to try again.
        </div>
      )}

      {signIn && (
        <SignInBanner
          signIn={signIn}
          fallbackMessage={targetFallbackMessage}
          onOpenTerminal={() => onOpenSignInTerminal?.(signIn.target)}
          onCheckAgain={() => onCheckTargetAgain?.(signIn.target)}
          onOpenGuide={onOpenSignInGuide}
          onChooseProfile={onChooseProfile}
        />
      )}

      {profileChoice && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-fg"
        >
          <span>
            Several Databricks sign-in profiles match this workspace
            {profileChoice.names.length > 0 ? ` (${profileChoice.names.join(", ")})` : ""}.
            Choose the one to use for this target.
          </span>
          <button
            type="button"
            onClick={onChooseProfile}
            className="rounded-md border border-warning/60 px-2 py-0.5 font-medium text-fg hover:bg-warning/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Choose profile
          </button>
        </div>
      )}

      {!pipelineView && !atOverview && (
        <UsesRow
          items={jobUses}
          activeId={usesHoverId ?? usesPinnedId}
          pinnedId={usesPinnedId}
          onHover={setUsesHoverId}
          onTogglePin={(id) =>
            setUsesPin({ job: selectedJobKey, id: usesPinnedId === id ? null : id })
          }
        />
      )}

      {activeHeaderPanel && (
        <HeaderChipPanel
          title={activeHeaderPanelTitle}
          items={activeHeaderPanelItems}
          onClose={() => setActiveHeaderPanel(null)}
          onSelectItem={selectPanelItem}
        />
      )}

      {/* Canvas + Detail */}
      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex-1 overflow-hidden">
          {pipelineView ? (
            // The data flow page (issue 436): the pipeline's details are on the overview.
            <div className="h-full overflow-auto p-6" style={rfStyle} data-data-flow-page={pipelineView.key}>
              <PipelineDataFlow flow={pipelineView.dataFlow} onOpenFile={onOpenFile} resolveName={resolveName} />
            </div>
          ) : atOverview ? (
            <BundleOverview
              overview={bundleOverview}
              background={rfStyle}
              selectedId={overviewSelectedId}
              onSelect={handleOverviewSelect}
              onOpen={openFromOverview}
              onOpenFile={onOpenFile}
              find={searchValue}
              problemsOnly={graphMode === "issues"}
              onShowAll={() => handleGraphModeChange("all")}
              scrollMemoryRef={overviewScroll}
              openedGroups={overviewOpenedGroups}
              onOpenGroup={(id) => setOverviewOpenedGroups((current) => new Set(current).add(id))}
              pipelines={pipelineModels}
              resolveName={resolveName}
            />
          ) : flowNodes.length === 0 ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-2 text-center"
              style={rfStyle}
            >
              <span className="text-sm text-muted">
                {jobNode
                  ? "This job has no tasks."
                  : jobKeys.length === 0
                    ? "No jobs or pipelines found in this bundle."
                    : "No tasks found for the selected job."}
              </span>
              {jobKeys.length === 0 && (
                <span className="text-xs text-muted">
                  {nonJobResourceTypes.length > 0
                    ? `Contains: ${nonJobResourceTypes.join(", ")}.`
                    : "The graph shows jobs and pipelines; this bundle defines neither."}
                </span>
              )}
            </div>
          ) : (
            <ReactFlow
              nodes={displayFlowNodes}
              edges={displayFlowEdges}
              nodeTypes={nodeTypes}
              colorMode={colorMode}
              className="bundle-flow"
              onNodeClick={handleNodeClick}
              onPaneClick={clearSelectedTask}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesReconnectable={false}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              proOptions={{ hideAttribution: true }}
              style={rfStyle}
            >
              <FocusViewportSync
                focusRequest={focusRequest}
                flowNodes={flowNodes}
              />
              <Background color="transparent" bgColor={UI_COLOR.surface} gap={16} />
              <Controls
                position="bottom-left"
                showFitView={false}
                showInteractive={false}
              >
                <RecenterJobControl />
              </Controls>
              <MiniMap
                position="bottom-right"
                className="shadow-lg"
                style={{
                  backgroundColor: UI_COLOR.widget,
                  border: `1px solid ${UI_COLOR.line}`,
                  borderRadius: 8,
                  boxShadow: `0 10px 30px ${UI_COLOR.shadow}`,
                }}
                bgColor={UI_COLOR.widget}
                maskColor={`color-mix(in srgb, ${UI_COLOR.muted} 22%, transparent)`}
                nodeBorderRadius={4}
                nodeStrokeWidth={2}
                nodeStrokeColor={(node) =>
                  node.data?.problemTone === "error"
                    ? UI_COLOR.error
                    : node.data?.problemTone === "warning"
                      ? UI_COLOR.warning
                      : kindMeta(node.data?.kind).color
                }
                nodeColor={(node) =>
                  node.data?.problemTone === "error"
                    ? UI_COLOR.error
                    : node.data?.problemTone === "warning"
                      ? UI_COLOR.warning
                      : kindMeta(node.data?.kind).color
                }
                pannable
                zoomable
              />
            </ReactFlow>
          )}
        </div>

        {selectedNodeId && !pipelineView && (
          <DetailPanel
            nodeId={selectedNodeId}
            graph={graph}
            parsedBundle={effectiveResolutionBundle}
            targetName={effectiveTargetName}
            inspectorIssues={inspectorIssues}
            onSelectTask={selectTaskNode}
            pipelineKeys={pipelineKeys}
            onSelectPipeline={bundleOverview ? showPipelineOnOverview : undefined}
            onClose={clearSelectedTask}
            onOpenFile={onOpenFile}
          />
        )}
      </div>

    </div>
  );
}
