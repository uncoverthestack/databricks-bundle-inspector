/**
 * One bundle's findings from a `bundle validate` result: the same steps for the Problems panel
 * and the command-line tool (#348), so the two never report different things.
 */

import type { BundleGraph, ParsedBundleConfig } from "./graph/bundleGraph.js";
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

/** The variables and targets a target's findings resolve against, and the targets a bundle has. */
export interface TargetResolution {
  targetOptions: string[];
  /** The structural preview to keep for the next target: this result when it lists targets, else the previous one. */
  structuralResolutionBundle: ParsedBundleConfig | undefined;
  /** This result's bundle name, its variables over the preview's, and its targets or the preview's. */
  resolutionBundle: ParsedBundleConfig;
}

/**
 * A real target's output has its variables resolved but may not list the bundle's targets,
 * so the structural preview fills in what it lacks. Shared by the graph's target picker and
 * the command-line tool's `--target` (#348).
 */
export function targetResolutionOf(
  bundleData: ParsedBundleConfig,
  resultTargetOptions: readonly string[] | undefined,
  previousTargetOptions: readonly string[],
  previousStructuralBundle: ParsedBundleConfig | undefined,
): TargetResolution {
  const discoveredTargetOptions =
    resultTargetOptions && resultTargetOptions.length > 0
      ? [...resultTargetOptions]
      : Object.keys((bundleData as { targets?: Record<string, unknown> }).targets ?? {});
  const targetOptions = discoveredTargetOptions.length > 0 ? discoveredTargetOptions : [...previousTargetOptions];
  const structuralResolutionBundle = discoveredTargetOptions.length > 0 ? bundleData : previousStructuralBundle;
  const previousResolutionBundle: Partial<ParsedBundleConfig> = structuralResolutionBundle ?? {};
  const mergedVariables = {
    ...(previousResolutionBundle.variables ?? {}),
    ...(bundleData.variables ?? {}),
  } as ParsedBundleConfig["variables"];
  const mergedTargets =
    (bundleData as { targets?: ParsedBundleConfig["targets"] }).targets ?? previousResolutionBundle.targets;
  const resolutionBundle: ParsedBundleConfig = {
    bundle: bundleData.bundle,
    ...(mergedVariables ? { variables: mergedVariables } : {}),
    ...(mergedTargets ? { targets: mergedTargets } : {}),
  };
  return { targetOptions, structuralResolutionBundle, resolutionBundle };
}

/**
 * Every finding for a bundle validated with a real target (or the preview, with no target),
 * checked against `resolutionBundle` (see {@link targetResolutionOf}).
 */
export async function inspectorFindingsAt(
  result: ValidatedBundle,
  bundleRoot: string,
  resolutionBundle: ParsedBundleConfig,
  target: string | undefined,
): Promise<{ graph: BundleGraph; issues: InspectorIssue[] }> {
  const graph = await checkedGraphOf(result, bundleRoot);
  const issues = buildInspectorIssues(
    graph,
    // The whole config, as the Problems panel's check has it: `sync` and `include` decide
    // the sync and include checks. Only variables and targets come from the merge.
    { ...result.data, ...resolutionBundle },
    result.issues ?? [],
    bundleRoot,
    target,
  );
  return { graph, issues };
}
