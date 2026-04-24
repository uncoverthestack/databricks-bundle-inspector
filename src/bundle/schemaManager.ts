import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);

const WORKSPACE_SCHEMA_OUTPUT = ".vscode/databricks-bundle-schema.json";
const LOCAL_SCHEMA_FILENAME = "databricks-bundle-schema.json";

/**
 * Full pipeline: parse includes → resolve files → fetch CLI schema →
 * write schema → register it in yaml.schemas for all bundle files.
 *
 * Validation is delegated entirely to the Red Hat YAML extension via
 * `yaml.schemas`. No in-process diagnostics are produced here.
 */
export async function setupBundleSchema(
  bundleYmlPath: string,
  cliPath: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const bundleRoot = path.dirname(bundleYmlPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(bundleYmlPath),
  );
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? bundleRoot;

  const storageMode = vscode.workspace
    .getConfiguration("databricksBundleInspector")
    .get<"workspace" | "local">("schemaStorage", "workspace");

  const includes = parseBundleIncludes(
    await fs.readFile(bundleYmlPath, "utf8"),
  );
  const includedFiles = await resolveIncludes(bundleRoot, includes);

  const cliSchema = await runBundleSchema(cliPath, bundleRoot);
  const mergedSchema = applyStrictOverlay(cliSchema);

  let schemaAbsPath: string;
  if (storageMode === "local") {
    const storageUri = context.storageUri ?? context.globalStorageUri;
    await fs.mkdir(storageUri.fsPath, { recursive: true });
    schemaAbsPath = path.join(storageUri.fsPath, LOCAL_SCHEMA_FILENAME);
  } else {
    schemaAbsPath = path.join(workspaceRoot, WORKSPACE_SCHEMA_OUTPUT);
    await fs.mkdir(path.join(workspaceRoot, ".vscode"), { recursive: true });
  }

  await fs.writeFile(schemaAbsPath, JSON.stringify(mergedSchema, null, 2));

  await updateYamlSchemas(
    workspaceRoot,
    schemaAbsPath,
    storageMode,
    [bundleYmlPath, ...includedFiles],
  );
}

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

async function resolveIncludes(
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

async function runBundleSchema(cliPath: string, cwd: string): Promise<object> {
  const { stdout } = await execFileAsync(cliPath, ["bundle", "schema"], {
    cwd,
    timeout: 15_000,
  });
  return JSON.parse(stdout) as object;
}

// TODO: deep-merge with bundled strict overlay schema to add
// additionalProperties: false constraints for typo detection.
function applyStrictOverlay(cliSchema: object): object {
  return cliSchema;
}

async function updateYamlSchemas(
  workspaceRoot: string,
  schemaAbsPath: string,
  storageMode: "workspace" | "local",
  filePaths: string[],
): Promise<void> {
  const schemaKey =
    storageMode === "local"
      ? vscode.Uri.file(schemaAbsPath).toString()
      : path.relative(workspaceRoot, schemaAbsPath);
  const fileValues = filePaths.map((f) => path.relative(workspaceRoot, f));

  const settingsPath = path.join(workspaceRoot, ".vscode", "settings.json");

  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    // Strip JSONC comments before parsing — settings.json allows them
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    settings = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    // File absent or unparseable — start fresh
  }

  const existing = (settings["yaml.schemas"] as Record<string, unknown>) ?? {};
  settings["yaml.schemas"] = { ...existing, [schemaKey]: fileValues };

  await fs.mkdir(path.join(workspaceRoot, ".vscode"), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}
