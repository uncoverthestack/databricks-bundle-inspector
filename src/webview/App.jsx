import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  ControlButton,
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
} from "@xyflow/react";
import { AlertTriangle, LocateFixed } from "lucide-react";
import AppHeader from "./components/AppHeader";
import HeaderChipPanel from "./components/HeaderChipPanel";
import NodeLegend from "./components/NodeLegend";
import TaskNode from "./components/TaskNode";
import { kindLabel, kindMeta } from "./lib/kindMeta";
import { resolveSelectedJobKey } from "./lib/jobSelection";
import "@xyflow/react/dist/style.css";

function isPipelineTask(task) {
  return task.kind === "pipeline" || task.taskData?.taskType === "pipeline";
}

const nodeTypes = { task: TaskNode };

// ── Layout constants ──────────────────────────────────────────

const NODE_W = 260;
const NODE_H = 48;
const LEVEL_GAP = 340;
const V_GAP = 76;
const START_X = 60;

function basename(value) {
  if (!value || typeof value !== "string") return "";
  return value.split("/").filter(Boolean).pop() ?? value;
}

function isRemotePath(path) {
  return (
    path?.startsWith("/Workspace/") ||
    path?.startsWith("dbfs:/") ||
    path?.startsWith("s3://") ||
    path?.startsWith("abfss://") ||
    path?.startsWith("gs://")
  );
}

function hasTemplate(path) {
  return (
    typeof path === "string" && (path.includes("${") || path.includes("{{"))
  );
}

function getFileStatus(ref) {
  if (hasTemplate(ref.path)) {
    return { key: "template", label: "TEMPLATE", color: "#fbbf24" };
  }
  if (isRemotePath(ref.path)) {
    return { key: "remote", label: "REMOTE", color: "#60a5fa" };
  }
  if (ref.resolvedPath && !ref.exists) {
    return { key: "missing", label: "MISSING", color: "#f87171" };
  }
  if (ref.exists) {
    return { key: "found", label: "FOUND", color: "#4ade80" };
  }
  return { key: "unknown", label: "UNKNOWN", color: "#a8a29e" };
}

function getDefinedVariableNames(parsedBundle) {
  return new Set(Object.keys(parsedBundle?.variables ?? {}));
}

function getTaskIssueCounts(taskNode, definedVariableNames) {
  const fileReferences = taskNode.taskData?.fileReferences ?? [];
  const variableReferences = taskNode.taskData?.variableReferences ?? [];
  const libraryReferences = taskNode.taskData?.libraryReferences ?? [];

  const missingFiles = fileReferences.filter(
    (ref) => getFileStatus(ref).key === "missing",
  ).length;
  const missingLibraries = libraryReferences.filter(
    (ref) => ref.isLocal && ref.exists === false,
  ).length;
  const unresolvedVariables = new Set(
    variableReferences
      .map((ref) => ref.variableName)
      .filter((name) => !definedVariableNames.has(name)),
  ).size;

  return {
    missingFiles,
    missingLibraries,
    unresolvedVariables,
    total: missingFiles + missingLibraries + unresolvedVariables,
  };
}

function getTaskPath(taskNode, parentJob) {
  return [parentJob?.displayName, taskNode.displayName].filter(Boolean);
}

function getValidationDiagnosticCount(validationIssues) {
  return (validationIssues ?? []).reduce(
    (count, issue) => count + (issue.diagnostics?.length ?? 0),
    0,
  );
}

function compactTaskName(name) {
  if (name.length <= 26) return name;
  return `${name.slice(0, 24)}...`;
}

function buildTaskAdjacency(edges, taskIds) {
  const upstream = new Map();
  const downstream = new Map();
  for (const id of taskIds) {
    upstream.set(id, new Set());
    downstream.set(id, new Set());
  }
  for (const edge of edges) {
    if (edge.kind !== "depends_on") continue;
    if (!taskIds.has(edge.source) || !taskIds.has(edge.target)) continue;
    upstream.get(edge.target)?.add(edge.source);
    downstream.get(edge.source)?.add(edge.target);
  }
  return { upstream, downstream };
}

function collectReachable(startId, adjacency) {
  const result = new Set();
  const stack = [...(adjacency.get(startId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || result.has(id)) continue;
    result.add(id);
    stack.push(...(adjacency.get(id) ?? []));
  }
  return result;
}

function getCurrentJobTaskNodes(graph, jobNode) {
  if (!graph || !jobNode) return [];
  return graph.nodes.filter(
    (node) => node.nodeType === "task" && node.parentId === jobNode.id,
  );
}

function getOverviewStats(graph, jobNode, definedVariableNames) {
  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  const fileKeys = new Set();
  const variableKeys = new Set();
  const secretKeys = new Set();
  const computeKeys = new Set();
  const pipelineTaskCount = tasks.filter(isPipelineTask).length;

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const taskIds = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    for (const ref of task.taskData?.fileReferences ?? []) {
      fileKeys.add(ref.resolvedPath ?? ref.path);
    }
    for (const ref of task.taskData?.variableReferences ?? []) {
      variableKeys.add(ref.variableName);
    }
  }

  for (const edge of graph.edges) {
    if (!taskIds.has(edge.source)) continue;
    const target = nodeById.get(edge.target);
    if (target?.nodeType === "cluster" || target?.nodeType === "warehouse") {
      computeKeys.add(target.id);
    }
    if (target?.nodeType === "file") {
      for (const fileEdge of graph.edges) {
        if (fileEdge.source !== target.id) continue;
        const fileTarget = nodeById.get(fileEdge.target);
        if (fileTarget?.nodeType === "secret_scope") {
          secretKeys.add(fileTarget.id);
        }
      }
    }
  }

  const issueCounts = tasks.reduce(
    (acc, task) => {
      const counts = getTaskIssueCounts(task, definedVariableNames);
      acc.missingFiles += counts.missingFiles;
      acc.missingLibraries += counts.missingLibraries;
      acc.unresolvedVariables += counts.unresolvedVariables;
      acc.total += counts.total;
      return acc;
    },
    { missingFiles: 0, missingLibraries: 0, unresolvedVariables: 0, total: 0 },
  );

  return {
    tasks: tasks.length,
    files: fileKeys.size,
    variables: variableKeys.size,
    secrets: secretKeys.size,
    compute: computeKeys.size,
    pipelines: pipelineTaskCount,
    issues: issueCounts,
  };
}

function buildIssueItems(
  graph,
  jobNode,
  definedVariableNames,
  validationIssues,
  inspectorIssues = [],
) {
  const jobTaskIds = new Set(
    getCurrentJobTaskNodes(graph, jobNode).map((task) => task.id),
  );
  if (inspectorIssues.length > 0) {
    return inspectorIssues
      .filter((issue) => !issue.taskId || jobTaskIds.has(issue.taskId))
      .map((issue) => ({
        id: issue.id,
        group:
          {
            missing_file: "Missing Files",
            missing_library: "Missing Libraries",
            unresolved_variable: "Unresolved Variables",
            validation_diagnostic: "Validation Diagnostics",
            unknown_or_deprecated_field: "Unknown or Deprecated Fields",
            unknown_task_type: "Unknown or Deprecated Task Types",
          }[issue.kind] ?? "Issues",
        title: issue.detail ?? issue.title,
        subtitle: issue.taskName ?? issue.title,
        taskId: issue.taskId,
        severity: issue.severity,
        kind: "file",
        file: issue.file,
        line: issue.line,
        column: issue.column,
        fixHint: issue.fixHint,
      }));
  }

  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  const items = [];

  for (const task of tasks) {
    for (const ref of task.taskData?.fileReferences ?? []) {
      const status = getFileStatus(ref);
      if (status.key !== "missing") continue;
      items.push({
        id: `missing-file:${task.id}:${ref.yamlPath}:${ref.path}`,
        group: "Missing Files",
        title: ref.path,
        subtitle: task.displayName,
        taskId: task.id,
        severity: "error",
      });
    }

    for (const ref of task.taskData?.libraryReferences ?? []) {
      if (!ref.isLocal || ref.exists !== false) continue;
      items.push({
        id: `missing-library:${task.id}:${ref.yamlPath}:${ref.identifier}`,
        group: "Missing Libraries",
        title: ref.identifier,
        subtitle: task.displayName,
        taskId: task.id,
        severity: "error",
      });
    }

    for (const ref of task.taskData?.variableReferences ?? []) {
      if (definedVariableNames.has(ref.variableName)) continue;
      items.push({
        id: `unresolved-var:${task.id}:${ref.yamlPath}:${ref.variableName}`,
        group: "Unresolved Variables",
        title: ref.variableName,
        subtitle: task.displayName,
        taskId: task.id,
        severity: "error",
      });
    }
  }

  for (const [issueIndex, issue] of (validationIssues ?? []).entries()) {
    for (const [diagnosticIndex, diagnostic] of (
      issue.diagnostics ?? []
    ).entries()) {
      items.push({
        id: `validation:${issueIndex}:${diagnosticIndex}`,
        group: "Validation Diagnostics",
        title: diagnostic.message ?? issue.message ?? "Validation diagnostic",
        subtitle: diagnostic.path
          ? `${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ""}`
          : issue.message,
        severity: diagnostic.severity ?? "warning",
      });
    }
  }

  return items;
}

function buildStatPanelItems(
  graph,
  jobNode,
  definedVariableNames,
  validationIssues,
  inspectorIssues,
) {
  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const files = new Map();
  const pipelines = new Map();
  const variables = new Map();
  const secrets = new Map();
  const compute = new Map();

  function addTaskToMap(map, key, base, taskId) {
    const item = map.get(key) ?? { ...base, taskIds: new Set() };
    item.taskIds.add(taskId);
    map.set(key, item);
  }

  for (const task of tasks) {
    if (isPipelineTask(task)) {
      addTaskToMap(
        pipelines,
        task.subtitle ?? task.displayName,
        {
          title: task.subtitle ?? task.displayName,
          kind: "pipeline",
          taskTypeLabel: task.taskTypeLabel,
        },
        task.id,
      );
    }

    for (const ref of task.taskData?.fileReferences ?? []) {
      const status = getFileStatus(ref);
      const key = ref.resolvedPath ?? ref.path;
      const existing = files.get(key);
      const statusToKeep =
        existing?.status?.key === "missing" ? existing.status : status;
      addTaskToMap(
        files,
        key,
        {
          title: basename(ref.path) || ref.path,
          detail: ref.path,
          kind: "file",
          status: statusToKeep,
        },
        task.id,
      );
      files.get(key).status = statusToKeep;
    }

    for (const ref of task.taskData?.variableReferences ?? []) {
      const unresolved = !definedVariableNames.has(ref.variableName);
      addTaskToMap(
        variables,
        ref.variableName,
        {
          title: ref.variableName,
          kind: "variable",
          unresolved,
        },
        task.id,
      );
      variables.get(ref.variableName).unresolved ||= unresolved;
    }
  }

  for (const variableName of definedVariableNames) {
    if (variables.has(variableName)) continue;
    variables.set(variableName, {
      title: variableName,
      kind: "variable",
      taskIds: new Set(),
      unusedInJob: true,
    });
  }

  for (const edge of graph.edges) {
    if (!taskIds.has(edge.source)) continue;
    const task = taskById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!task || !target) continue;

    if (target.nodeType === "cluster" || target.nodeType === "warehouse") {
      addTaskToMap(
        compute,
        target.id,
        {
          title: target.displayName,
          kind: target.kind,
          computeType: target.nodeType,
        },
        task.id,
      );
    }

    if (target.nodeType === "file") {
      for (const fileEdge of graph.edges) {
        if (fileEdge.source !== target.id) continue;
        const fileTarget = nodeById.get(fileEdge.target);
        if (fileTarget?.nodeType !== "secret_scope") continue;
        addTaskToMap(
          secrets,
          fileTarget.id,
          {
            title: fileTarget.displayName,
            kind: "secret_scope",
            detail: target.displayName,
          },
          task.id,
        );
      }
    }
  }

  function fromMap(map, group, subtitleFor) {
    return [...map.values()]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((item) => {
        const taskList = [...item.taskIds];
        const taskCountLabel = `${taskList.length} ${taskList.length === 1 ? "task" : "tasks"}`;
        return {
          id: `${group}:${item.title}`,
          group: item.unusedInJob ? "Defined, Not Used By This Job" : group,
          title: item.title,
          subtitle: subtitleFor(item, taskCountLabel),
          taskId: item.unusedInJob ? undefined : taskList[0],
          kind: item.kind,
          severity:
            item.status?.key === "missing" || item.unresolved
              ? "error"
              : undefined,
        };
      });
  }

  return {
    tasks: tasks
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((task) => ({
        id: `task:${task.id}`,
        group: "Tasks",
        title: task.displayName,
        subtitle: task.taskTypeLabel ?? "Task",
        taskId: task.id,
        kind: task.kind,
        severity:
          getTaskIssueCounts(task, definedVariableNames).total > 0
            ? "error"
            : undefined,
      })),
    files: fromMap(
      files,
      "Files",
      (item, taskCountLabel) =>
        `${item.status?.label ?? "FILE"} · ${taskCountLabel}`,
    ),
    pipelines: fromMap(
      pipelines,
      "Pipelines",
      (item, taskCountLabel) =>
        `${item.taskTypeLabel ?? "Pipeline"} · ${taskCountLabel}`,
    ),
    variables: fromMap(variables, "Variables", (item, taskCountLabel) =>
      item.unusedInJob
        ? "Not used by this job"
        : `${item.unresolved ? "UNRESOLVED" : "BUNDLE"} · ${taskCountLabel}`,
    ),
    secrets: fromMap(
      secrets,
      "Secret Scopes",
      (_item, taskCountLabel) => taskCountLabel,
    ),
    compute: fromMap(
      compute,
      "Compute",
      (item, taskCountLabel) =>
        `${item.computeType ?? "compute"} · ${taskCountLabel}`,
    ),
    issues: buildIssueItems(
      graph,
      jobNode,
      definedVariableNames,
      validationIssues,
      inspectorIssues,
    ),
  };
}

function buildSearchItems(graph, jobNode, definedVariableNames) {
  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  return tasks.map((task) => {
    const issues = getTaskIssueCounts(task, definedVariableNames);
    return {
      id: `task:${task.id}`,
      label: task.displayName,
      subtitle: task.taskTypeLabel ?? "Task",
      kind: task.kind,
      taskId: task.id,
      issueCount: issues.total,
    };
  });
}

// ── DAG layout: left → right ──────────────────────────────────

function buildDagFlow(graph, selectedJobKey, definedVariableNames) {
  const empty = { flowNodes: [], flowEdges: [], jobNode: null, taskCount: 0 };

  const jobNode = graph.nodes.find(
    (n) =>
      n.nodeType === "job" &&
      (!selectedJobKey || n.resourceKey === selectedJobKey),
  );
  if (!jobNode) return empty;

  const allTasks = graph.nodes.filter(
    (n) => n.nodeType === "task" && n.parentId === jobNode.id,
  );
  if (allTasks.length === 0) return { ...empty, jobNode };

  const depEdges = graph.edges.filter(
    (e) => e.kind === "depends_on" && allTasks.some((t) => t.id === e.target),
  );

  // Topological level = max distance from any root
  const levelCache = new Map();
  function level(id, visiting = new Set()) {
    if (levelCache.has(id)) return levelCache.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const inc = depEdges.filter((e) => e.target === id);
    const lv =
      inc.length === 0
        ? 0
        : Math.max(...inc.map((e) => level(e.source, visiting))) + 1;
    levelCache.set(id, lv);
    return lv;
  }
  allTasks.forEach((t) => level(t.id));

  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const taskIds = new Set(allTasks.map((task) => task.id));
  const incomingByTask = new Map(allTasks.map((task) => [task.id, []]));
  for (const edge of depEdges) {
    if (!taskIds.has(edge.source) || !taskIds.has(edge.target)) continue;
    incomingByTask.get(edge.target)?.push(edge.source);
  }

  // Group by level, sort within level alphabetically.
  const byLevel = new Map();
  allTasks.forEach((t) => {
    const lv = levelCache.get(t.id) ?? 0;
    const arr = byLevel.get(lv) ?? [];
    arr.push(t);
    byLevel.set(lv, arr);
  });
  byLevel.forEach((arr) =>
    arr.sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  const rowByTask = new Map();
  const occupiedRowsByLevel = new Map();

  function isRowAvailable(levelIndex, row) {
    return !(occupiedRowsByLevel.get(levelIndex) ?? new Set()).has(row);
  }

  function claimNearestRow(levelIndex, preferredRow) {
    const occupied = occupiedRowsByLevel.get(levelIndex) ?? new Set();
    let offset = 0;
    while (true) {
      const candidates =
        offset === 0
          ? [preferredRow]
          : [preferredRow + offset, preferredRow - offset];
      for (const candidate of candidates) {
        if (candidate < 0) continue;
        if (!occupied.has(candidate)) {
          occupied.add(candidate);
          occupiedRowsByLevel.set(levelIndex, occupied);
          return candidate;
        }
      }
      offset += 1;
    }
  }

  const levelIndexes = [...byLevel.keys()].sort((a, b) => a - b);
  let nextRootRow = 0;
  for (const levelIndex of levelIndexes) {
    for (const task of byLevel.get(levelIndex) ?? []) {
      const incomingRows = (incomingByTask.get(task.id) ?? [])
        .map((id) => rowByTask.get(id))
        .filter((row) => typeof row === "number")
        .sort((a, b) => a - b);

      let preferredRow;
      if (incomingRows.length === 1) {
        preferredRow = incomingRows[0];
      } else if (incomingRows.length > 1) {
        preferredRow = incomingRows[Math.floor(incomingRows.length / 2)];
      } else {
        while (!isRowAvailable(levelIndex, nextRootRow)) nextRootRow += 1;
        preferredRow = nextRootRow;
        nextRootRow += 1;
      }

      rowByTask.set(task.id, claimNearestRow(levelIndex, preferredRow ?? 0));
    }
  }

  const maxRow = Math.max(...rowByTask.values(), 0);
  const canvasH = (maxRow + 1) * V_GAP;

  const flowNodes = [];
  const flowEdges = [];

  byLevel.forEach((tasks, lv) => {
    const x = START_X + lv * LEVEL_GAP;

    tasks.forEach((task) => {
      const row = rowByTask.get(task.id) ?? 0;
      flowNodes.push({
        id: task.id,
        type: "task",
        position: { x, y: (canvasH - NODE_H) / 2 + (row - maxRow / 2) * V_GAP },
        width: NODE_W,
        height: NODE_H,
        initialWidth: NODE_W,
        initialHeight: NODE_H,
        data: {
          name: compactTaskName(task.displayName),
          fullName: task.displayName,
          kind: task.kind,
          subtitle: task.subtitle,
          hasMissingFile: task.hasMissingFile,
          issueCounts: getTaskIssueCounts(task, definedVariableNames),
        },
      });
    });
  });

  depEdges.forEach((e) => {
    if (!taskById.has(e.source)) return;
    flowEdges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "straight",
      style: {
        stroke: "rgba(120,113,108,0.45)",
        strokeWidth: 1.5,
        strokeDasharray: "4 3",
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 12,
        height: 12,
        color: "rgba(120,113,108,0.45)",
      },
    });
  });

  return { flowNodes, flowEdges, jobNode, taskCount: allTasks.length };
}

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

function ConfigRow({ label, value, title, tone = "default", onClick }) {
  if (!value) return null;
  const clickable = Boolean(onClick);
  const valueClass =
    tone === "danger"
      ? "text-red-300"
      : clickable
        ? "text-blue-400 underline underline-offset-2 decoration-blue-400/40 group-hover:text-blue-300"
        : "text-stone-200";
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => e.key === "Enter" && onClick() : undefined}
      className={[
        "group flex items-baseline gap-3 border-b border-stone-800/40 py-2 last:border-0",
        clickable
          ? "cursor-pointer rounded-lg px-2 -mx-2 outline-none hover:bg-stone-800/30 focus:bg-stone-800/30 focus:ring-1 focus:ring-blue-500/40"
          : "",
      ].join(" ")}
    >
      <span className="w-20 shrink-0 text-xs text-stone-500">{label}</span>
      <span
        title={title}
        className={["break-all text-xs leading-relaxed", valueClass].join(" ")}
      >
        {value}
        {clickable && <span className="ml-1 text-[10px] no-underline">↗</span>}
      </span>
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

  const taskTypeLabel = node.taskTypeLabel ?? "";
  if (taskTypeLabel.includes("Spark Submit")) return "Parameters";
  if (taskTypeLabel.includes("SQL Alert")) return "Alert";
  if (taskTypeLabel.includes("Power BI")) return "Dashboard";
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

function RefItem({
  name,
  detail,
  kind,
  edgeKind,
  resolvedPath,
  missing,
  status,
  line,
  onOpenFile,
}) {
  const { color } = kindMeta(kind);
  const clickable = Boolean(resolvedPath && onOpenFile && !missing);
  const dotColor = status?.color ?? (missing ? "#f87171" : color);
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
        "flex items-center justify-between border-b border-stone-800/40 px-3 py-2 last:border-0",
        clickable ? "cursor-pointer hover:bg-stone-800/40" : "",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
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
                ? "text-red-400"
                : clickable
                  ? "text-blue-400 underline underline-offset-2 decoration-blue-400/40"
                  : "text-stone-200",
            ].join(" ")}
          >
            {name}
            {missing && <span className="ml-1 text-[10px]">⚠</span>}
            {clickable && (
              <span className="ml-1 text-[10px] no-underline">↗</span>
            )}
          </span>
          {detail && detail !== name && (
            <span className="mt-0.5 block truncate text-[11px] text-stone-600">
              {detail}
            </span>
          )}
        </span>
      </div>
      <span className="ml-3 shrink-0 text-[10px] font-semibold tracking-widest text-stone-500">
        {line ? `L${line}` : (status?.label ?? edgeKind)}
      </span>
    </div>
  );
}

function RefSection({ title, items, onOpenFile }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
        {title} · {items.length}
      </div>
      <div className="overflow-hidden rounded-xl border border-stone-800">
        {items.map((item, i) => (
          <RefItem key={i} {...item} onOpenFile={onOpenFile} />
        ))}
      </div>
    </section>
  );
}

function ComputeSection({ items }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
        Compute
      </div>
      <div className="rounded-xl border border-stone-800 px-3">
        {items.map((item, i) => (
          <div
            key={i}
            className="flex items-baseline gap-3 border-b border-stone-800/40 py-2 last:border-0"
          >
            <span className="w-20 shrink-0 text-xs text-stone-500">
              Runs on
            </span>
            <span className="text-xs text-stone-200">{item.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function VariablesSection({ items }) {
  if (!items?.length) return null;
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
        Variables · {items.length}
      </div>
      <div className="overflow-hidden rounded-xl border border-stone-800">
        {items.map((item, i) => {
          const color = item.unresolved
            ? "#f87171"
            : kindMeta("variable").color;
          return (
            <div
              key={i}
              className="flex items-center justify-between gap-2 border-b border-stone-800/40 px-3 py-2 last:border-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span
                  title={item.expression}
                  className={[
                    "truncate text-xs",
                    item.unresolved ? "text-red-300" : "text-stone-200",
                  ].join(" ")}
                >
                  {item.name}
                </span>
              </div>
              <span className="shrink-0 text-[10px] font-semibold tracking-widest text-stone-500">
                {item.unresolved ? "UNRESOLVED" : "BUNDLE"}
              </span>
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
  blockers,
  dependents,
  onSelectTask,
}) {
  return (
    <section>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
        Impact
      </div>
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-stone-800">
        <div className="border-r border-stone-800/60 px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.16em] text-stone-500">
            Upstream
          </div>
          <div className="mt-1 text-lg font-semibold text-stone-100">
            {upstreamCount}
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.16em] text-stone-500">
            Downstream
          </div>
          <div className="mt-1 text-lg font-semibold text-stone-100">
            {downstreamCount}
          </div>
        </div>
      </div>
      {(blockers.length > 0 || dependents.length > 0) && (
        <div className="mt-2 space-y-2">
          {blockers.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-600">
                Direct Blockers
              </div>
              <div className="flex flex-wrap gap-1.5">
                {blockers.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelectTask?.(task.id)}
                    className="rounded-md border border-stone-800 bg-stone-900/70 px-2 py-0.5 text-[11px] text-blue-300 outline-none hover:bg-stone-800 focus:ring-1 focus:ring-blue-500/40"
                    title={task.displayName}
                  >
                    {compactTaskName(task.displayName)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {dependents.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-600">
                Direct Dependents
              </div>
              <div className="flex flex-wrap gap-1.5">
                {dependents.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelectTask?.(task.id)}
                    className="rounded-md border border-stone-800 bg-stone-900/70 px-2 py-0.5 text-[11px] text-blue-300 outline-none hover:bg-stone-800 focus:ring-1 focus:ring-blue-500/40"
                    title={task.displayName}
                  >
                    {compactTaskName(task.displayName)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Breadcrumb({ items }) {
  if (!items.length) return null;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-stone-500">
      {items.map((item, index) => (
        <span
          key={`${item}-${index}`}
          className="flex min-w-0 items-center gap-1"
        >
          {index > 0 && <span className="shrink-0 text-stone-700">/</span>}
          <span className="max-w-32 truncate" title={item}>
            {item}
          </span>
        </span>
      ))}
    </div>
  );
}

function TaskStatusChips({ node, taskIssues, computeItems, fileItems }) {
  const chips = [
    node.taskTypeLabel,
    taskIssues.total > 0
      ? `${taskIssues.total} issue${taskIssues.total === 1 ? "" : "s"}`
      : "No issues",
    computeItems[0]?.name,
    fileItems.length > 0
      ? `${fileItems.length} file${fileItems.length === 1 ? "" : "s"}`
      : undefined,
  ].filter(Boolean);

  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip}
          className={[
            "rounded-md border px-2 py-0.5 text-[11px]",
            String(chip).includes("issue")
              ? taskIssues.total > 0
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-stone-800 bg-stone-900/70 text-stone-400"
              : "border-stone-800 bg-stone-900/70 text-stone-300",
          ].join(" ")}
        >
          {chip}
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
  definedVariableNames,
  onSelectTask,
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
  const taskIssues = getTaskIssueCounts(node, definedVariableNames);
  const breadcrumbItems = getTaskPath(node, parentJob);
  const sourceFile = node.taskData?.sourceFile;
  const artifactLabels = taskArtifactLabels(node.taskData?.taskType);

  // Tasks this task depends on (prereqs shown in the config row)
  const dependencyItems = graph.edges
    .filter((e) => e.kind === "depends_on" && e.target === nodeId)
    .map((e) => nodeById.get(e.source))
    .filter((dependency) => dependency?.nodeType === "task");
  const dependsOnNames =
    dependencyItems.map((dependency) => dependency.displayName).join(", ") ||
    undefined;
  const dependentItems = graph.edges
    .filter((e) => e.kind === "depends_on" && e.source === nodeId)
    .map((e) => nodeById.get(e.target))
    .filter((dependent) => dependent?.nodeType === "task");
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
  const primaryFileNode = graph.edges
    .filter((e) => e.source === nodeId && e.kind === "references")
    .map((e) => nodeById.get(e.target))
    .find((n) => n?.nodeType === "file");
  const primaryFileRef = (node.taskData?.fileReferences ?? [])[0];
  const primaryFileStatus = primaryFileRef
    ? getFileStatus(primaryFileRef)
    : undefined;
  const targetRows = getTaskTargetRows(node, primaryFileRef, primaryFileStatus);

  // Compute nodes (cluster / warehouse)
  const computeItems = graph.edges
    .filter((e) => e.source === nodeId && e.kind === "uses")
    .map((e) => nodeById.get(e.target))
    .filter(
      (n) => n && (n.nodeType === "cluster" || n.nodeType === "warehouse"),
    )
    .map((n) => ({
      name: n.displayName,
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
      detail: ref.path,
      kind: "file",
      edgeKind: ref.referenceType,
      resolvedPath,
      missing: status.key === "missing",
      status,
    };
  });

  const variableItems = [
    ...new Map(
      (node.taskData?.variableReferences ?? []).map((ref) => [
        ref.variableName,
        {
          name: ref.variableName,
          expression: ref.expression,
          unresolved: !definedVariableNames.has(ref.variableName),
        },
      ]),
    ).values(),
  ];

  // Secrets discovered in the task's referenced file — clickable, jumps to detected line
  const secretItems = primaryFileNode
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

  // Parameters/widgets discovered in the task's referenced file — clickable, jumps to detected line
  const widgetItems = primaryFileNode
    ? graph.edges
        .filter((e) => e.source === primaryFileNode.id && e.kind === "uses")
        .map((e) => {
          const n = nodeById.get(e.target);
          if (!n || n.nodeType !== "widget") return null;
          return {
            name: n.displayName,
            kind: "widget",
            resolvedPath: primaryFileNode.data?.resolvedPath ?? null,
            line: e.data?.line ?? null,
          };
        })
        .filter(Boolean)
    : [];

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
      className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-stone-800"
      style={{ backgroundColor: "#0d0d0d" }}
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-stone-800 px-5 pb-4 pt-5">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
            Task
          </div>
          <div className="truncate text-[17px] font-semibold leading-tight text-stone-50">
            {node.displayName}
          </div>
          <Breadcrumb items={breadcrumbItems} />
          <TaskStatusChips
            node={node}
            taskIssues={taskIssues}
            computeItems={computeItems}
            fileItems={fileItems}
          />
        </div>
        <button
          onClick={onClose}
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-xs text-stone-500 transition hover:bg-stone-800 hover:text-stone-300"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-5 overflow-auto p-5">
        {/* Task Configuration */}
        <section>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
            Task Configuration
          </div>
          <div className="rounded-xl border border-stone-800 px-3">
            <ConfigRow label="Parent job" value={parentJob?.displayName} />
            <ConfigRow label="Kind" value={node.taskTypeLabel} />
            <ConfigRow
              label="Source"
              value={sourceFile ? basename(sourceFile) : undefined}
              title={sourceFile}
              onClick={
                sourceFile && onOpenFile
                  ? () => onOpenFile(sourceFile)
                  : undefined
              }
            />
            {targetRows.map((row) => (
              <ConfigRow
                key={row.key}
                label={row.label}
                value={row.value}
                title={row.title}
                tone={row.tone}
                onClick={
                  row.resolvedPath && onOpenFile
                    ? () => onOpenFile(row.resolvedPath)
                    : undefined
                }
              />
            ))}
            <ConfigRow
              label="Depends on"
              value={dependsOnNames}
              onClick={
                dependencyItems.length === 1 && onSelectTask
                  ? () => onSelectTask(dependencyItems[0].id)
                  : undefined
              }
            />
          </div>
          {dependencyItems.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {dependencyItems.map((dependency) => (
                <button
                  key={dependency.id}
                  type="button"
                  onClick={() => onSelectTask?.(dependency.id)}
                  className="rounded-md border border-stone-800 bg-stone-900/70 px-2 py-0.5 text-[11px] text-blue-300 outline-none hover:bg-stone-800 focus:ring-1 focus:ring-blue-500/40"
                  title={dependency.displayName}
                >
                  {compactTaskName(dependency.displayName)}
                </button>
              ))}
            </div>
          )}
        </section>

        <TaskImpactSection
          upstreamCount={upstreamImpactCount}
          downstreamCount={downstreamImpactCount}
          blockers={dependencyItems}
          dependents={dependentItems}
          onSelectTask={onSelectTask}
        />

        {/* Parameters */}
        {node.parameters?.length ? (
          <section>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-500">
              Parameters
            </div>
            <div className="rounded-xl border border-stone-800 px-3">
              {node.parameters.map((p, i) => (
                <ConfigRow key={i} label={p.name} value={p.value} />
              ))}
            </div>
          </section>
        ) : null}

        {taskIssues.total > 0 && (
          <div className="space-y-1.5 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5">
            {taskIssues.missingFiles > 0 && (
              <div className="flex items-center gap-2 text-xs text-red-300">
                <AlertTriangle size={13} />
                <span>{taskIssues.missingFiles} missing file reference</span>
              </div>
            )}
            {taskIssues.unresolvedVariables > 0 && (
              <div className="flex items-center gap-2 text-xs text-red-300">
                <AlertTriangle size={13} />
                <span>
                  {taskIssues.unresolvedVariables} unresolved variable
                </span>
              </div>
            )}
            {taskIssues.missingLibraries > 0 && (
              <div className="flex items-center gap-2 text-xs text-red-300">
                <AlertTriangle size={13} />
                <span>{taskIssues.missingLibraries} missing local library</span>
              </div>
            )}
          </div>
        )}

        <ComputeSection items={computeItems} />
        <VariablesSection items={variableItems} />
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

// ── App ───────────────────────────────────────────────────────

export default function App({
  parsedBundle,
  graph,
  validationIssues = [],
  inspectorIssues = [],
  inspectedTarget,
  inspectedTargetMode,
  requestedTarget,
  targetFallbackMessage,
  focusIssuesNonce,
  onSelectTarget,
  onOpenFile,
}) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [userSelectedJobKey, setUserSelectedJobKey] = useState(undefined);
  const [searchValue, setSearchValue] = useState("");
  const [focusRequest, setFocusRequest] = useState(null);
  const [activeHeaderPanel, setActiveHeaderPanel] = useState(() =>
    focusIssuesNonce ? "issues" : null,
  );
  const [graphMode, setGraphMode] = useState(() =>
    focusIssuesNonce ? "issues" : "all",
  );

  const definedVariableNames = useMemo(
    () => getDefinedVariableNames(parsedBundle),
    [parsedBundle],
  );
  const validationDiagnosticCount = useMemo(
    () => getValidationDiagnosticCount(validationIssues),
    [validationIssues],
  );

  const jobsByKey = useMemo(
    () => parsedBundle?.resources?.jobs ?? parsedBundle?.resources?.job ?? {},
    [parsedBundle],
  );
  const jobKeys = useMemo(() => Object.keys(jobsByKey), [jobsByKey]);

  const selectedJobKey = useMemo(
    () => resolveSelectedJobKey(jobKeys, userSelectedJobKey),
    [jobKeys, userSelectedJobKey],
  );

  const jobOptions = useMemo(
    () =>
      jobKeys.map((key) => {
        const name = jobsByKey[key]?.name;
        return {
          value: key,
          label:
            typeof name === "string" && name.trim() ? `${key} — ${name}` : key,
        };
      }),
    [jobKeys, jobsByKey],
  );
  const targetOptions = useMemo(
    () => Object.keys(parsedBundle?.targets ?? {}),
    [parsedBundle],
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
      : inspectedTarget
        ? `Inspected target: ${inspectedTarget}`
        : "No explicit Databricks target was reported by the bundle output.";

  const { flowNodes, flowEdges, jobNode } = useMemo(
    () =>
      graph
        ? buildDagFlow(graph, selectedJobKey, definedVariableNames)
        : { flowNodes: [], flowEdges: [], jobNode: null },
    [graph, selectedJobKey, definedVariableNames],
  );

  const overviewStats = useMemo(
    () =>
      graph && jobNode
        ? getOverviewStats(graph, jobNode, definedVariableNames)
        : null,
    [graph, jobNode, definedVariableNames],
  );

  const searchItems = useMemo(
    () =>
      graph && jobNode
        ? buildSearchItems(graph, jobNode, definedVariableNames)
        : [],
    [graph, jobNode, definedVariableNames],
  );

  const headerPanelItems = useMemo(
    () =>
      graph && jobNode
        ? buildStatPanelItems(
            graph,
            jobNode,
            definedVariableNames,
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
            issues: [],
          },
    [graph, jobNode, definedVariableNames, validationIssues, inspectorIssues],
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
  const visibleIssueCount =
    inspectorIssues.length > 0
      ? activeHeaderPanelItems.length && activeHeaderPanel === "issues"
        ? activeHeaderPanelItems.length
        : headerPanelItems.issues.length
      : (overviewStats?.issues.total ?? 0) + validationDiagnosticCount;

  const effectiveGraphMode =
    !selectedNodeId && (graphMode === "upstream" || graphMode === "downstream")
      ? "all"
      : graphMode;

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
    if (flowNodes.length === 0) return null;
    const taskIds = new Set(flowNodes.map((node) => node.id));
    const { upstream, downstream } = buildTaskAdjacency(flowEdges, taskIds);

    if (effectiveGraphMode === "issues") {
      if (issueTaskIds.size === 0) return null;
      const context = new Set(issueTaskIds);
      for (const issueTaskId of issueTaskIds) {
        for (const id of upstream.get(issueTaskId) ?? []) context.add(id);
        for (const id of downstream.get(issueTaskId) ?? []) context.add(id);
      }
      return context;
    }

    if (!selectedNodeId) return null;

    if (effectiveGraphMode === "upstream") {
      return new Set([
        selectedNodeId,
        ...collectReachable(selectedNodeId, upstream),
      ]);
    }

    if (effectiveGraphMode === "downstream") {
      return new Set([
        selectedNodeId,
        ...collectReachable(selectedNodeId, downstream),
      ]);
    }

    return new Set([
      selectedNodeId,
      ...collectReachable(selectedNodeId, upstream),
      ...collectReachable(selectedNodeId, downstream),
    ]);
  }, [selectedNodeId, flowNodes, flowEdges, effectiveGraphMode, issueTaskIds]);

  const displayFlowNodes = useMemo(
    () =>
      flowNodes.map((node) => {
        const selected = node.id === selectedNodeId;
        const related = focusedTaskIds?.has(node.id) ?? false;
        const issueMatched =
          effectiveGraphMode === "issues" && issueTaskIds.has(node.id);
        return {
          ...node,
          selected,
          data: {
            ...node.data,
            focusState: focusedTaskIds
              ? selected
                ? "selected"
                : issueMatched
                  ? "related"
                  : related
                    ? "related"
                    : "dimmed"
              : "normal",
          },
        };
      }),
    [
      flowNodes,
      focusedTaskIds,
      selectedNodeId,
      effectiveGraphMode,
      issueTaskIds,
    ],
  );

  const displayFlowEdges = useMemo(
    () =>
      flowEdges.map((edge) => {
        const highlighted =
          focusedTaskIds?.has(edge.source) && focusedTaskIds?.has(edge.target);
        const dimmed = focusedTaskIds && !highlighted;
        return {
          ...edge,
          animated: highlighted,
          style: {
            ...edge.style,
            opacity: dimmed ? 0.18 : 1,
            stroke: highlighted ? "#60a5fa" : edge.style?.stroke,
            strokeDasharray: highlighted
              ? undefined
              : edge.style?.strokeDasharray,
            strokeWidth: highlighted ? 2.4 : edge.style?.strokeWidth,
          },
          markerEnd: {
            ...edge.markerEnd,
            color: highlighted ? "#60a5fa" : edge.markerEnd?.color,
          },
        };
      }),
    [flowEdges, focusedTaskIds],
  );

  const legendItems = useMemo(() => {
    const taskKinds = [
      ...new Set(flowNodes.map((node) => node.data?.kind).filter(Boolean)),
    ].sort((a, b) => kindLabel(a).localeCompare(kindLabel(b)));

    const items = taskKinds.map((kind) => ({
      label: kindLabel(kind),
      kind,
    }));

    if (overviewStats?.compute > 0) {
      items.push({ label: "COMPUTE", kind: "cluster" });
    }
    if (overviewStats?.secrets > 0) {
      items.push({ label: "SECRET", kind: "secret_scope" });
    }
    if (overviewStats?.variables > 0) {
      items.push({ label: "VARIABLE", kind: "variable" });
    }

    return items.length > 0 ? items : [{ label: "TASK", kind: "job" }];
  }, [flowNodes, overviewStats]);

  const nonJobResourceTypes = useMemo(() => {
    if (!graph || jobKeys.length > 0) return [];
    const seen = new Set();
    graph.nodes
      .filter((n) => n.nodeType === "resource")
      .forEach((n) => seen.add(n.resourceGroup));
    return [...seen];
  }, [graph, jobKeys]);

  if (!graph) {
    return (
      <div
        className="flex h-screen items-center justify-center text-sm text-stone-400"
        style={{ backgroundColor: "#111" }}
      >
        Graph not available — close this panel and run{" "}
        <span
          className="mx-1 rounded px-1.5 py-0.5 font-mono text-stone-200"
          style={{ backgroundColor: "#1c1917" }}
        >
          Inspect Databricks Bundle
        </span>{" "}
        again.
      </div>
    );
  }

  const rfStyle = {
    backgroundColor: "#111111",
    backgroundImage:
      "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.04) 1px, transparent 0)",
    backgroundSize: "16px 16px",
  };

  function selectTaskNode(nodeId) {
    setSelectedNodeId(nodeId);
    setFocusRequest({ nodeId, nonce: Date.now() });
  }

  function selectPanelItem(item) {
    if (item.taskId) {
      selectTaskNode(item.taskId);
    }
    if (item.file && onOpenFile) {
      onOpenFile(item.file, item.line, item.column);
    }
    setActiveHeaderPanel(null);
  }

  function handleSearchSelect(item) {
    setSearchValue(item.label);
    selectTaskNode(item.taskId);
  }

  function handleJobChange(value) {
    setUserSelectedJobKey(value);
    setSelectedNodeId(null);
    setSearchValue("");
    setActiveHeaderPanel(null);
    setGraphMode("all");
  }

  function toggleHeaderPanel(panelName) {
    setActiveHeaderPanel((current) =>
      current === panelName ? null : panelName,
    );
  }

  return (
    <div
      className="relative flex h-screen flex-col"
      style={{ backgroundColor: "#111111" }}
    >
      <AppHeader
        bundleName={parsedBundle?.bundle?.name}
        targetLabel={targetLabel}
        targetTitle={targetTitle}
        targetMode={inspectedTargetMode}
        targetOptions={targetOptions}
        selectedTarget={requestedTarget}
        onTargetChange={onSelectTarget}
        jobKeys={jobKeys}
        selectedJobKey={selectedJobKey}
        jobOptions={jobOptions}
        onJobChange={handleJobChange}
        searchValue={searchValue}
        searchItems={searchItems}
        onSearchChange={setSearchValue}
        onSearchSelect={handleSearchSelect}
        graphMode={effectiveGraphMode}
        onGraphModeChange={setGraphMode}
        selectedNodeId={selectedNodeId}
        overviewStats={overviewStats}
        visibleIssueCount={visibleIssueCount}
        validationDiagnosticCount={validationDiagnosticCount}
        onTogglePanel={toggleHeaderPanel}
      />

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
          {flowNodes.length === 0 ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-2 text-center"
              style={rfStyle}
            >
              <span className="text-sm text-stone-500">
                {jobNode
                  ? "This job has no tasks."
                  : jobKeys.length === 0
                    ? "No jobs found in this bundle."
                    : "No tasks found for the selected job."}
              </span>
              {jobKeys.length === 0 && (
                <span className="text-xs text-stone-600">
                  {nonJobResourceTypes.length > 0
                    ? `Contains: ${nonJobResourceTypes.join(", ")}.`
                    : "This bundle may only contain pipelines or other non-job resources."}
                </span>
              )}
            </div>
          ) : (
            <ReactFlow
              nodes={displayFlowNodes}
              edges={displayFlowEdges}
              nodeTypes={nodeTypes}
              colorMode="dark"
              className="bundle-flow"
              onNodeClick={(_, node) =>
                selectedNodeId === node.id
                  ? setSelectedNodeId(null)
                  : selectTaskNode(node.id)
              }
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
              <Background color="rgba(255,255,255,0)" gap={16} />
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
                  backgroundColor: "#0f0f10",
                  border: "1px solid rgba(120,113,108,0.55)",
                  borderRadius: 8,
                  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                }}
                bgColor="#0f0f10"
                maskColor="rgba(120,113,108,0.22)"
                nodeBorderRadius={4}
                nodeStrokeWidth={2}
                nodeStrokeColor={(node) =>
                  node.data?.issueCounts?.total > 0
                    ? "#fecaca"
                    : kindMeta(node.data?.kind).color
                }
                nodeColor={(node) =>
                  node.data?.issueCounts?.total > 0
                    ? "#f87171"
                    : kindMeta(node.data?.kind).color
                }
                pannable
                zoomable
              />
            </ReactFlow>
          )}
        </div>

        {selectedNodeId && (
          <DetailPanel
            nodeId={selectedNodeId}
            graph={graph}
            definedVariableNames={definedVariableNames}
            onSelectTask={selectTaskNode}
            onClose={() => setSelectedNodeId(null)}
            onOpenFile={onOpenFile}
          />
        )}
      </div>

      <NodeLegend items={legendItems} />
    </div>
  );
}
