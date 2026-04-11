import { Handle, Position } from "@xyflow/react";
import { KindIcon } from "./Icons";

function NodeHandle({ type, position, className = "" }) {
  return (
    <Handle
      type={type}
      position={position}
      className={`!h-2.5 !w-2.5 !border-2 !border-stone-950 !bg-white ${className}`}
    />
  );
}

export function JobSummaryCard({ data }) {
  const {
    name,
    trigger = "Manual",
    runAs = "Not specified",
    taskCount = 0,
    parameters = [],
    compute = [],
  } = data;

  return (
    <div className="w-[260px] rounded-2xl border border-stone-700 bg-stone-950 p-5 text-stone-50 shadow-[0_18px_44px_rgba(0,0,0,0.35)]">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">
            Job Summary
          </div>
          <div className="text-lg font-semibold leading-tight">{name}</div>
        </div>
        <div className="rounded-full border border-stone-700 bg-stone-900 p-2">
          <KindIcon kind="job" color="#86efac" size={16} />
        </div>
      </div>

      <div className="space-y-4 text-sm">
        <section>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
            Schedule & Trigger
          </div>
          <div className="text-stone-100">{trigger}</div>
        </section>

        <section>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
            Run As
          </div>
          <div className="text-stone-100">{runAs}</div>
        </section>

        <section>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
            Tasks
          </div>
          <div className="text-stone-100">{taskCount}</div>
        </section>

        {parameters.length > 0 ? (
          <section>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
              Parameters
            </div>
            <div className="space-y-1 text-stone-200">
              {parameters.map((parameter) => (
                <div key={parameter.name} className="truncate">
                  <span className="text-stone-400">{parameter.name}</span>
                  <span>: </span>
                  <span>{parameter.value}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {compute.length > 0 ? (
          <section>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">
              Compute
            </div>
            <div className="space-y-2">
              {compute.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-2 text-stone-100"
                >
                  <div className="rounded-full border border-stone-700 p-1.5">
                    <KindIcon kind={item.kind} color="#f5f5f4" size={13} />
                  </div>
                  <div>{item.label}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function JobSummaryNode({ data }) {
  return (
    <div className="relative">
      <JobSummaryCard data={data} />
      <NodeHandle
        type="source"
        position={Position.Right}
        className="!bg-emerald-300"
      />
    </div>
  );
}

export function TaskNode({ data, selected }) {
  const {
    name,
    subtitle,
    taskTypeLabel = "Task",
    parameters = [],
    compute = [],
    isEntryTask = false,
    isTerminalTask = false,
  } = data;
  const primaryCompute = compute[0];
  const computeTitle =
    compute.length > 1
      ? compute.map((item) => item.label).join(", ")
      : primaryCompute?.label;
  const shortTaskTypeLabel =
    taskTypeLabel === "Notebook"
      ? "NB"
      : taskTypeLabel === "Python script"
        ? "PY"
      : taskTypeLabel === "Python wheel"
          ? "WHL"
          : taskTypeLabel === "Pipeline"
            ? "PL"
            : taskTypeLabel === "Run Job"
              ? "JOB"
              : taskTypeLabel === "If/else"
                ? "IF"
                : taskTypeLabel === "For each"
                  ? "EACH"
                  : taskTypeLabel === "Dashboards"
                    ? "DSH"
                    : taskTypeLabel === "Power BI"
                      ? "PBI"
                      : taskTypeLabel === "Clean room"
                        ? "CR"
                        : taskTypeLabel === "Spark Submit"
                          ? "SUB"
                            : taskTypeLabel === "JAR"
                              ? "JAR"
                            : taskTypeLabel === "dbt"
                              ? "DBT"
                              : taskTypeLabel === "dbt platform (Beta)"
                                ? "DBTP"
                                : taskTypeLabel === "SQL Alert (Beta)"
                                  ? "ALRT"
                                : taskTypeLabel === "SQL"
                                  ? "SQL"
                                  : "TSK";

  return (
    <div
      className={`relative inline-flex min-w-0 max-w-[420px] rounded-3xl border bg-white px-7 py-6 pl-14 text-stone-950 shadow-[0_12px_30px_rgba(15,23,42,0.10)] transition ${
        selected
          ? "border-emerald-400 ring-2 ring-emerald-200"
          : "border-stone-200"
      }`}
    >
      <div
        title={taskTypeLabel}
        className="absolute left-2 -translate-y-1/2 rounded-full border border-stone-300 bg-stone-50 px-3 py-1 text-[11px] font-semibold tracking-[0.04em] text-stone-700"
      >
        {shortTaskTypeLabel}
      </div>

      <div className="flex min-w-0 items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold leading-tight">
            {name}
          </div>
          {subtitle ? (
            <div
              className="mt-1 max-w-[260px] truncate text-xs text-stone-500"
              title={subtitle}
            >
              {subtitle}
            </div>
          ) : null}
          {parameters.length > 0 ? (
            <div
              className="mt-2 max-w-[260px] space-y-1.5"
              title={parameters.map((parameter) => `${parameter.name}: ${parameter.value}`).join("\n")}
            >
              {parameters.slice(0, 2).map((parameter) => (
                <div
                  key={parameter.name}
                  title={`${parameter.name}: ${parameter.value}`}
                  className="truncate rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-[11px] text-stone-600"
                >
                  <span className="font-medium text-stone-500">{parameter.name}</span>
                  <span className="text-stone-400"> = </span>
                  <span>{parameter.value}</span>
                </div>
              ))}
              {parameters.length > 2 ? (
                <div
                  className="text-[11px] font-medium text-stone-500"
                  title={parameters.slice(2).map((parameter) => `${parameter.name}: ${parameter.value}`).join("\n")}
                >
                  +{parameters.length - 2} more
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {primaryCompute ? (
          <div className="shrink-0">
            <div
              title={computeTitle}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-stone-300 bg-stone-50 text-stone-700"
            >
              <KindIcon kind={primaryCompute.kind} color="#44403c" size={12} />
            </div>
          </div>
        ) : null}
      </div>

      {!isEntryTask ? (
        <NodeHandle type="target" position={Position.Left} />
      ) : null}
      {!isTerminalTask ? (
        <NodeHandle type="source" position={Position.Right} />
      ) : null}
    </div>
  );
}

export function ResourcePillNode({ data }) {
  const { name, subtitle, kind = "volume" } = data;

  return (
    <div className="rounded-xl border border-stone-700 bg-stone-900 px-3 py-2 text-stone-50 shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
      <div className="flex items-center gap-2">
        <div className="rounded-full border border-stone-500 p-1">
          <KindIcon kind={kind} color="#ffffff" size={12} />
        </div>
        <div>
          <div className="text-xs font-medium">{name}</div>
          {subtitle ? (
            <div className="text-[10px] uppercase tracking-[0.14em] text-stone-400">
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>

      <NodeHandle
        type="source"
        position={Position.Top}
        className="!bg-stone-900"
      />
    </div>
  );
}
