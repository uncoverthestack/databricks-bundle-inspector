import { describe, test, expect } from "@jest/globals";
import {
  parseSelectionValue,
  resolveSelection,
  selectionValue,
} from "../../../webview/lib/jobSelection.js";

const job = (key: string) => ({ group: "jobs" as const, key });
const pipeline = (key: string) => ({ group: "pipelines" as const, key });

describe("resolveSelection", () => {
  test("keeps the user's pick while the bundle has it", () => {
    expect(resolveSelection(["job-a", "job-b"], ["p"], job("job-b"), job("job-a"))).toEqual(job("job-b"));
    expect(resolveSelection(["job-a"], ["p"], pipeline("p"), job("job-a"))).toEqual(pipeline("p"));
  });

  test("falls back to what the extension asked for", () => {
    expect(resolveSelection(["job-a", "job-b"], [], job("job-missing"), job("job-b"))).toEqual(job("job-b"));
    expect(resolveSelection(["job-a"], ["p", "q"], undefined, pipeline("q"))).toEqual(pipeline("q"));
  });

  test("falls back to the first job, then the first pipeline", () => {
    expect(resolveSelection(["job-a", "job-b"], ["p"], job("gone"), pipeline("gone"))).toEqual(job("job-a"));
    expect(resolveSelection([], ["p", "q"], job("gone"), job("gone"))).toEqual(pipeline("p"));
  });

  test("a key in the other group doesn't count", () => {
    // A job and a pipeline may share a key; the group decides which one is meant.
    expect(resolveSelection(["shared"], ["other"], pipeline("shared"))).toEqual(job("shared"));
    expect(resolveSelection(["a"], ["shared"], job("shared"))).toEqual(job("a"));
  });

  test("gives nothing when the bundle has neither", () => {
    expect(resolveSelection([], [], job("a"), pipeline("b"))).toBeUndefined();
  });
});

describe("selectionValue", () => {
  test.each([job("ingest"), pipeline("bronze"), job("a:b"), pipeline(""), job("jobs:x")])(
    "reads back %j",
    (selection) => {
      expect(parseSelectionValue(selectionValue(selection))).toEqual(selection);
    },
  );

  test("rejects anything else", () => {
    expect(parseSelectionValue("ingest")).toBeUndefined();
    expect(parseSelectionValue("models:x")).toBeUndefined();
    expect(parseSelectionValue("")).toBeUndefined();
  });
});
