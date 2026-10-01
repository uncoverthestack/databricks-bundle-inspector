import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import path from "path";
import { validateBundle, extractBundleGraph } from "../bundle/validateBundle.js";
import type { BundleDiagnostic } from "../bundle/validateBundle.js";
import { enrichGraphWithFileContent } from "../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../bundle/issues.js";
import { getIncludedFiles, parseBundleIncludes } from "../bundle/bundleIncludes.js";
import type { BundleGraph } from "../bundle/graph/bundleGraph.js";

function toVsCodeDiagnostics(
  bundleDiagnostics: BundleDiagnostic[],
  bundleDir: string,
): Map<string, vscode.Diagnostic[]> {
  const map = new Map<string, vscode.Diagnostic[]>();
  const bundleLabel = path.basename(bundleDir);
  for (const d of bundleDiagnostics) {
    if (!d.path) continue;
    const absPath = path.resolve(bundleDir, d.path);
    const line = Math.max(0, (d.line ?? 1) - 1);
    const col = Math.max(0, (d.column ?? 1) - 1);
    const range = new vscode.Range(line, col, line, Number.MAX_SAFE_INTEGER);
    const severity =
      d.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(range, d.message, severity);
    diagnostic.source = `Databricks Bundle (${bundleLabel})`;
    const existing = map.get(absPath) ?? [];
    existing.push(diagnostic);
    map.set(absPath, existing);
  }
  return map;
}

function inspectorIssuesToVsCodeDiagnostics(
  issues: InspectorIssue[],
  bundleDir: string,
): Map<string, vscode.Diagnostic[]> {
  const map = new Map<string, vscode.Diagnostic[]>();
  const bundleLabel = path.basename(bundleDir);
  for (const issue of issues) {
    if (!issue.file) continue;
    const line = Math.max(0, (issue.line ?? 1) - 1);
    const column = Math.max(0, (issue.column ?? 1) - 1);
    const range = new vscode.Range(line, column, line, Number.MAX_SAFE_INTEGER);
    const severity =
      issue.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : issue.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
    const diagnostic = new vscode.Diagnostic(
      range,
      issue.detail ? `${issue.title}: ${issue.detail}` : issue.title,
      severity,
    );
    diagnostic.source = `Databricks Bundle Inspector (${bundleLabel})`;
    diagnostic.code = issue.kind;
    const existing = map.get(issue.file) ?? [];
    existing.push(diagnostic);
    map.set(issue.file, existing);
  }
  return map;
}

function extractDiagnostics(result: Awaited<ReturnType<typeof validateBundle>>): BundleDiagnostic[] {
  if (result.ok) {
    return (
      result.issues
        ?.filter((issue) => issue.code !== "AUTH_NOT_CONFIGURED")
        .flatMap((i) => i.diagnostics ?? []) ?? []
    );
  }
  return result.error.diagnostics ?? [];
}

export type BundleValidationResult = Awaited<ReturnType<typeof validateBundle>>;

// Files that got diagnostics on the last run, per bundle root, so they are cleared
// once fixed. Issues found in code land on notebooks and files, not only bundle YAML.
const diagnosticFilesByBundle = new Map<string, Set<string>>();

/**
 * Updates diagnostics for one bundle root from an existing validation result.
 *
 * Diagnostics are updated per-file so existing entries for files not in the new
 * result are cleared and stale errors do not linger after a fix.
 *
 * @returns The bundle graph read for the issues, or `undefined` when validation failed.
 */
export async function updateBundleDiagnostics(
  result: BundleValidationResult,
  bundleRoot: string,
  collection: vscode.DiagnosticCollection,
  fileToBundleRoot: Map<string, string>,
): Promise<BundleGraph | undefined> {
  // Update the include map with CLI-resolved paths
  if (result.ok) {
    for (const included of result.data.include ?? []) {
      fileToBundleRoot.set(path.resolve(bundleRoot, included), bundleRoot);
    }
  }

  // Collect files previously tracked for this bundle so we can clear stale ones
  const prevFiles = new Set([
    ...[...fileToBundleRoot.entries()]
      .filter(([, root]) => root === bundleRoot)
      .map(([f]) => f),
    ...(diagnosticFilesByBundle.get(bundleRoot) ?? []),
  ]);

  const fresh = toVsCodeDiagnostics(extractDiagnostics(result), bundleRoot);
  let graph: BundleGraph | undefined;
  if (result.ok) {
    try {
      // Read file contents as the inspector panel does, so issues found in code
      // (e.g. a secret scope named by its resource key) also reach the Problems panel.
      graph = await enrichGraphWithFileContent(
        await extractBundleGraph(result.data, bundleRoot),
      );
      const inspectorIssues = buildInspectorIssues(
        graph,
        result.data,
        result.issues ?? [],
        bundleRoot,
      );
      const inspectorDiagnostics = inspectorIssuesToVsCodeDiagnostics(
        inspectorIssues,
        bundleRoot,
      );
      for (const [absPath, diagnostics] of inspectorDiagnostics) {
        fresh.set(absPath, [...(fresh.get(absPath) ?? []), ...diagnostics]);
      }
    } catch (err) {
      console.warn(
        `[BundleInspector] issue diagnostics failed for ${bundleRoot}:`,
        err,
      );
    }
  }

  // Clear stale diagnostics for files that are clean now
  for (const f of prevFiles) {
    if (!fresh.has(f)) {
      collection.delete(vscode.Uri.file(f));
    }
  }

  // Set new diagnostics
  for (const [absPath, diags] of fresh) {
    collection.set(vscode.Uri.file(absPath), diags);
  }
  diagnosticFilesByBundle.set(bundleRoot, new Set(fresh.keys()));
  return graph;
}

/**
 * Runs bundle validate for a single bundle root and updates diagnostics for
 * files that belong to that bundle.
 */
export async function runBundleDiagnostics(
  bundleRoot: string,
  configuredCliPath: string | undefined,
  collection: vscode.DiagnosticCollection,
  fileToBundleRoot: Map<string, string>,
): Promise<{ result: BundleValidationResult; graph: BundleGraph | undefined }> {
  const result = await validateBundle(bundleRoot, undefined, configuredCliPath);
  const graph = await updateBundleDiagnostics(
    result,
    bundleRoot,
    collection,
    fileToBundleRoot,
  );
  return { result, graph };
}

/** The raw `include` patterns of a bundle, read from its `databricks.yml`. */
export async function readIncludePatterns(bundleRoot: string): Promise<string[]> {
  for (const fileName of ["databricks.yml", "databricks.yaml"]) {
    try {
      return parseBundleIncludes(
        await readFile(path.join(bundleRoot, fileName), "utf-8"),
      );
    } catch {
      // Try the alternate bundle filename.
    }
  }
  return [];
}

/**
 * Tracks the inspected bundle file and its declared includes so saves can refresh
 * diagnostics without scanning unrelated bundle YAML files in the workspace.
 */
export async function trackBundleFiles(
  bundleRoot: string,
  fileToBundleRoot: Map<string, string>,
): Promise<void> {
  for (const fileName of ["databricks.yml", "databricks.yaml"]) {
    const bundlePath = path.join(bundleRoot, fileName);
    try {
      await readFile(bundlePath, "utf-8");
      fileToBundleRoot.set(bundlePath, bundleRoot);
      const included = await getIncludedFiles(bundlePath);
      for (const f of included) {
        fileToBundleRoot.set(f, bundleRoot);
      }
    } catch {
      // Ignore the alternate bundle filename when it is not present.
    }
  }
}
