import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as vscode from "vscode";
import path from "node:path";
import * as inspector from "../../../bundle/inspectBundle.js";
import * as issues from "../../../bundle/issues.js";
import * as validation from "../../../bundle/validateBundle.js";
import {
  beginBundleDiagnosticCheck, bundleLoadedFiles, bundleProblemCount, completeCheckFindings,
  forgetBundleDiagnostics, runBundleDiagnostics, updateBundleDiagnostics,
} from "../../../extension/diagnostics.js";

jest.mock("vscode", () => ({
  ...jest.requireActual<Record<string, unknown>>("../../__mocks__/vscode.ts"),
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(line: number, character: number, endLine: number, endCharacter: number) {
      this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
    }
  },
  Diagnostic: class {
    constructor(public range: unknown, public message: string, public severity: number) {}
  },
}));

const root = path.resolve(path.sep, "test", "failure-bundle");
const file = path.join(root, "databricks.yml");
const shown = new Map<string, vscode.Diagnostic[]>();
const collection = {
  set: (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) => shown.set(uri.fsPath, diagnostics),
  delete: (uri: vscode.Uri) => shown.delete(uri.fsPath),
  get: (uri: vscode.Uri) => shown.get(uri.fsPath),
} as unknown as vscode.DiagnosticCollection;
const result = (name = "warning"): Extract<validation.BundleResult, { ok: true }> => ({ ok: true, data: { bundle: { name }, include: [`${name}.yml`] } });
const warning = (name: string): issues.InspectorIssue => ({ id: name, kind: "missing_file", severity: "warning", title: name, file, line: 2 });
const messages = () => (shown.get(file) ?? []).map((d) => d.message);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { resolve, promise };
};

beforeEach(() => {
  jest.spyOn(inspector, "checkedGraphOf").mockResolvedValue({ nodes: [], edges: [] });
  jest.spyOn(issues, "buildInspectorIssues").mockImplementation((_graph, data) => [warning(data.bundle.name ?? "warning")]);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  forgetBundleDiagnostics(root, collection);
  shown.clear();
  jest.restoreAllMocks();
});

describe("incomplete findings do not become a clean check", () => {
  test("a thrown checker keeps earlier findings marked out of date, with one failure", async () => {
    await updateBundleDiagnostics(result("old warning"), root, collection, new Map());
    jest.mocked(issues.buildInspectorIssues).mockImplementation(() => { throw new Error("private source contents"); });
    await updateBundleDiagnostics(result("new"), root, collection, new Map());
    expect(messages()).toContain("Out of date: old warning");
    expect(messages().filter((m) => m.includes("could not finish"))).toHaveLength(1);
    expect(bundleProblemCount(root).errors).toBe(1);
    expect(completeCheckFindings(root)).toBeUndefined();
    expect(JSON.stringify(shown.get(file))).not.toContain("private source contents");
    await updateBundleDiagnostics(result("new"), root, collection, new Map());
    expect(messages().filter((m) => m.includes("could not finish"))).toHaveLength(1);
    expect(messages().filter((m) => m.startsWith("Out of date: Out of date:"))).toHaveLength(0);
  });
  test("a first failed scan is visible even without any earlier findings", async () => {
    jest.mocked(inspector.checkedGraphOf).mockRejectedValue(new Error("failed"));
    await updateBundleDiagnostics(result(), root, collection, new Map());
    expect(messages()).toHaveLength(1);
    expect(bundleProblemCount(root).errors).toBe(1);
  });
  test("a successful retry replaces stale findings and restores complete results", async () => {
    await updateBundleDiagnostics(result("old"), root, collection, new Map());
    jest.mocked(inspector.checkedGraphOf).mockRejectedValueOnce(new Error("failed"));
    await updateBundleDiagnostics(result(), root, collection, new Map());
    await updateBundleDiagnostics(result("fixed"), root, collection, new Map());
    expect(messages()).toEqual(["fixed"]);
    expect(completeCheckFindings(root)?.map((i) => i.title)).toEqual(["fixed"]);
  });
  test("an unexplained CLI failure has a visible diagnostic", async () => {
    await updateBundleDiagnostics({ ok: false, error: { bundleDir: root, bundleName: "test", error: "Failed to validate Databricks bundle.", errorCode: "VALIDATION_FAILED" } }, root, collection, new Map());
    expect(messages()).toEqual(["Failed to validate Databricks bundle."]);
    expect(bundleProblemCount(root).errors).toBe(1);
  });
});

describe("the newest requested check owns findings", () => {
  test("a slow earlier file scan cannot overwrite newer findings or loaded files", async () => {
    const slow = deferred<Awaited<ReturnType<typeof inspector.checkedGraphOf>>>();
    jest.mocked(inspector.checkedGraphOf).mockReturnValueOnce(slow.promise);
    const old = updateBundleDiagnostics(result("old"), root, collection, new Map());
    await updateBundleDiagnostics(result("new"), root, collection, new Map());
    slow.resolve({ nodes: [], edges: [] });
    await old;
    expect(messages()).toEqual(["new"]);
    expect(completeCheckFindings(root)?.map((i) => i.title)).toEqual(["new"]);
    expect([...bundleLoadedFiles().get(root)!]).toEqual([path.join(root, "new.yml")]);
  });
  test("a slow earlier CLI cannot get a newer revision when it finally finishes", async () => {
    const slow = deferred<validation.BundleResult>();
    jest.spyOn(validation, "validateBundle").mockReturnValueOnce(slow.promise).mockResolvedValueOnce(result("new"));
    const old = runBundleDiagnostics(root, undefined, collection, new Map());
    await runBundleDiagnostics(root, undefined, collection, new Map());
    slow.resolve(result("old"));
    expect((await old).current).toBe(false);
    expect(messages()).toEqual(["new"]);
  });
  test("a late exception from an older scan does not stale newer findings", async () => {
    const slow = deferred<Awaited<ReturnType<typeof inspector.checkedGraphOf>>>();
    jest.mocked(inspector.checkedGraphOf).mockReturnValueOnce(slow.promise);
    const old = updateBundleDiagnostics(result("old"), root, collection, new Map());
    await updateBundleDiagnostics(result("new"), root, collection, new Map());
    slow.resolve({ nodes: [], edges: [] });
    jest.mocked(issues.buildInspectorIssues).mockImplementation(() => { throw new Error("old checker"); });
    await old;
    expect(messages()).toEqual(["new"]);
    expect(completeCheckFindings(root)).toHaveLength(1);
  });
  test("forgetting a bundle invalidates an in-flight check", async () => {
    const check = beginBundleDiagnosticCheck(root);
    forgetBundleDiagnostics(root, collection);
    await updateBundleDiagnostics(result("forgotten"), root, collection, new Map(), check);
    expect(messages()).toEqual([]);
    expect(bundleLoadedFiles().has(root)).toBe(false);
  });
});


describe("CLI diagnostics during incomplete checks", () => {
  const withCliWarning = () => {
    const checked = result("old");
    checked.issues = [{ code: "BUNDLE_DIAGNOSTICS", message: "warnings", diagnostics: [{ severity: "warning" as const, message: "unknown field: typo", path: "databricks.yml", line: 3 }] }];
    return checked;
  };
  test("a failed CLI check still shows an error when it also produced a file warning", async () => {
    await updateBundleDiagnostics({ ok: false, error: {
      bundleDir: root, bundleName: "test", error: "Failed to validate Databricks bundle.", errorCode: "VALIDATION_FAILED",
      diagnostics: [{ severity: "warning", message: "unknown field: typo", path: "databricks.yml", line: 2 }],
    } }, root, collection, new Map());
    expect(messages()).toEqual(["unknown field: typo", "Failed to validate Databricks bundle."]);
    expect(bundleProblemCount(root)).toMatchObject({ errors: 1, problems: 2 });
  });
  test("an existing CLI error does not get a duplicate generic failure", async () => {
    await updateBundleDiagnostics({ ok: false, error: {
      bundleDir: root, bundleName: "test", error: "Failed to validate Databricks bundle.", errorCode: "VALIDATION_FAILED",
      diagnostics: [{ severity: "error", message: "invalid configuration", path: "databricks.yml", line: 2 }],
    } }, root, collection, new Map());
    expect(messages()).toEqual(["invalid configuration"]);
    expect(bundleProblemCount(root).errors).toBe(1);
  });
  test("repeated checker failures do not accumulate copies of a current CLI warning", async () => {
    await updateBundleDiagnostics(withCliWarning(), root, collection, new Map());
    jest.mocked(issues.buildInspectorIssues).mockImplementation(() => { throw new Error("checker failed"); });
    for (let i = 0; i < 3; i++) {
      await updateBundleDiagnostics(withCliWarning(), root, collection, new Map());
      expect(messages().filter((message) => message.includes("unknown field: typo"))).toHaveLength(1);
      expect(messages()).toContain("Out of date: old");
      expect(messages().filter((message) => message.includes("could not finish"))).toHaveLength(1);
    }
  });
});

test("distinct tasks keep their old findings when they share one YAML location", async () => {
  jest.mocked(issues.buildInspectorIssues).mockReturnValueOnce([
    { ...warning("shared finding"), taskName: "first" },
    { ...warning("shared finding"), id: "second", taskName: "second" },
  ]);
  await updateBundleDiagnostics(result(), root, collection, new Map());
  jest.mocked(issues.buildInspectorIssues).mockImplementation(() => { throw new Error("checker failed"); });
  await updateBundleDiagnostics(result(), root, collection, new Map());
  expect(messages().filter((message) => message === "Out of date: shared finding")).toHaveLength(2);
});
