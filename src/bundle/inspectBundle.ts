/**
 * One bundle's findings from a `bundle validate` result: the same steps for the Problems panel
 * and the command-line tool (#348), so the two never report different things.
 */

import type { BundleGraph } from "./graph/bundleGraph.js";
import { enrichGraphWithFileContent } from "./graph/enrichGraph.js";
import { buildInspectorIssues, type InspectorIssue } from "./issues.js";
import { notebookHeaderRuleFor } from "./notebookFiles.js";
import type { BundleDiagnostic } from "./parseBundleDiagnostics.js";
import { extractBundleGraph, type BundleResult } from "./validateBundle.js";

export type ValidatedBundle = Extract<BundleResult, { ok: true }>;

/**
 * What the Databricks CLI itself reported. A missing sign-in is not a problem for the structural
 * preview, so it is left out.
 */
export function cliDiagnosticsOf(result: BundleResult): BundleDiagnostic[] {
  if (result.ok) {
    return (
      result.issues
        ?.filter((issue) => issue.code !== "AUTH_NOT_CONFIGURED")
        .flatMap((issue) => issue.diagnostics ?? []) ?? []
    );
  }
  return result.error.diagnostics ?? [];
}

/** The bundle's graph with its files read, as the inspector panel shows it. Throws when a step fails. */
export async function checkedGraphOf(result: ValidatedBundle, bundleRoot: string): Promise<BundleGraph> {
  return enrichGraphWithFileContent(
    await extractBundleGraph(result.data, bundleRoot, {
      notebookRule: notebookHeaderRuleFor(result.cliVersion),
      ...(result.cliVersion ? { cliVersion: result.cliVersion } : {}),
    }),
  );
}

/**
 * Every finding for a bundle the CLI validated: the inspector's checks, which already hold each
 * CLI diagnostic with its code. Throws when a step fails, so the caller decides what to show.
 */
export async function inspectorFindings(
  result: ValidatedBundle,
  bundleRoot: string,
): Promise<{ graph: BundleGraph; issues: InspectorIssue[] }> {
  const graph = await checkedGraphOf(result, bundleRoot);
  return { graph, issues: buildInspectorIssues(graph, result.data, result.issues ?? [], bundleRoot) };
}
