import { useEffect, useMemo, useState } from "react";
import { extractBundleGraph } from "../shared/bundleGraph";
import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
} from "@xyflow/react";
import { JobSummaryCard, JobSummaryNode, ResourcePillNode, TaskNode } from "./components/JobNode";
import { KindIcon } from "./components/Icons";
import "@xyflow/react/dist/style.css";

const nodeTypes = {
  jobSummary: JobSummaryNode,
  task: TaskNode,
  resource: ResourcePillNode,
};

function estimateTaskWidth(taskNode) {
  const typeLabelLength = (taskNode.taskTypeLabel ?? "Task").length;
  const nameLength = taskNode.displayName.length;
  const subtitleLength = taskNode.subtitle?.length ?? 0;
  const computeWidth = taskNode.compute?.length ? 44 : 0;

  return Math.min(
    360,
    Math.max(
      220,
      120 + typeLabelLength * 7 + Math.max(nameLength * 7, Math.min(subtitleLength, 28) * 6) + computeWidth,
    ),
  );
}

function getTaskLevel(node, allNodes, edges, memo = new Map()) {
  if (memo.has(node.id)) {
    return memo.get(node.id);
  }

  const inboundDependencies = edges.filter(
    (edge) => edge.relationship === "depends_on" && edge.target === node.id,
  );

  if (inboundDependencies.length === 0) {
    memo.set(node.id, 0);
    return 0;
  }

  const level =
    Math.max(
      ...inboundDependencies.map((edge) => {
        const sourceNode = allNodes.find((candidate) => candidate.id === edge.source);
        return sourceNode ? getTaskLevel(sourceNode, allNodes, edges, memo) + 1 : 0;
      }),
    ) || 0;

  memo.set(node.id, level);
  return level;
}

function buildFlowFromBundle(parsedBundle) {
  const graph = extractBundleGraph(parsedBundle);
  const jobNodes = graph.nodes.filter((node) => node.nodeType === "job");
  const flowNodes = [];
  const summaryCards = [];

  jobNodes.forEach((jobNode, jobIndex) => {
    const baseX = 360 + jobIndex * 980;
    const baseY = 40;

    summaryCards.push({
      id: jobNode.id,
      data: {
        name: jobNode.displayName,
        trigger: jobNode.trigger,
        runAs: jobNode.runAs,
        taskCount: jobNode.taskCount,
        parameters: jobNode.parameters,
        compute: jobNode.compute,
      },
    });

    const taskNodes = graph.nodes.filter(
      (node) => node.nodeType === "task" && node.parentId === jobNode.id,
    );
    const taskEdges = graph.edges.filter(
      (edge) =>
        (edge.relationship === "depends_on" || edge.relationship === "contains") &&
        (edge.source === jobNode.id ||
          taskNodes.some((taskNode) => taskNode.id === edge.source) ||
          taskNodes.some((taskNode) => taskNode.id === edge.target)),
    );
    const levelMemo = new Map();
    const levelRows = new Map();
    const taskLevels = new Map();
    const levelWidths = new Map();

    taskNodes.forEach((taskNode) => {
      const level = getTaskLevel(taskNode, taskNodes, taskEdges, levelMemo);
      taskLevels.set(taskNode.id, level);
      levelWidths.set(
        level,
        Math.max(levelWidths.get(level) ?? 0, estimateTaskWidth(taskNode)),
      );
    });

    const levelOffsets = new Map();
    let currentOffset = 0;
    const orderedLevels = [...levelWidths.keys()].sort((a, b) => a - b);

    orderedLevels.forEach((level) => {
      levelOffsets.set(level, currentOffset);
      currentOffset += (levelWidths.get(level) ?? 260) + 80;
    });
    const tasksByLevel = new Map();
    taskNodes.forEach((taskNode) => {
      const level = taskLevels.get(taskNode.id) ?? 0;
      const currentLevelTasks = tasksByLevel.get(level) ?? [];
      currentLevelTasks.push(taskNode);
      tasksByLevel.set(level, currentLevelTasks);
    });

    const rowByTaskId = new Map();

    function getAnchorRow(taskNode) {
      const incomingEdges = taskEdges.filter(
        (edge) => edge.relationship === "depends_on" && edge.target === taskNode.id,
      );

      if (incomingEdges.length === 0) {
        return null;
      }

      const incomingRows = incomingEdges
        .map((edge) => rowByTaskId.get(edge.source))
        .filter((row) => typeof row === "number");

      if (incomingRows.length === 0) {
        return null;
      }

      return incomingRows.reduce((sum, row) => sum + row, 0) / incomingRows.length;
    }

    function claimNearestFreeRow(preferredRow, usedRows) {
      let distance = 0;

      while (true) {
        const lowerCandidate = preferredRow - distance;
        if (lowerCandidate >= 0 && !usedRows.has(lowerCandidate)) {
          usedRows.add(lowerCandidate);
          return lowerCandidate;
        }

        const upperCandidate = preferredRow + distance;
        if (!usedRows.has(upperCandidate)) {
          usedRows.add(upperCandidate);
          return upperCandidate;
        }

        distance += 1;
      }
    }

    orderedLevels.forEach((level) => {
      const levelTaskNodes = tasksByLevel.get(level) ?? [];

      levelTaskNodes.sort((leftTaskNode, rightTaskNode) => {
        if (level === 0) {
          return leftTaskNode.displayName.localeCompare(rightTaskNode.displayName);
        }

        const leftAnchor = getAnchorRow(leftTaskNode);
        const rightAnchor = getAnchorRow(rightTaskNode);
        const anchorDifference =
          (leftAnchor ?? Number.MAX_SAFE_INTEGER) -
          (rightAnchor ?? Number.MAX_SAFE_INTEGER);

        if (anchorDifference !== 0) {
          return anchorDifference;
        }

        return leftTaskNode.displayName.localeCompare(rightTaskNode.displayName);
      });

      const usedRows = new Set();

      levelTaskNodes.forEach((taskNode, index) => {
        const anchorRow = getAnchorRow(taskNode);
        const row =
          level === 0 || anchorRow === null
            ? claimNearestFreeRow(index, usedRows)
            : claimNearestFreeRow(Math.round(anchorRow), usedRows);

        rowByTaskId.set(taskNode.id, row);

        const isEntryTask = !taskEdges.some(
          (edge) => edge.relationship === "depends_on" && edge.target === taskNode.id,
        );
        const isTerminalTask = !taskEdges.some(
          (edge) => edge.relationship === "depends_on" && edge.source === taskNode.id,
        );

        flowNodes.push({
          id: taskNode.id,
          type: "task",
          position: {
            x: baseX + levelOffsets.get(level),
            y: baseY + 180 + row * 220,
          },
          data: {
            id: taskNode.id,
            name: taskNode.displayName,
            taskTypeLabel: taskNode.taskTypeLabel,
            subtitle: taskNode.subtitle,
            kind: taskNode.kind,
            parameters: taskNode.parameters,
            compute: taskNode.compute,
            isEntryTask,
            isTerminalTask,
            taskKey: taskNode.taskKey,
            rawData: taskNode.data,
          },
        });
      });
    });
  });

  const flowEdges = graph.edges.map((edge) => {
    const isDependency = edge.relationship === "depends_on";
    if (edge.relationship === "contains") {
      return null;
    }

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: isDependency,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: "#fafaf9",
      },
      style: isDependency
          ? {
              stroke: "#fafaf9",
              strokeDasharray: "6 4",
              strokeWidth: 1.6,
            }
          : {
              stroke: "#a8a29e",
              strokeWidth: 1.1,
              opacity: 0.7,
            },
    };
  }).filter(Boolean);

  return { nodes: flowNodes, edges: flowEdges, summaries: summaryCards };
}

function selectSingleJobBundle(parsedBundle, selectedJobKey) {
  if (!selectedJobKey) {
    return parsedBundle;
  }

  const selectedJob = parsedBundle?.resources?.jobs?.[selectedJobKey];

  if (!selectedJob) {
    return parsedBundle;
  }

  return {
    ...parsedBundle,
    resources: {
      ...parsedBundle.resources,
      jobs: {
        [selectedJobKey]: selectedJob,
      },
    },
  };
}

function App({ parsedBundle, selectedJobKey: initialSelectedJobKey }) {
  const jobsByKey = useMemo(
    () => parsedBundle?.resources?.jobs ?? {},
    [parsedBundle],
  );
  const jobKeys = useMemo(() => Object.keys(jobsByKey), [jobsByKey]);
  const jobOptions = useMemo(
    () =>
      jobKeys.map((jobKey) => {
        const jobName = jobsByKey[jobKey]?.name;
        return {
          value: jobKey,
          label:
            typeof jobName === "string" && jobName.trim()
              ? `${jobKey} - ${jobName}`
              : jobKey,
        };
      }),
    [jobKeys, jobsByKey],
  );
  const [selectedJobKey, setSelectedJobKey] = useState(
    initialSelectedJobKey ?? jobKeys[0] ?? "",
  );

  useEffect(() => {
    const fallbackJobKey = initialSelectedJobKey ?? jobKeys[0] ?? "";

    if (!selectedJobKey || !jobKeys.includes(selectedJobKey)) {
      setSelectedJobKey(fallbackJobKey);
    }
  }, [initialSelectedJobKey, jobKeys, selectedJobKey]);

  const filteredBundle = useMemo(
    () => selectSingleJobBundle(parsedBundle, selectedJobKey),
    [parsedBundle, selectedJobKey],
  );
  const flow = useMemo(() => buildFlowFromBundle(filteredBundle), [filteredBundle]);
  const [nodes, setNodes] = useState(flow.nodes);
  const [edges, setEdges] = useState(flow.edges);
  const [selectedTaskNodeId, setSelectedTaskNodeId] = useState("");
  const rfStyle = {
    background:
      "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.07) 1px, transparent 0)",
    backgroundColor: "#111111",
    backgroundSize: "16px 16px",
  };

  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedTaskNodeId("");
  }, [flow]);

  function onNodesChange(changes) {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  }

  function onNodeClick(_event, node) {
    if (node.type !== "task") {
      return;
    }

    setSelectedTaskNodeId(node.id);
  }

  const selectedTask = useMemo(
    () => nodes.find((node) => node.id === selectedTaskNodeId && node.type === "task"),
    [nodes, selectedTaskNodeId],
  );

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <div className="absolute left-6 top-6 z-20 flex items-start gap-3">
        {jobKeys.length > 1 ? (
          <label className="flex flex-col gap-2 rounded-xl border border-stone-700 bg-stone-950/95 px-4 py-3 text-xs text-stone-200 shadow-[0_10px_30px_rgba(0,0,0,0.25)] backdrop-blur">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
              Job
            </span>
            <select
              value={selectedJobKey}
              onChange={(event) => setSelectedJobKey(event.target.value)}
              className="min-w-[220px] rounded-md border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-50 outline-none transition focus:border-emerald-400"
            >
              {jobOptions.map((jobOption) => (
                <option key={jobOption.value} value={jobOption.value}>
                  {jobOption.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {flow.summaries[0] ? (
        <div
          className={`pointer-events-none absolute left-6 z-10 ${
            jobKeys.length > 1 ? "top-24" : "top-6"
          }`}
        >
          <div className="pointer-events-auto">
            <JobSummaryCard data={flow.summaries[0].data} />
          </div>
        </div>
      ) : null}
      {selectedTask ? (
        <div
          className="absolute right-6 top-6 z-20 w-[380px] rounded-2xl border border-stone-700 bg-stone-950/95 p-5 text-stone-50 shadow-[0_18px_44px_rgba(0,0,0,0.35)] backdrop-blur"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
                Task Details
              </div>
              <div
                className="break-words text-lg font-semibold leading-tight"
                title={selectedTask.data.name}
              >
                {selectedTask.data.name}
              </div>
            </div>
            <button
              type="button"
              title="Close"
              onClick={() => setSelectedTaskNodeId("")}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-red-500/60 bg-red-500/10 text-sm font-bold text-red-300 transition hover:border-red-400 hover:bg-red-500/20 hover:text-red-100"
            >
              x
            </button>
          </div>

          <div className="space-y-4 text-sm">
            <section>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
                Task Type
              </div>
              <div>{selectedTask.data.taskTypeLabel}</div>
            </section>

            {selectedTask.data.subtitle ? (
              <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
                  Path / Target
                </div>
                <div className="break-all text-stone-200">{selectedTask.data.subtitle}</div>
              </section>
            ) : null}

            {selectedTask.data.compute?.length ? (
              <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
                  Compute
                </div>
                <div className="space-y-1">
                  {selectedTask.data.compute.map((item) => (
                    <div key={`${item.kind}-${item.label}`} className="flex items-center gap-2 text-stone-200">
                      <div className="rounded-full border border-stone-700 p-1.5">
                        <KindIcon kind={item.kind} color="#f5f5f4" size={12} />
                      </div>
                      <div className="min-w-0 break-all">{item.label}</div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {selectedTask.data.parameters?.length ? (
              <section>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
                  Effective Parameters
                </div>
                <div className="max-h-[220px] space-y-1 overflow-auto rounded-xl border border-stone-800 bg-stone-900/80 p-3">
                  {selectedTask.data.parameters.map((parameter) => (
                    <div key={parameter.name} className="break-all text-stone-200">
                      <span className="text-stone-400">{parameter.name}</span>
                      <span>: </span>
                      <span>{parameter.value}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        style={rfStyle}
        defaultEdgeOptions={{ zIndex: 0 }}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        nodesConnectable={false}
        edgesReconnectable={false}
      >
        <Background color="rgba(255,255,255,0.08)" gap={16} />
        <MiniMap
          position="bottom-right"
          style={{
            backgroundColor: "#18181b",
            border: "1px solid #3f3f46",
            borderRadius: 12,
          }}
          bgColor="#18181b"
          maskColor="rgba(255,255,255,0.08)"
          nodeStrokeColor={(node) => {
            if (node.type === "jobSummary") {
              return "#86efac";
            }

            if (node.type === "resource") {
              return "#d6d3d1";
            }

            return "#1c1917";
          }}
          nodeColor={(node) => {
            if (node.type === "jobSummary") {
              return "#052e16";
            }

            if (node.type === "resource") {
              return "#292524";
            }

            return "#f5f5f4";
          }}
          nodeBorderRadius={10}
          pannable
          zoomable
        />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export default App;
