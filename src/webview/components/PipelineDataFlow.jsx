import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { dataFlowColumns } from "../../bundle/pipelineDataFlow";
import { UI_COLOR } from "../lib/vscodeTheme";

const KIND_WORDS = {
  streaming_table: "streaming table",
  materialized_view: "materialized view",
  view: "view",
  table: "table",
  flow_target: "written by a flow",
  outside: "not in this pipeline",
  files: "files",
};
const UNREAD_SHOWN = 5;

const baseName = (file) => file.split(/[\\/]/).pop();

/**
 * A pipeline's data flow from its SQL (issue 398): what it reads from outside, the tables and
 * views it creates, and the lines between them. Nothing is guessed: names the inspector could
 * not read are listed with their file and line.
 */
export default function PipelineDataFlow({ flow, onOpenFile, resolveName }) {
  const [activeId, setActiveId] = useState(null);
  const [paths, setPaths] = useState([]);
  const [lineWidth, setLineWidth] = useState(0);
  const canvasRef = useRef(null);
  const boxes = useRef(new Map());
  const columns = useMemo(() => (flow ? dataFlowColumns(flow) : []), [flow]);
  const name = (value) => (resolveName ? resolveName(value) : value);
  const unreadInto = useMemo(() => {
    const counts = new Map();
    for (const item of flow?.unread ?? []) if (item.target) counts.set(item.target, (counts.get(item.target) ?? 0) + 1);
    return counts;
  }, [flow]);

  const linked = useMemo(() => {
    if (!activeId || !flow) return null;
    const ids = new Set([activeId]);
    for (const edge of flow.edges) {
      if (edge.from === activeId) ids.add(edge.to);
      if (edge.to === activeId) ids.add(edge.from);
    }
    return ids;
  }, [activeId, flow]);

  const register = useCallback((id, element) => {
    if (element) boxes.current.set(id, element);
    else boxes.current.delete(id);
  }, []);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !flow) return;
    const origin = canvas.getBoundingClientRect();
    const next = [];
    for (const edge of flow.edges) {
      const from = boxes.current.get(edge.from)?.getBoundingClientRect();
      const to = boxes.current.get(edge.to)?.getBoundingClientRect();
      if (!from || !to) continue;
      const x1 = from.right - origin.left + canvas.scrollLeft;
      const y1 = from.top + from.height / 2 - origin.top;
      const x2 = to.left - origin.left + canvas.scrollLeft;
      const y2 = to.top + to.height / 2 - origin.top;
      const middle = (x1 + x2) / 2;
      // Left to right; a read from a later column bends back around.
      const d = x2 > x1 + 8
        ? `M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}`
        : `M${x1} ${y1} C${x1 + 40} ${y1} ${x2 - 40} ${y2} ${x2} ${y2}`;
      next.push({ key: `${edge.from}->${edge.to}:${edge.flow ?? ""}`, d, from: edge.from, to: edge.to, streaming: edge.streaming });
    }
    setPaths(next);
    setLineWidth(canvas.scrollWidth);
  }, [flow]);

  useLayoutEffect(() => {
    measure();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [measure]);

  if (!flow) return null;
  const pythonFiles = flow.notRead.filter((file) => file.reason === "Python").length;
  const otherFiles = flow.notRead.length - pythonFiles;
  const notReadWords = [
    pythonFiles ? `${pythonFiles} Python file${pythonFiles === 1 ? "" : "s"}` : "",
    otherFiles ? `${otherFiles} notebook${otherFiles === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");

  return (
    <section className="flex flex-col gap-2" aria-label="Data flow" data-pipeline-data-flow>
      <h3 className="m-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-soft">Data flow · from SQL</h3>
      {flow.nodes.length === 0 ? (
        <p className="m-0 text-xs text-fg-soft">
          {flow.sqlFiles === 0
            ? "The data flow reads SQL sources, and this pipeline has none."
            : "No tables or views found in this pipeline's SQL."}
        </p>
      ) : (
        <div
          ref={canvasRef}
          data-data-flow-canvas
          className="relative overflow-x-auto rounded-xl border border-line p-4"
          onMouseLeave={() => setActiveId(null)}
        >
          <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-full" style={{ width: lineWidth || "100%" }}>
            {paths.map((path) => {
              const lit = linked && linked.has(path.from) && linked.has(path.to) && (path.from === activeId || path.to === activeId);
              return (
                <path
                  key={path.key}
                  d={path.d}
                  fill="none"
                  data-data-flow-link={path.key}
                  stroke={lit ? UI_COLOR.accent : UI_COLOR.boxLine}
                  strokeWidth={lit ? 1.75 : 1.25}
                  opacity={linked && !lit ? 0.3 : 1}
                />
              );
            })}
          </svg>
          <div className="relative flex items-start gap-12">
            {columns.map((column, index) => (
              <div key={index} className="flex w-56 shrink-0 flex-col gap-3">
                {column.map((node) => {
                  const outside = node.kind === "outside" || node.kind === "files";
                  const faded = linked && !linked.has(node.id);
                  return (
                    <div
                      key={node.id}
                      ref={(element) => register(node.id, element)}
                      data-data-flow-node={node.id}
                      data-data-flow-kind={node.kind}
                      tabIndex={0}
                      onMouseEnter={() => setActiveId(node.id)}
                      onFocus={() => setActiveId(node.id)}
                      onBlur={() => setActiveId(null)}
                      title={[name(node.name), KIND_WORDS[node.kind], node.maybeSameAs ? `May be the same as ${node.maybeSameAs}.` : ""].filter(Boolean).join("\n")}
                      className={`flex min-h-12 flex-col justify-center gap-0.5 rounded-xl border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent ${outside ? "border-dashed" : "border-solid"}`}
                      style={{
                        borderColor: activeId === node.id ? UI_COLOR.accent : UI_COLOR.boxLine,
                        backgroundColor: UI_COLOR.widget,
                        opacity: faded ? 0.45 : 1,
                      }}
                    >
                      {/* No type code: Databricks says "materialized view" and "streaming table",
                          never MV or ST, so the kind is written out on the line below. */}
                      <span className="min-w-0 truncate text-[13px] font-medium text-fg">{name(node.name)}</span>
                      <span className="flex min-w-0 items-baseline gap-2 text-[11px] text-muted">
                        <span className="truncate">
                          {node.maybeSameAs ? `may be the same as ${node.maybeSameAs}` : KIND_WORDS[node.kind]}
                          {node.pipelineOnly ? " · this pipeline only" : ""}
                        </span>
                        {!outside && node.line > 0 && (
                          <button
                            type="button"
                            data-data-flow-open={node.id}
                            onClick={() => onOpenFile?.(node.file, node.line)}
                            title={`Open ${baseName(node.file)} on the line that creates it`}
                            className="ml-auto shrink-0 text-link hover:text-link-active focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            {baseName(node.file)}:{node.line}
                          </button>
                        )}
                      </span>
                      {unreadInto.get(node.id) > 0 && (
                        <span className="text-[11px] text-muted" data-data-flow-unread-into>
                          {unreadInto.get(node.id)} {unreadInto.get(node.id) === 1 ? "read" : "reads"} could not be read
                        </span>
                      )}
                      {node.definedAgain && (
                        <span className="text-[11px] text-muted">
                          also created in {baseName(node.definedAgain.file)}:{node.definedAgain.line}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      {flow.unread.length > 0 && (
        <div data-data-flow-unread className="flex flex-col gap-1 rounded-xl border border-dashed border-line px-3 py-2 text-xs text-fg-soft">
          <span className="font-medium text-fg">
            {flow.unread.length} {flow.unread.length === 1 ? "name" : "names"} could not be read
          </span>
          {flow.unread.slice(0, UNREAD_SHOWN).map((item) => (
            <button
              key={`${item.file}:${item.line}:${item.reason}`}
              type="button"
              onClick={() => onOpenFile?.(item.file, item.line)}
              className="flex min-w-0 gap-2 text-left hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="shrink-0 text-link">{baseName(item.file)}:{item.line}</span>
              <span className="min-w-0 truncate">{item.reason}</span>
            </button>
          ))}
          {flow.unread.length > UNREAD_SHOWN && <span className="text-muted">and {flow.unread.length - UNREAD_SHOWN} more</span>}
        </div>
      )}
      {notReadWords && (
        <p className="m-0 text-[11px] text-muted" data-data-flow-not-read>
          Shows SQL only: {notReadWords} {flow.notRead.length === 1 ? "is" : "are"} not read yet.
        </p>
      )}
    </section>
  );
}
