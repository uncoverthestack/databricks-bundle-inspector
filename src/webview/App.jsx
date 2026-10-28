import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ReactFlow,
  Background,
  ControlButton,
  Controls,
  MiniMap,
  MarkerType,
  useReactFlow,
} from "@xyflow/react";
import { AlertTriangle, Info, LocateFixed } from "lucide-react";
import AppHeader from "./components/AppHeader";
import HeaderChipPanel from "./components/HeaderChipPanel";
import PipelineView from "./components/PipelineView";
import TaskNode from "./components/TaskNode";
import {
  isVariableResolvedForTarget,
  resolveExpressionForTarget,
  resolveVariableForTarget,
} from "../bundle/targetResolution";
import { kindMeta } from "./lib/kindMeta";
import { parseSelectionValue, resolveSelection, selectionValue } from "./lib/jobSelection";
import { buildPipelineView, pipelineIssueCounts, pipelineKeysOf, pipelineReviewSummary, taskPipelineKey } from "./lib/pipelineView";
import { orderBySeverity, severityMeta } from "./lib/issueSeverity";
import { hasTextSelection } from "./lib/textSelection";
import { variableSourceLocation } from "./lib/variableSource";
import { UI_COLOR, colorModeForThemeKind, currentThemeKind } from "./lib/vscodeTheme";
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
    return {
      key: "template",
      label: "TEMPLATE",
      color: UI_COLOR.warning,
      title: "Not checked: this path uses a variable, so the file is only known once a target is resolved. Pick a target to check it.",
    };
  }
  if (isRemotePath(ref.path)) {
    return { key: "remote", label: "REMOTE", color: UI_COLOR.link };
  }
  if (ref.resolvedPath && !ref.exists) {
    return { key: "missing", label: "MISSING", color: UI_COLOR.error };
  }
  if (ref.exists) {
    return { key: "found", label: "FOUND", color: UI_COLOR.ok };
  }
  return { key: "unknown", label: "UNKNOWN", color: UI_COLOR.muted };
}

function getDefinedVariableNames(parsedBundle) {
  return new Set(Object.keys(parsedBundle?.variables ?? {}));
}

function getTaskIssueCounts(taskNode, parsedBundle, targetName) {
  // Include a for_each task's inner task, as buildInspectorIssues does.
  const checked = [taskNode.taskData, taskNode.taskData?.nestedTask].filter(Boolean);
  const fileReferences = checked.flatMap((data) => data.fileReferences ?? []);
  const variableReferences = checked.flatMap((data) => data.variableReferences ?? []);
  const libraryReferences = checked.flatMap((data) => data.libraryReferences ?? []);

  const missingFiles = fileReferences.filter(
    (ref) => getFileStatus(ref).key === "missing",
  ).length;
  const missingLibraries = libraryReferences.filter(
    (ref) => ref.isLocal && ref.exists === false,
  ).length;
  const unresolvedVariables = new Set(
    variableReferences
      .map((ref) => ref.variableName)
      .filter((name) =>
        !isVariableResolvedForTarget(parsedBundle, name, targetName),
      ),
  ).size;

  return {
    missingFiles,
    missingLibraries,
    unresolvedVariables,
    total: missingFiles + missingLibraries + unresolvedVariables,
  };
}

function formatSourceLocation(file, line) {
  if (!file) return null;
  const fileLabel = basename(file) || file;
  return typeof line === "number" && line > 0 ? `${fileLabel}:${line}` : fileLabel;
}

function issueKindLabel(kind) {
  return (
    {
      missing_file: "Missing file",
      notebook_missing_extension: "Notebook path without extension",
      missing_pipeline_source: "Missing pipeline source",
      missing_library: "Missing local library",
      unresolved_variable: "Unresolved variable",
      cli_diagnostic: "Databricks CLI",
      unknown_or_deprecated_field: "Unknown field",
      unknown_task_type: "Unrecognised task type",
      git_source_not_recommended: "Git source warning",
      secret_scope_name_mismatch: "Secret scope name",
      not_a_notebook: "Not a notebook",
      file_is_a_notebook: "File is a notebook",
      widget_not_set: "Widget not set",
      unused_parameter: "Unused parameter",
      task_value_unknown_task: "Task value",
      task_value_not_upstream: "Task value",
      task_value_key_not_set: "Task value",
      excluded_from_sync: "Not deployed",
      path_not_checked: "Not checked",
      include_matches_nothing: "Include pattern",
      resource_not_included: "Not included",
    }[kind] ?? "Issue"
  );
}

function fileReferenceIssueLabel(ref) {
  const labels = {
    notebook: "Missing notebook file",
    sql: "Missing SQL file",
    python_script: "Missing Python file",
    dbt_project: "Missing dbt project",
    directory: "Missing directory",
    python_wheel: "Missing wheel",
    jar: "Missing JAR",
  };
  return labels[ref?.referenceType] ?? "Missing file";
}

function summarizeTaskIssues(
  taskNode,
  parsedBundle,
  targetName,
  inspectorIssues = [],
) {
  const taskInspectorIssues = inspectorIssues.filter(
    (issue) => issue.taskId === taskNode.id,
  );
  if (taskInspectorIssues.length > 0) {
    return taskInspectorIssues.map((issue) => ({
      id: issue.id,
      title: issue.detail ?? issue.title ?? issueKindLabel(issue.kind),
      detail:
        issue.detail && issue.title && issue.detail !== issue.title
          ? issue.title
          : undefined,
      fixHint: issue.fixHint,
      file: issue.file,
      line: issue.line,
      column: issue.column,
      location: formatSourceLocation(issue.file, issue.line),
      severity: issue.severity,
    }));
  }

  const items = [];
  for (const ref of taskNode.taskData?.fileReferences ?? []) {
    const status = getFileStatus(ref);
    if (status.key !== "missing") continue;
    items.push({
      id: `missing-file:${ref.yamlPath}:${ref.path}`,
      title: fileReferenceIssueLabel(ref),
      detail: ref.path,
      file: taskNode.taskData?.sourceFile,
      line: ref.sourceLine,
      column: ref.sourceColumn,
      location: formatSourceLocation(taskNode.taskData?.sourceFile, ref.sourceLine),
      severity: "error",
    });
  }

  for (const ref of taskNode.taskData?.libraryReferences ?? []) {
    if (!ref.isLocal || ref.exists !== false) continue;
    items.push({
      id: `missing-library:${ref.yamlPath}:${ref.identifier}`,
      title: "Missing local library",
      detail: ref.identifier,
      file: taskNode.taskData?.sourceFile,
      line: ref.sourceLine,
      column: ref.sourceColumn,
      location: formatSourceLocation(taskNode.taskData?.sourceFile, ref.sourceLine),
      severity: "error",
    });
  }

  const unresolvedVariables = new Map();
  for (const ref of taskNode.taskData?.variableReferences ?? []) {
    if (isVariableResolvedForTarget(parsedBundle, ref.variableName, targetName)) {
      continue;
    }
    if (unresolvedVariables.has(ref.variableName)) continue;
    unresolvedVariables.set(ref.variableName, ref);
    items.push({
      id: `unresolved-var:${ref.yamlPath}:${ref.variableName}`,
      title: `Unresolved variable ${ref.variableName}`,
      detail: ref.expression,
      file: taskNode.taskData?.sourceFile,
      line: ref.sourceLine,
      column: ref.sourceColumn,
      location: formatSourceLocation(taskNode.taskData?.sourceFile, ref.sourceLine),
      severity: "error",
    });
  }

  return items;
}

function getTaskPath(taskNode, parentJob) {
  return [parentJob?.displayName, taskNode.displayName].filter(Boolean);
}

function compactTaskName(name) {
  if (name.length <= 26) return name;
  return `${name.slice(0, 24)}...`;
}

function dependencyOutcomeLabel(edge) {
  const outcome = edge?.data?.outcome;
  if (typeof outcome !== "string" || outcome.trim().length === 0) return null;
  const normalized = outcome.trim();
  if (normalized.toLowerCase() === "true") return "True";
  if (normalized.toLowerCase() === "false") return "False";
  return normalized;
}

function dependencyOutcomeTone(label) {
  const normalized = label?.toLowerCase();
  if (normalized === "true") {
    return {
      stroke: UI_COLOR.ok,
      labelColor: UI_COLOR.ok,
      labelBg: UI_COLOR.widget,
      labelBorder: UI_COLOR.ok,
    };
  }
  if (normalized === "false") {
    return {
      stroke: UI_COLOR.muted,
      labelColor: UI_COLOR.fg,
      labelBg: UI_COLOR.widget,
      labelBorder: UI_COLOR.muted,
    };
  }
  return {
    stroke: UI_COLOR.link,
    labelColor: UI_COLOR.link,
    labelBg: UI_COLOR.widget,
    labelBorder: UI_COLOR.link,
  };
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

function buildIssueItems(
  graph,
  jobNode,
  parsedBundle,
  targetName,
  validationIssues,
  inspectorIssues = [],
) {
  const jobTaskIds = new Set(
    getCurrentJobTaskNodes(graph, jobNode).map((task) => task.id),
  );
  if (inspectorIssues.length > 0) {
    return inspectorIssues
      // Same rule as issueBelongsToJob in src/bundle/issues.ts: the job's own tasks,
      // the job itself, or bundle-wide. Issues on another resource (e.g. a pipeline) are left out.
      // With no job (e.g. a pipeline-only bundle) this is the bundle-wide list, so keep everything.
      .filter((issue) =>
        !jobNode
          ? true
          : issue.taskId
            ? jobTaskIds.has(issue.taskId)
            : !issue.resourceId || issue.resourceId === jobNode.id,
      )
      .map((issue) => ({
        id: issue.id,
        group:
          {
            missing_file: "Missing Files",
            notebook_missing_extension: "Notebook Paths Without Extension",
            missing_pipeline_source: "Missing Pipeline Sources",
            missing_library: "Missing Libraries",
            unresolved_variable: "Unresolved Variables",
            cli_diagnostic: "Databricks CLI",
            unknown_or_deprecated_field: "Unknown or Deprecated Fields",
            unknown_task_type: "Unrecognised Task Types",
            git_source_not_recommended: "Git Source Warnings",
            secret_scope_name_mismatch: "Secret Scope Names",
            not_a_notebook: "Not Notebooks",
            file_is_a_notebook: "Files That Are Notebooks",
            widget_not_set: "Widgets Not Set",
            unused_parameter: "Unused Parameters",
            task_value_unknown_task: "Task Values",
            task_value_not_upstream: "Task Values",
            task_value_key_not_set: "Task Values",
            excluded_from_sync: "Files Not Deployed",
            path_not_checked: "Paths Not Checked",
            include_matches_nothing: "Include Patterns",
            resource_not_included: "Resource Files Not Included",
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
      if (isVariableResolvedForTarget(parsedBundle, ref.variableName, targetName)) {
        continue;
      }
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
  parsedBundle,
  targetName,
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
      const resolution = resolveVariableForTarget(
        parsedBundle,
        ref.variableName,
        targetName,
      );
      const unresolved = resolution.status === "unresolved";
      addTaskToMap(
        variables,
        ref.variableName,
        {
          title: ref.variableName,
          kind: "variable",
          unresolved,
          value: resolution.value,
          resolutionSource: resolution.source,
        },
        task.id,
      );
      variables.get(ref.variableName).unresolved ||= unresolved;
      variables.get(ref.variableName).value ??= resolution.value;
      variables.get(ref.variableName).resolutionSource = resolution.source;
    }
  }

  const definedVariableNames = getDefinedVariableNames(parsedBundle);
  for (const variableName of definedVariableNames) {
    if (variables.has(variableName)) continue;
    const resolution = resolveVariableForTarget(
      parsedBundle,
      variableName,
      targetName,
    );
    variables.set(variableName, {
      title: variableName,
      kind: "variable",
      taskIds: new Set(),
      unusedInJob: true,
      value: resolution.value,
      unresolved: resolution.status === "unresolved",
      resolutionSource: resolution.source,
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
          title: displayResolvedValue(
            target.data?.expression ?? target.displayName,
            parsedBundle,
            targetName,
          ),
          kind: target.kind,
          computeType: target.nodeType,
        },
        task.id,
      );
    }

    // {{secrets/scope/key}} in the task's cluster config links the task to the scope directly.
    if (target.nodeType === "secret_scope") {
      addTaskToMap(
        secrets,
        target.id,
        { title: target.displayName, kind: "secret_scope", detail: "Cluster config" },
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

  for (const node of graph.nodes) {
    if (
      node.nodeType !== "secret_scope" ||
      node.resourceGroup !== "secret_scopes" ||
      secrets.has(node.id)
    ) {
      continue;
    }
    secrets.set(node.id, {
      title: node.displayName,
      kind: "secret_scope",
      taskIds: new Set(),
      unusedInJob: true,
    });
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
          getTaskIssueCounts(task, parsedBundle, targetName).total > 0
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
        : `${variableResolutionLabel(item)} · ${taskCountLabel}`,
    ),
    secrets: fromMap(
      secrets,
      "Secret Scopes",
      (item, taskCountLabel) =>
        item.unusedInJob ? "Defined resource" : taskCountLabel,
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
      parsedBundle,
      targetName,
      validationIssues,
      inspectorIssues,
    ),
  };
}

function variableResolutionLabel(item) {
  if (item.unresolved) return "UNRESOLVED";
  const source = item.resolutionSource ?? item.source;
  if (source === "target_override") return "TARGET";
  if (source === "cli_resolved") return "RESOLVED";
  if (source === "global_default") return "DEFAULT";
  if (source === "lookup") return "LOOKUP";
  if (source === "no_default") return "NO DEFAULT";
  if (source === "outside_files") return "ENV / FILE";
  return "BUNDLE";
}

function displayResolvedValue(value, parsedBundle, targetName) {
  if (typeof value !== "string" || !targetName) return value;
  return resolveExpressionForTarget(value, parsedBundle, targetName).value;
}

function buildSearchItems(graph, jobNode, parsedBundle, targetName) {
  const tasks = getCurrentJobTaskNodes(graph, jobNode);
  return tasks.map((task) => {
    const issues = getTaskIssueCounts(task, parsedBundle, targetName);
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

function buildDagFlow(graph, selectedJobKey, parsedBundle, targetName) {
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
  const branchOutcomesByTask = new Map(allTasks.map((task) => [task.id, []]));
  for (const edge of depEdges) {
    if (!taskIds.has(edge.source) || !taskIds.has(edge.target)) continue;
    incomingByTask.get(edge.target)?.push(edge.source);
    const outcomeLabel = dependencyOutcomeLabel(edge);
    if (outcomeLabel) {
      branchOutcomesByTask.get(edge.source)?.push(outcomeLabel);
    }
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
          badge: task.taskTypeBadge,
          subtitle: task.subtitle,
          branchOutcomes: [...new Set(branchOutcomesByTask.get(task.id) ?? [])],
          hasMissingFile: task.hasMissingFile,
          issueCounts: getTaskIssueCounts(task, parsedBundle, targetName),
        },
      });
    });
  });

  depEdges.forEach((e) => {
    if (!taskById.has(e.source)) return;
    const outcomeLabel = dependencyOutcomeLabel(e);
    const outcomeTone = dependencyOutcomeTone(outcomeLabel);
    flowEdges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "straight",
      ...(outcomeLabel
        ? {
            label: outcomeLabel,
            labelStyle: {
              fill: outcomeTone.labelColor,
              fontSize: 11,
              fontWeight: 700,
            },
            labelBgStyle: {
              fill: outcomeTone.labelBg,
              stroke: outcomeTone.labelBorder,
              strokeWidth: 1,
            },
            labelBgPadding: [6, 4],
            labelBgBorderRadius: 4,
          }
        : {}),
      style: {
        stroke: outcomeTone.stroke,
        strokeWidth: 2,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: outcomeTone.stroke,
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
  if (linkage.kind === "job_override") return "JOB PARAM LINK";
  if (linkage.kind === "task") return "TASK DEFAULT";
  if (linkage.kind === "job") return "JOB DEFAULT";
  return null;
}

function parameterLinkageDetail(linkage) {
  if (!linkage) return null;
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
  if (linkage.kind === "job_override") return "SUPPLIED VIA JOB";
  if (linkage.kind === "task") return "SUPPLIED BY TASK";
  if (linkage.kind === "job") return "SUPPLIED BY JOB";
  return null;
}

function widgetLinkageDetail(name, linkage) {
  if (!linkage) return null;
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

function buildParameterLinkageMaps(node) {
  const taskParams = new Map(
    (node.taskData?.taskParameterReferences ?? []).map((ref) => [
      ref.name,
      ref,
    ]),
  );
  const jobParams = new Map(
    (node.taskData?.jobParameterReferences ?? []).map((ref) => [
      ref.name,
      ref,
    ]),
  );
  return { taskParams, jobParams };
}

function parameterLinkageForName(name, taskParams, jobParams) {
  const taskParam = taskParams.get(name);
  if (taskParam) {
    const jobParam = jobParams.get(name);
    return {
      kind: taskParam.isOverriddenByJob ? "job_override" : "task",
      taskValue: taskParam.value,
      jobParameterDefault: taskParam.jobParameterDefault,
      effectiveValue: taskParam.effectiveValue,
      confidence: taskParam.confidence,
      sourceLine: taskParam.sourceLine,
      sourceColumn: taskParam.sourceColumn,
      jobSourceLine: jobParam?.sourceLine,
      jobSourceColumn: jobParam?.sourceColumn,
    };
  }
  const jobParam = jobParams.get(name);
  if (jobParam) {
    return {
      kind: "job",
      jobParameterDefault: jobParam.default,
      effectiveValue: jobParam.default,
      sourceLine: jobParam.sourceLine,
      sourceColumn: jobParam.sourceColumn,
    };
  }
  return null;
}

function canOpenLinkageSource(sourceFile, linkage) {
  return Boolean(
    sourceFile &&
      linkage &&
      typeof linkage.sourceLine === "number" &&
      linkage.sourceLine > 0,
  );
}

function getPrimaryFileNode(graph, nodeById, taskId) {
  return graph.edges
    .filter((edge) => edge.source === taskId && edge.kind === "references")
    .map((edge) => nodeById.get(edge.target))
    .find((node) => node?.nodeType === "file");
}

function parameterFlowTargetLabel(fileReferenceType) {
  if (fileReferenceType === "sql") return "SQL";
  if (fileReferenceType === "notebook" || fileReferenceType === "python_script") {
    return "NOTEBOOK";
  }
  return "FILE";
}

function makeParameterFlowSegment(label, name, file, line, column) {
  return {
    label,
    name,
    file,
    line,
    column,
  };
}

function buildParameterFlowsForTask(graph, nodeById, taskNode) {
  const sourceFile = taskNode.taskData?.sourceFile;
  const primaryFileNode = getPrimaryFileNode(graph, nodeById, taskNode.id);
  if (!primaryFileNode) return [];

  const primaryFileRef = (taskNode.taskData?.fileReferences ?? [])[0];
  const { taskParams, jobParams } = buildParameterLinkageMaps(taskNode);
  const flows = [];

  for (const edge of graph.edges) {
    if (edge.source !== primaryFileNode.id || edge.kind !== "uses") continue;
    const widgetNode = nodeById.get(edge.target);
    if (!widgetNode || widgetNode.nodeType !== "widget") continue;

    const name = widgetNode.displayName;
    const linkage = parameterLinkageForName(name, taskParams, jobParams);
    if (!linkage) continue;

    const segments = [];
    if (linkage.kind === "job_override") {
      segments.push(
        makeParameterFlowSegment(
          "JOB",
          name,
          sourceFile,
          linkage.jobSourceLine,
          linkage.jobSourceColumn,
        ),
      );
      segments.push(
        makeParameterFlowSegment(
          "TASK",
          name,
          sourceFile,
          linkage.sourceLine,
          linkage.sourceColumn,
        ),
      );
    } else if (linkage.kind === "job") {
      segments.push(
        makeParameterFlowSegment(
          "JOB",
          name,
          sourceFile,
          linkage.sourceLine,
          linkage.sourceColumn,
        ),
      );
    } else if (linkage.kind === "task") {
      segments.push(
        makeParameterFlowSegment(
          "TASK",
          name,
          sourceFile,
          linkage.sourceLine,
          linkage.sourceColumn,
        ),
      );
    }

    segments.push(
      makeParameterFlowSegment(
        parameterFlowTargetLabel(primaryFileRef?.referenceType),
        name,
        primaryFileNode.data?.resolvedPath ?? null,
        edge.data?.line ?? null,
        null,
      ),
    );

    if (segments.length >= 2) {
      flows.push({
        id: `${taskNode.id}:${name}:${segments.map((segment) => segment.label).join(">")}`,
        name,
        taskName: taskNode.displayName,
        segments,
      });
    }
  }

  const seen = new Set();
  return flows.filter((flow) => {
    const key = `${flow.name}:${flow.segments
      .map((segment) => `${segment.label}:${segment.line ?? ""}`)
      .join(">")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildParameterFlowsForJob(graph, jobNode) {
  if (!graph || !jobNode) return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return getCurrentJobTaskNodes(graph, jobNode).flatMap((taskNode) =>
    buildParameterFlowsForTask(graph, nodeById, taskNode),
  );
}

function parameterFlowMarkdownLabel(segment) {
  if (segment.label === "JOB") return "job parameter";
  if (segment.label === "TASK") return "task parameter";
  if (segment.label === "NOTEBOOK") return "notebook widget";
  if (segment.label === "SQL") return "SQL parameter";
  return "file usage";
}

function buildBundleReviewSummary({
  parsedBundle,
  graph,
  jobNode,
  targetLabel,
  headerPanelItems,
  parameterFlows,
}) {
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
    for (const issue of issues.slice(0, 12)) {
      const taskPrefix =
        issue.subtitle && issue.subtitle !== issue.title
          ? `${issue.subtitle}: `
          : "";
      const location = formatSourceLocation(issue.file, issue.line);
      lines.push(
        `- ${taskPrefix}${issue.title}${location ? ` (${location})` : ""}`,
      );
    }
    if (issues.length > 12) {
      lines.push(`- ...and ${issues.length - 12} more.`);
    }
  }

  lines.push("", "### Parameter Flow");
  const flows = parameterFlows ?? [];
  if (flows.length === 0) {
    lines.push("- No job/task parameter to notebook or SQL usage detected.");
  } else {
    const seen = new Set();
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
  const fileKeys = new Set();
  let missingFileCount = 0;
  for (const task of tasks) {
    for (const ref of task.taskData?.fileReferences ?? []) {
      fileKeys.add(ref.resolvedPath ?? ref.path);
      if (getFileStatus(ref).key === "missing") {
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
          const Icon = item.severity === "info" ? Info : AlertTriangle;
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
              <Icon
                size={13}
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
  const secretItems = [...fileSecretItems, ...configSecretItems];

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

/**
 * The banner for a target that fell back for want of a sign-in. One state at a time, each
 * replacing the one before: needs sign-in, press Enter in the terminal, sign-in saved,
 * checking. The graph below stays usable throughout: it shows the structural preview.
 */
function SignInBanner({ signIn, fallbackMessage, onOpenTerminal, onCheckAgain, onOpenGuide }) {
  const { target, stage, blockedReason } = signIn;
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
        {guide}
      </>
    );
  } else if (stage === "terminal") {
    content = (
      <>
        <span>Press Enter in the terminal to start sign-in.</span>
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

  const jobsByKey = useMemo(
    () => parsedBundle?.resources?.jobs ?? parsedBundle?.resources?.job ?? {},
    [parsedBundle],
  );
  const jobKeys = useMemo(() => Object.keys(jobsByKey), [jobsByKey]);
  const pipelineKeys = useMemo(() => pipelineKeysOf(parsedBundle), [parsedBundle]);

  const selection = useMemo(
    () => resolveSelection(jobKeys, pipelineKeys, userSelection, initialResource),
    [jobKeys, pipelineKeys, userSelection, initialResource],
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
  const effectiveTargetName =
    inspectedTargetMode === "target"
      ? inspectedTarget || parsedBundle?.bundle?.target || requestedTarget
      : null;
  const effectiveResolutionBundle = resolutionBundle ?? parsedBundle;
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
    const pipelinesByKey = parsedBundle?.resources?.pipelines ?? {};
    const pipelineOptions = pipelineKeys.map((key) => {
      const name = pipelinesByKey[key]?.name;
      const displayName =
        typeof name === "string" && name.trim() && name !== key
          ? displayResolvedValue(name, effectiveResolutionBundle, effectiveTargetName)
          : "";
      return {
        value: selectionValue({ group: "pipelines", key }),
        key,
        label: displayName && displayName !== key ? `${key} (${displayName})` : key,
      };
    });
    return [
      ...(jobOptions.length > 0 ? [{ label: "Jobs", options: jobOptions }] : []),
      ...(pipelineOptions.length > 0 ? [{ label: "Pipelines", options: pipelineOptions }] : []),
    ];
  }, [jobOptions, pipelineKeys, parsedBundle, effectiveResolutionBundle, effectiveTargetName]);

  const pipelineView = useMemo(
    () =>
      graph && selectedPipelineKey !== undefined
        ? buildPipelineView(graph, parsedBundle, selectedPipelineKey, inspectorIssues)
        : undefined,
    [graph, parsedBundle, selectedPipelineKey, inspectorIssues],
  );
  const otherPipelines = useMemo(() => {
    if (!pipelineView) return [];
    const counts = pipelineIssueCounts(pipelineKeys, inspectorIssues);
    return pipelineKeys
      .filter((key) => key !== pipelineView.key)
      .map((key) => ({ key, issueCount: counts.get(key) ?? 0 }));
  }, [pipelineView, pipelineKeys, inspectorIssues]);

  const { flowNodes, flowEdges, jobNode } = useMemo(
    () =>
      graph && selectedJobKey
        ? buildDagFlow(
            graph,
            selectedJobKey,
            effectiveResolutionBundle,
            effectiveTargetName,
          )
        : { flowNodes: [], flowEdges: [], jobNode: null },
    [graph, selectedJobKey, effectiveResolutionBundle, effectiveTargetName],
  );

  const searchItems = useMemo(
    () =>
      graph && jobNode
        ? buildSearchItems(
            graph,
            jobNode,
            effectiveResolutionBundle,
            effectiveTargetName,
          )
        : [],
    [graph, jobNode, effectiveResolutionBundle, effectiveTargetName],
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
  const parameterFlowsForJob = useMemo(
    () => buildParameterFlowsForJob(graph, jobNode),
    [graph, jobNode],
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
    if (graphMode !== "issues" || issueTaskIds.size === 0) return null;
    return issueTaskIds;
  }, [graphMode, issueTaskIds]);

  const displayFlowNodes = useMemo(
    () =>
      flowNodes.map((node) => {
        const selected = node.id === selectedNodeId;
        const related = focusedTaskIds?.has(node.id) ?? false;
        const issueMatched = graphMode === "issues" && issueTaskIds.has(node.id);
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
      graphMode,
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
    [flowEdges, focusedTaskIds],
  );

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

  function selectTaskNode(nodeId) {
    // The Issues list sits above the task details, so picking a task closes it.
    setActiveHeaderPanel(null);
    setSelectedNodeId(nodeId);
    setFocusRequest({ nodeId, nonce: Date.now() });
  }

  function clearSelectedTask() {
    setSelectedNodeId(null);
    setFocusRequest(null);
  }

  function selectPanelItem(item) {
    onTelemetry?.("issue_item_selected");
    if (item.taskId) {
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
    selectTaskNode(item.taskId);
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

  function handleGraphModeChange(value) {
    if (value !== graphMode) onTelemetry?.("graph_mode_changed", { mode: value });
    setGraphMode(value);
    setActiveHeaderPanel(value === "issues" ? "issues" : null);
  }

  function handleCopyReviewSummary() {
    if (!onCopyReviewSummary) return;
    if (pipelineView) {
      onCopyReviewSummary(
        pipelineReviewSummary(pipelineView, {
          bundleName: parsedBundle?.bundle?.name ?? "Unknown bundle",
          targetLabel,
          resolveName: (value) => displayResolvedValue(value, effectiveResolutionBundle, effectiveTargetName),
        }),
      );
      return;
    }
    onCopyReviewSummary(
      buildBundleReviewSummary({
        parsedBundle,
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
        bundleName={parsedBundle?.bundle?.name}
        targetLabel={targetLabel}
        targetTitle={targetTitle}
        targetMode={inspectedTargetMode}
        targetOptions={targetOptions}
        // What is shown, not what was asked for: a target that fell back shows the preview.
        selectedTarget={inspectedTargetMode === "target" ? requestedTarget : undefined}
        onTargetChange={onSelectTarget}
        pickerGroups={pickerGroups}
        selectedValue={selection ? selectionValue(selection) : ""}
        onPickerChange={(value) => handleSelectionChange(parseSelectionValue(value))}
        showTaskTools={!pipelineView}
        searchValue={searchValue}
        searchItems={searchItems}
        onSearchChange={setSearchValue}
        onSearchSelect={handleSearchSelect}
        graphMode={graphMode}
        onGraphModeChange={handleGraphModeChange}
        issueCount={selectedJobIssueCount}
        onCopyReviewSummary={
          onCopyReviewSummary ? handleCopyReviewSummary : undefined
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
            <PipelineView
              view={pipelineView}
              otherPipelines={otherPipelines}
              background={rfStyle}
              onSelect={handleSelectionChange}
              onOpenFile={onOpenFile}
              resolveName={(value) =>
                displayResolvedValue(value, effectiveResolutionBundle, effectiveTargetName)
              }
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
              onNodeClick={(_, node) =>
                selectedNodeId === node.id
                  ? clearSelectedTask()
                  : selectTaskNode(node.id)
              }
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
                  node.data?.issueCounts?.total > 0
                    ? UI_COLOR.error
                    : kindMeta(node.data?.kind).color
                }
                nodeColor={(node) =>
                  node.data?.issueCounts?.total > 0
                    ? UI_COLOR.error
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
            onSelectPipeline={(key) => handleSelectionChange({ group: "pipelines", key })}
            onClose={clearSelectedTask}
            onOpenFile={onOpenFile}
          />
        )}
      </div>

    </div>
  );
}
