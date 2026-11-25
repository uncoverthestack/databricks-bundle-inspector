import { describe, expect, test } from "@jest/globals";
import { buildDisplayEdges, displayEdge, type FlowEdgeLike } from "../../../webview/lib/displayEdges.js";
import { UI_COLOR } from "../../../webview/lib/vscodeTheme.js";

// Issue 554: lines are grey at rest; only the selected task's own lines turn blue.
const line = (source: string, target: string, dashed = false): FlowEdgeLike => ({
  source,
  target,
  style: { stroke: UI_COLOR.muted, strokeWidth: 2, ...(dashed ? { strokeDasharray: "5 4" } : {}) },
  markerEnd: { type: "arrowclosed", color: UI_COLOR.muted },
});

const none = { selectedNodeId: null, focusedTaskIds: null, usesTaskIds: null };

describe("job graph lines (issue 554)", () => {
  const edges = [line("load", "is_weekday"), line("load", "missing_step"), line("is_weekday", "on_weekday"), line("is_weekday", "on_weekend", true)];

  test("at rest every line is the object it was built as, grey", () => {
    const shown = buildDisplayEdges(edges, none);
    shown.forEach((edge, i) => expect(edge).toBe(edges[i]));
  });

  test("a selected task's lines in and out turn blue; the rest keep their object", () => {
    const shown = buildDisplayEdges(edges, { ...none, selectedNodeId: "is_weekday" });
    const blue = shown.filter((edge) => edge.style?.stroke === UI_COLOR.accent).map((edge) => `${edge.source}->${edge.target}`);
    expect(blue).toEqual(["load->is_weekday", "is_weekday->on_weekday", "is_weekday->on_weekend"]);
    expect(shown[1]).toBe(edges[1]);
    expect((shown[0]!.markerEnd as { color: string }).color).toBe(UI_COLOR.accent);
  });

  test("a selected False line keeps its dashes and is not animated", () => {
    const shown = displayEdge(edges[3]!, { ...none, selectedNodeId: "on_weekend" });
    expect(shown.style?.strokeDasharray).toBe("5 4");
    expect(shown.animated).toBe(false);
  });

  test("the Issues filter still lights lines between lit tasks and fades the others", () => {
    const focus = { ...none, focusedTaskIds: new Set(["load", "missing_step"]) };
    const [between, out] = [displayEdge(edges[1]!, focus), displayEdge(edges[0]!, focus)];
    expect(between.style?.stroke).toBe(UI_COLOR.accent);
    expect(between.animated).toBe(true);
    expect(out.style?.opacity).toBe(0.18);
  });

  test("a Uses chip lights no line: sharing a warehouse doesn't link tasks", () => {
    const lit = new Set(["load", "missing_step"]);
    const shown = displayEdge(edges[1]!, { ...none, focusedTaskIds: lit, usesTaskIds: lit });
    expect(shown.style?.opacity).toBe(0.18);
  });

  test("the selected task's lines stay blue and visible under a filter", () => {
    const shown = displayEdge(edges[0]!, { selectedNodeId: "load", focusedTaskIds: new Set(["missing_step"]), usesTaskIds: null });
    expect(shown.style?.stroke).toBe(UI_COLOR.accent);
    expect(shown.style?.opacity).toBeUndefined();
  });
});
