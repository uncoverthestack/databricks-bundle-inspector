import { describe, expect, test } from "@jest/globals";
import {
  buildDisplayNodes,
  buildDisplayVariants,
  focusStateOf,
  type DisplayFocus,
  type FlowNode,
} from "../../../webview/lib/displayNodes.js";

/** The job graph's boxes as App.jsx built them before #500, to check the rules did not change. */
function previousDisplayNodes(flowNodes: FlowNode[], focus: DisplayFocus) {
  return flowNodes.map((node) => {
    const selected = node.id === focus.selectedNodeId;
    const related = focus.focusedTaskIds?.has(node.id) ?? false;
    const issueMatched = focus.graphMode === "issues" && focus.issueTaskIds.has(node.id);
    return {
      ...node,
      selected,
      data: {
        ...node.data,
        focusState: focus.focusedTaskIds
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
  });
}

function flow(count: number): FlowNode[] {
  return Array.from({ length: count }, (_, i) => ({ id: `t${i}`, type: "task", data: { name: `t${i}`, kind: "notebook" } }));
}

function focus(over: Partial<DisplayFocus> = {}): DisplayFocus {
  return { selectedNodeId: null, focusedTaskIds: null, graphMode: "all", issueTaskIds: new Set(), ...over };
}

/** How many boxes are a different object in `after` than in `before`: what the graph redraws. */
function changedBoxes(before: unknown[], after: unknown[]): number {
  return after.filter((node, i) => node !== before[i]).length;
}

describe("job graph boxes (#500)", () => {
  test("give the same boxes as before for every selection, focus and mode", () => {
    const nodes = flow(6);
    const variants = buildDisplayVariants(nodes);
    const selections = [null, "t0", "t3", "missing"];
    const focusSets = [null, new Set<string>(), new Set(["t1", "t3"]), new Set(["t0", "t1", "t2", "t3", "t4", "t5"])];
    const issueSets = [new Set<string>(), new Set(["t2", "t3"])];
    let cases = 0;
    for (const selectedNodeId of selections) {
      for (const focusedTaskIds of focusSets) {
        for (const graphMode of ["all", "issues"]) {
          for (const issueTaskIds of issueSets) {
            const f = focus({ selectedNodeId, focusedTaskIds, graphMode, issueTaskIds });
            expect(buildDisplayNodes(nodes, variants, f)).toEqual(previousDisplayNodes(nodes, f));
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(64);
  });

  test("selecting a task in a 1,000-task job changes one box, and picking another changes two", () => {
    const nodes = flow(1000);
    const variants = buildDisplayVariants(nodes);
    const none = buildDisplayNodes(nodes, variants, focus());
    const first = buildDisplayNodes(nodes, variants, focus({ selectedNodeId: "t500" }));
    const second = buildDisplayNodes(nodes, variants, focus({ selectedNodeId: "t20" }));
    const cleared = buildDisplayNodes(nodes, variants, focus());

    expect(changedBoxes(none, first)).toBe(1);
    expect(changedBoxes(first, second)).toBe(2);
    expect(changedBoxes(second, cleared)).toBe(1);
    expect(changedBoxes(none, cleared)).toBe(0);
    expect(first[500]).toMatchObject({ id: "t500", selected: true });
    expect(second[500]).toMatchObject({ id: "t500", selected: false });
  });

  test("the same inputs again change only the selected box", () => {
    const nodes = flow(50);
    const variants = buildDisplayVariants(nodes);
    const f = focus({ selectedNodeId: "t7", focusedTaskIds: new Set(["t1", "t7"]) });
    expect(changedBoxes(buildDisplayNodes(nodes, variants, f), buildDisplayNodes(nodes, variants, f))).toBe(1);
  });

  test("a focus change, such as hovering a Uses chip, changes only the boxes whose focus changed", () => {
    const nodes = flow(100);
    const variants = buildDisplayVariants(nodes);
    const before = buildDisplayNodes(nodes, variants, focus({ focusedTaskIds: new Set(["t1", "t2", "t3"]) }));
    const after = buildDisplayNodes(nodes, variants, focus({ focusedTaskIds: new Set(["t3", "t4"]) }));
    // t1 and t2 go from related to dimmed, t4 from dimmed to related; the other 97 stay the same.
    expect(changedBoxes(before, after)).toBe(3);
    expect(after[4]?.data.focusState).toBe("related");
    expect(after[1]?.data.focusState).toBe("dimmed");
  });

  test("a new flow, such as another job or a new check result, gives new boxes", () => {
    const first = flow(10);
    const before = buildDisplayNodes(first, buildDisplayVariants(first), focus());
    const next = flow(10);
    expect(changedBoxes(before, buildDisplayNodes(next, buildDisplayVariants(next), focus()))).toBe(10);
  });

  test("focus states", () => {
    expect(focusStateOf("t1", focus())).toBe("normal");
    expect(focusStateOf("t1", focus({ selectedNodeId: "t1" }))).toBe("normal");
    expect(focusStateOf("t1", focus({ selectedNodeId: "t1", focusedTaskIds: new Set() }))).toBe("selected");
    expect(focusStateOf("t1", focus({ focusedTaskIds: new Set(["t1"]) }))).toBe("related");
    expect(focusStateOf("t1", focus({ focusedTaskIds: new Set(["t2"]) }))).toBe("dimmed");
    expect(focusStateOf("t1", focus({ focusedTaskIds: new Set(["t2"]), graphMode: "issues", issueTaskIds: new Set(["t1"]) }))).toBe("related");
  });
});
