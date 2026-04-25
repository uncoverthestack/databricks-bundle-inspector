import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "path";
import { validateBundle } from "./bundle/validateBundle.js";
import type { BundleDiagnostic } from "./bundle/validateBundle.js";
import {
  getConfiguration,
  getConfiguredDatabricksCliPath,
} from "./databricksCli/config.js";
import { getBundleDirFromEditor } from "./bundle/bundleContext.js";
import { getIncludedFiles } from "./bundle/bundleIncludes.js";

const BUNDLE_YML_RE = /databricks\.ya?ml$/;

function toVsCodeDiagnostics(
  bundleDiagnostics: BundleDiagnostic[],
  bundleDir: string,
): Map<string, vscode.Diagnostic[]> {
  const map = new Map<string, vscode.Diagnostic[]>();
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
    diagnostic.source = "Databricks Bundle";
    const existing = map.get(absPath) ?? [];
    existing.push(diagnostic);
    map.set(absPath, existing);
  }
  return map;
}

function extractDiagnostics(result: Awaited<ReturnType<typeof validateBundle>>): BundleDiagnostic[] {
  if (result.ok) {
    return result.issues?.flatMap((i) => i.diagnostics ?? []) ?? [];
  }
  return result.error.diagnostics ?? [];
}

/**
 * Runs bundle validate for a single bundle root, updates diagnostics for all
 * affected files, and refreshes the fileToBundleRoot map with the resolved includes.
 *
 * Diagnostics are updated per-file — existing entries for files not in the new
 * result are cleared so stale errors don't linger after a fix.
 */
async function runBundleDiagnostics(
  bundleRoot: string,
  configuredCliPath: string | undefined,
  collection: vscode.DiagnosticCollection,
  fileToBundleRoot: Map<string, string>,
): Promise<void> {
  const result = await validateBundle(bundleRoot, undefined, configuredCliPath);

  // Update the include map with CLI-resolved paths
  if (result.ok) {
    for (const included of result.data.include ?? []) {
      fileToBundleRoot.set(path.resolve(bundleRoot, included), bundleRoot);
    }
  }

  // Collect files previously tracked for this bundle so we can clear stale ones
  const prevFiles = new Set(
    [...fileToBundleRoot.entries()]
      .filter(([, root]) => root === bundleRoot)
      .map(([f]) => f),
  );

  const fresh = toVsCodeDiagnostics(extractDiagnostics(result), bundleRoot);

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
}

/**
 * Builds the fileToBundleRoot map cheaply (YAML parse + glob, no CLI) for all
 * discovered databricks.yml files. This runs on activation so that opening an
 * included file is recognised immediately without waiting for a CLI call.
 */
async function buildIncludeMap(
  fileToBundleRoot: Map<string, string>,
): Promise<void> {
  const bundleFiles = await vscode.workspace.findFiles(
    "**/databricks.{yml,yaml}",
    "{node_modules,dist,out}/**",
  );

  await Promise.all(
    bundleFiles.map(async (uri) => {
      const bundleRoot = path.dirname(uri.fsPath);
      fileToBundleRoot.set(uri.fsPath, bundleRoot);
      const included = await getIncludedFiles(uri.fsPath);
      for (const f of included) {
        fileToBundleRoot.set(f, bundleRoot);
      }
    }),
  );
}

function getWebviewPaths(extensionUri: vscode.Uri) {
  const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  return {
    webviewRoot,
    htmlPath: path.join(webviewRoot.fsPath, "index.html"),
  };
}

function createNonce(): string {
  return randomBytes(16).toString("hex");
}

function getCspMetaTag(webview: vscode.Webview, nonce: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; connect-src 'none';">`;
}

async function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): Promise<string> {
  const { webviewRoot, htmlPath } = getWebviewPaths(extensionUri);
  const nonce = createNonce();

  let html = await readFile(htmlPath, "utf-8");

  // Replace relative paths with webview URIs
  html = html.replace(/href="\/([^"]+)"/g, (_match, filePath) => {
    const fileUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewRoot, filePath),
    );
    return `href="${fileUri}"`;
  });

  html = html.replace(/src="\/([^"]+)"/g, (_match, filePath) => {
    const fileUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewRoot, filePath),
    );
    return `src="${fileUri}" nonce="${nonce}"`;
  });

  html = html.replace("</head>", `${getCspMetaTag(webview, nonce)}</head>`);

  return html;
}

export function activate(extensionContext: vscode.ExtensionContext) {
  console.log('Extension "databricks-bundle-inspector" is now active!');

  const diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "databricks-bundle-inspector",
  );
  extensionContext.subscriptions.push(diagnosticCollection);

  const configuredCliPath = getConfiguredDatabricksCliPath(getConfiguration());

  // Maps every bundle-related file (databricks.yml + all includes) to its bundle root.
  // Built cheaply on activation via YAML parse; kept up-to-date after each CLI run.
  const fileToBundleRoot = new Map<string, string>();
  void buildIncludeMap(fileToBundleRoot);

  function onEditorFocused(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const filePath = editor.document.uri.fsPath;

    // Always recognise databricks.yml regardless of whether it's in the map yet
    const bundleRoot = BUNDLE_YML_RE.test(filePath)
      ? path.dirname(filePath)
      : fileToBundleRoot.get(filePath);

    if (!bundleRoot) return;

    void runBundleDiagnostics(bundleRoot, configuredCliPath, diagnosticCollection, fileToBundleRoot);
  }

  extensionContext.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(onEditorFocused),
  );

  // Check whichever file is already open when the extension activates
  onEditorFocused(vscode.window.activeTextEditor);

  let activePanel: vscode.WebviewPanel | undefined;
  let activeBundleData: unknown;

  async function inspectBundle() {
    const bundleDir = getBundleDirFromEditor(vscode.window.activeTextEditor);

    if (!bundleDir) {
      vscode.window.showInformationMessage(
        "Open a databricks.yaml or databricks.yml file, then run Inspect Databricks Bundle.",
      );
      return;
    }

    try {
      const configuredPath = getConfiguredDatabricksCliPath(getConfiguration());
      const result = await validateBundle(bundleDir, undefined, configuredPath);

      if (!result.ok) {
        console.error("[inspectBundle] validation failed", result.error);
        if (result.error.diagnostics?.length) {
          void vscode.commands.executeCommand("workbench.actions.view.problems");
          vscode.window.showWarningMessage(
            "Bundle has errors — see the Problems panel for details.",
          );
        } else {
          vscode.window.showErrorMessage(
            result.error.details
              ? `${result.error.error}: ${result.error.details}`
              : result.error.error,
          );
        }
        return;
      }

      // Pass the raw parsed bundle data (not the extracted graph).
      // The webview App component will extract the graph itself.
      const bundleData = result.data;
      activeBundleData = bundleData;

      // Create or show webview panel
      if (activePanel) {
        activePanel.reveal(vscode.ViewColumn.One);
        activePanel.webview.postMessage({
          type: "bundleData",
          parsedBundle: bundleData,
        });
      } else {
        activePanel = vscode.window.createWebviewPanel(
          "bundleInspector",
          "Bundle Inspector",
          vscode.ViewColumn.One,
          {
            enableScripts: true,
            localResourceRoots: [
              getWebviewPaths(extensionContext.extensionUri).webviewRoot,
            ],
            retainContextWhenHidden: true,
          },
        );

        activePanel.webview.html = await getWebviewContent(
          activePanel.webview,
          extensionContext.extensionUri,
        );

        activePanel.webview.onDidReceiveMessage((message) => {
          if (message?.type === "webviewReady" && activeBundleData) {
            activePanel?.webview.postMessage({
              type: "bundleData",
              parsedBundle: activeBundleData,
            });
          }
        });

        activePanel.onDidDispose(() => {
          activePanel = undefined;
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const disposable = vscode.commands.registerCommand(
    "databricksBundleInspector.inspectBundle",
    () => inspectBundle(),
  );

  extensionContext.subscriptions.push(disposable);
}

export function deactivate() {}
