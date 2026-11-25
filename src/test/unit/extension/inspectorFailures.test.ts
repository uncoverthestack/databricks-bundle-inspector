import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateBundleWithDependencies, BUNDLE_PROBE_TARGET, type BundleResult } from "../../../bundle/validateBundle.js";
import { cliDiagnosticsOf } from "../../../bundle/inspectBundle.js";
import { extractBundleGraph } from "../../../bundle/graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "../../../bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "../../../bundle/issues.js";

const bundle = { bundle: { name: "test" }, resources: { jobs: {} } };
const probeError = `Error: ${BUNDLE_PROBE_TARGET}: no such target. Available targets: dev`;
const validateExit = (code: number, stderr: string, signal?: string) => validateBundleWithDependencies("/b", undefined, {
  resolveDatabricksCli: async () => ({ ok: true, candidate: "databricks", versionOutput: "1.28.0" }),
  execFileAsync: async () => { throw Object.assign(new Error("CLI exit"), { code, stdout: JSON.stringify(bundle), stderr, ...(signal ? { signal } : {}) }); },
});

afterEach(() => { jest.restoreAllMocks(); });
describe("nonzero CLI exits", () => {
  test.each([
    [2, "panic: validation crashed"], [2, probeError], [2, "Error: cannot configure default credentials"],
    [1, "unexpected failure"],
  ])("exit %i is not made clean by valid stdout (%s)", async (code, stderr) => {
    expect((await validateExit(code, stderr)).ok).toBe(false);
  });
  test("the expected probe exit remains usable", async () => expect((await validateExit(1, probeError)).ok).toBe(true));
  test("intentional restricted-code coverage warnings remain usable", async () => {
    const result = await validateExit(1, "Error: running scripts is not allowed when DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION is set");
    expect(result.ok).toBe(true);
    expect(cliDiagnosticsOf(result)[0]?.message).toContain("were not run");
  });
  test("a crash does not become a restricted-code warning", async () => {
    expect((await validateExit(2, "Error: running scripts is not allowed when DATABRICKS_BUNDLE_RESTRICTED_CODE_EXECUTION is set")).ok).toBe(false);
  });
  test("a signal cannot be made successful by a probe message", async () => expect((await validateExit(1, probeError, "SIGSEGV")).ok).toBe(false));
});

describe("authentication diagnostics do not swallow other findings", () => {
  const warning = { severity: "warning" as const, message: "unknown field: typo", path: "databricks.yml", line: 3 };
  const auth = { severity: "warning" as const, message: "cannot configure default credentials" };
  const result = (diagnostics: typeof auth[]): Extract<BundleResult, { ok: true }> => ({ ok: true, data: bundle, issues: [{ code: "AUTH_NOT_CONFIGURED", message: "sign in", diagnostics }] });
  test("keeps the unrelated warning for both Problems and graph", () => {
    const mixed = result([auth, warning]);
    expect(cliDiagnosticsOf(mixed)).toEqual([warning]);
    expect(buildInspectorIssues({ nodes: [], edges: [] }, bundle, mixed.issues!, "/b").map((issue) => issue.kind)).toEqual(["unknown_or_deprecated_field"]);
  });
  test("a sign-in diagnostic alone stays hidden in both", () => {
    const only = result([auth]);
    expect(cliDiagnosticsOf(only)).toEqual([]);
    expect(buildInspectorIssues({ nodes: [], edges: [] }, bundle, only.issues!, "/b")).toEqual([]);
  });
  test("an unrelated error keeps its severity in an auth wrapper", async () => {
    const result = await validateExit(1, "Error: cannot configure default credentials\n\nError: unrelated failure\n  at databricks.yml:3:1\n");
    expect(result.ok).toBe(true);
    expect(cliDiagnosticsOf(result).some((d) => d.message.includes("unrelated failure") && d.severity === "error")).toBe(true);
  });
});

describe("failed notebook reads", () => {
  test("EACCES produces one task-owned coverage warning, then a readable control is clean", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dbi-failed-read-"));
    const file = path.join(root, "nb.py");
    try {
      await writeFile(file, "# Databricks notebook source\nprint(1)\n");
      const config = { bundle: { name: "read" }, resources: { jobs: { j: { tasks: [{ task_key: "t", notebook_task: { notebook_path: "./nb.py" } }] } } } };
      const graph = await extractBundleGraph(config, root);
      const original = fs.readFile;
      const spy = jest.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return original(...args);
      }) as typeof fs.readFile);
      const enriched = await enrichGraphWithFileContent(graph);
      const issues = buildInspectorIssues(enriched, config, [], root).filter((issue) => issue.kind === "file_scan_failed");
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: "warning", file, line: 1, taskName: "t" });
      expect(issues[0]!.detail).toContain("widget reads");
      spy.mockRestore();
      expect(buildInspectorIssues(await enrichGraphWithFileContent(graph), config, [], root).filter((issue) => issue.kind === "file_scan_failed")).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
