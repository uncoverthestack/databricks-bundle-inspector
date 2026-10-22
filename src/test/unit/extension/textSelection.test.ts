import { afterEach, describe, test, expect } from "@jest/globals";
import { contextMenuContext, hasTextSelection } from "../../../webview/lib/textSelection.js";

type FakeSelection = { isCollapsed: boolean; toString: () => string } | null;

function stubSelection(selection: FakeSelection) {
  (globalThis as unknown as { window: unknown }).window = {
    getSelection: () => selection,
  };
}

describe("hasTextSelection", () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  test("is true when the user has dragged over some text", () => {
    stubSelection({ isCollapsed: false, toString: () => 'Notebook reads widget "rdbms_type"' });
    expect(hasTextSelection()).toBe(true);
  });

  test("is false for a plain click, which leaves a collapsed selection", () => {
    stubSelection({ isCollapsed: true, toString: () => "" });
    expect(hasTextSelection()).toBe(false);
  });

  test("is false when only whitespace is selected", () => {
    stubSelection({ isCollapsed: false, toString: () => "  \n" });
    expect(hasTextSelection()).toBe(false);
  });

  test("is false when the browser has no selection object", () => {
    stubSelection(null);
    expect(hasTextSelection()).toBe(false);
  });
});

describe("contextMenuContext", () => {
  test("hides VS Code's Copy and shows ours when text is selected in the graph", () => {
    expect(contextMenuContext(false, "Git-sourced task path")).toEqual({
      preventDefaultContextMenuItems: true,
      bundleInspectorHasSelection: true,
    });
  });

  test("shows no Copy in the graph when nothing is selected", () => {
    expect(contextMenuContext(false, " ")).toEqual({
      preventDefaultContextMenuItems: true,
      bundleInspectorHasSelection: false,
    });
  });

  test("keeps VS Code's Cut, Copy and Paste in text boxes such as search", () => {
    expect(contextMenuContext(true, "orders")).toEqual({});
  });
});
