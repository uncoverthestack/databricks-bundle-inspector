import { describe, expect, test } from "@jest/globals";
import { isDrawnDependency, taskLevels, type DependencyEdge } from "../../../webview/lib/taskLevels.js";

/** `"a>b"` is an arrow from a to b: b depends on a. */
const edges = (...arrows: string[]): DependencyEdge[] =>
  arrows.map((arrow) => {
    const [source, target] = arrow.split(">");
    return { source: source!, target: target! };
  });

function drawn(taskIds: string[], arrows: DependencyEdge[]): string[] {
  const levels = taskLevels(taskIds, arrows);
  return arrows.filter((edge) => isDrawnDependency(edge, levels)).map((edge) => `${edge.source}>${edge.target}`);
}

describe("taskLevels", () => {
  test("a task's column is its longest run of upstream tasks", () => {
    const levels = taskLevels(["a", "b", "c", "d"], edges("a>b", "b>c", "a>c", "c>d"));
    expect(Object.fromEntries(levels)).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });
});

describe("isDrawnDependency", () => {
  test("a job without a loop draws every arrow", () => {
    expect(drawn(["a", "b", "c", "d"], edges("a>b", "a>c", "b>d", "c>d"))).toEqual(["a>b", "a>c", "b>d", "c>d"]);
  });

  test("two tasks waiting on each other draw one arrow, not the backwards one", () => {
    // 04-dependency-loop in the playground: clean waits on enrich, enrich waits on clean.
    expect(drawn(["clean", "enrich"], edges("enrich>clean", "clean>enrich"))).toEqual(["enrich>clean"]);
  });

  test("a three-task loop leaves out only the arrow that would point backwards", () => {
    expect(drawn(["a", "b", "c"], edges("c>a", "a>b", "b>c"))).toHaveLength(2);
  });

  test("a task waiting on itself draws no arrow", () => {
    expect(drawn(["a", "b"], edges("a>a", "a>b"))).toEqual(["a>b"]);
  });
});
