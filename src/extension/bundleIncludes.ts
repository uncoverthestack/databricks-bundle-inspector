import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { parse } from "yaml";

/**
 * Extracts the `include` glob array from raw databricks.yml content.
 *
 * @param content Raw text content of a `databricks.yml` or `databricks.yaml` file.
 * @returns Array of glob patterns from the `include` key, or `[]` if absent or malformed.
 */
export function parseBundleIncludes(content: string): string[] {
  const parsed = parse(content) as { include?: unknown } | null;
  if (!Array.isArray(parsed?.include)) return [];
  return parsed.include.filter((v): v is string => typeof v === "string");
}

/**
 * Resolves include glob patterns relative to a bundle root to absolute file paths.
 *
 * @param bundleRoot Absolute path to the directory containing `databricks.yml`.
 * @param patterns Array of glob patterns as read from the `include` key.
 * @returns Absolute paths of all files matched by the given patterns.
 */
export async function resolveIncludes(
  bundleRoot: string,
  patterns: string[],
): Promise<string[]> {
  const results: string[] = [];
  for (const pattern of patterns) {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(bundleRoot, pattern),
    );
    results.push(...uris.map((u) => u.fsPath));
  }
  return results;
}

/**
 * Reads a databricks.yml and returns the absolute paths of all files it includes,
 * using a cheap YAML parse + glob resolution (no CLI required).
 *
 * @param bundleYmlPath Absolute path to the `databricks.yml` or `databricks.yaml` file.
 * @returns Absolute paths of all resolved include files, or `[]` if the file
 *   cannot be read or has no `include` key.
 */
export async function getIncludedFiles(bundleYmlPath: string): Promise<string[]> {
  const bundleRoot = path.dirname(bundleYmlPath);
  try {
    const content = await fs.readFile(bundleYmlPath, "utf8");
    const patterns = parseBundleIncludes(content);
    return resolveIncludes(bundleRoot, patterns);
  } catch {
    return [];
  }
}
