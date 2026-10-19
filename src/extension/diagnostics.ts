import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import path from "path";
import { existsSync } from "node:fs";
import { BUNDLE_FILE_NAMES } from "../bundle/includeFiles.js";
import { validateBundle, extractBundleGraph } from "../bundle/validateBundle.js";
import type { BundleDiagnostic } from "../bundle/validateBundle.js";
import { enrichGraphWithFileContent } from "../bundle/graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "../bundle/issues.js";
import { getIncludedFiles, parseBundleIncludes } from "../bundle/bundleIncludes.js";
import type { BundleGraph } from "../bundle/graph/bundleGraph.js";
import { forgetBundleFixes, setBundleFixes, type StoredFix } from "./quickFixes.js";
import { issueDocsUrl } from "../bundle/issueDocs.js";
import type { InspectorIssueKind } from "../bundle/issues.js";

// The installed version, so a code links to the docs of the behaviour the user has.
let docsVersion: string | undefined;
export function setIssueDocsVersion(version: string | undefined): void {
  docsVersion = version;
}

/** A finding's code in the Problems panel: its name, linked to its section in the docs. */
function linkedCode(kind: InspectorIssueKind): { value: string; target: vscode.Uri } {
  return { value: kind, target: vscode.Uri.parse(issueDocsUrl(kind, docsVersion)) };
}

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
    diagnostic.code = linkedCode("cli_diagnostic");
    const existing = map.get(absPath) ?? [];
    existing.push(diagnostic);
    map.set(absPath, existing);
  }
  return map;
}

function inspectorIssuesToVsCodeDiagnostics(
  issues: InspectorIssue[],
  bundleDir: string,
  fixes: Map<string, StoredFix[]>,
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
    diagnostic.code = linkedCode(issue.kind);
    if (issue.fix) {
      const key = vscode.Uri.file(issue.file).toString();
      const fileFixes = fixes.get(key) ?? [];
      fileFixes.push({ ...issue.fix, kind: issue.kind, line, column: issue.column, message: diagnostic.message });
      fixes.set(key, fileFixes);
    }
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

// The files each bundle's last successful check loaded, from the CLI's own list: the
// bundle file and every file `include` selected. Not VS Code's file search, which follows
// other glob rules and files.exclude.
const loadedFilesByBundle = new Map<string, Set<string>>();

/** What {@link loadedFilesByBundle} holds, for finding the bundle of an open file. */
export function bundleLoadedFiles(): ReadonlyMap<string, ReadonlySet<string>> {
  return loadedFilesByBundle;
}

// Issues with no file to point at (an unresolved variable, a CLI error about the bundle
// as a whole). They cannot go in the Problems panel and show only in the graph.
const graphOnlyByBundle = new Map<string, { problems: number; notes: number }>();

/**
 * What the last check of one bundle found: errors and warnings (`problems`), and
 * information-level entries (`notes`). `graphOnly` says how many of them have no file
 * to point at, so they are in the graph but not in the Problems panel.
 */
export function bundleProblemCount(
  bundleRoot: string,
  collection: vscode.DiagnosticCollection,
): { problems: number; notes: number; graphOnly: number } {
  const graphOnly = graphOnlyByBundle.get(bundleRoot) ?? { problems: 0, notes: 0 };
  const count = {
    problems: graphOnly.problems,
    notes: graphOnly.notes,
    graphOnly: graphOnly.problems + graphOnly.notes,
  };
  for (const file of diagnosticFilesByBundle.get(bundleRoot) ?? []) {
    for (const diagnostic of collection.get(vscode.Uri.file(file)) ?? []) {
      if (
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning
      ) {
        count.problems++;
      } else {
        count.notes++;
      }
    }
  }
  return count;
}

/** Clears what a bundle put in the Problems panel, for a bundle that is gone. */
export function forgetBundleDiagnostics(
  bundleRoot: string,
  collection: vscode.DiagnosticCollection,
): void {
  for (const file of diagnosticFilesByBundle.get(bundleRoot) ?? []) {
    collection.delete(vscode.Uri.file(file));
  }
  diagnosticFilesByBundle.delete(bundleRoot);
  graphOnlyByBundle.delete(bundleRoot);
  loadedFilesByBundle.delete(bundleRoot);
  forgetBundleFixes(bundleRoot);
}

/**
 * What the last checks of several bundles found together, as the Problems panel shows
 * it: a file two bundles report on (nested bundles) counts once, with the diagnostics it
 * holds now. Issues with no file are added per bundle.
 */
export function folderProblemCount(
  bundleRoots: Iterable<string>,
  collection: vscode.DiagnosticCollection,
): { problems: number; notes: number; graphOnly: number } {
  const count = { problems: 0, notes: 0, graphOnly: 0 };
  const files = new Set<string>();
  for (const root of bundleRoots) {
    const graphOnly = graphOnlyByBundle.get(root) ?? { problems: 0, notes: 0 };
    count.problems += graphOnly.problems;
    count.notes += graphOnly.notes;
    count.graphOnly += graphOnly.problems + graphOnly.notes;
    for (const file of diagnosticFilesByBundle.get(root) ?? []) files.add(file);
  }
  for (const file of files) {
    for (const diagnostic of collection.get(vscode.Uri.file(file)) ?? []) {
      if (
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning
      ) {
        count.problems++;
      } else {
        count.notes++;
      }
    }
  }
  return count;
}

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
    const loaded = new Set<string>();
    for (const included of result.data.include ?? []) {
      fileToBundleRoot.set(path.resolve(bundleRoot, included), bundleRoot);
      loaded.add(path.resolve(bundleRoot, included));
    }
    const bundleFile = BUNDLE_FILE_NAMES.map((name) => path.join(bundleRoot, name)).find((file) => existsSync(file));
    if (bundleFile) loaded.add(bundleFile);
    loadedFilesByBundle.set(bundleRoot, loaded);
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
  const fixes = new Map<string, StoredFix[]>();
  // When validation failed, what the CLI reported without a file is all there is.
  const graphOnly = {
    problems: result.ok ? 0 : extractDiagnostics(result).filter((d) => !d.path).length,
    notes: 0,
  };
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
        fixes,
      );
      // The inspector's issues already hold every CLI diagnostic, with its code, so
      // the CLI's own copies would show each message twice.
      fresh.clear();
      for (const [absPath, diagnostics] of inspectorDiagnostics) {
        fresh.set(absPath, diagnostics);
      }
      for (const issue of inspectorIssues) {
        if (issue.file) continue;
        if (issue.severity === "error" || issue.severity === "warning") graphOnly.problems++;
        else graphOnly.notes++;
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
  graphOnlyByBundle.set(bundleRoot, graphOnly);
  setBundleFixes(bundleRoot, fixes);
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
