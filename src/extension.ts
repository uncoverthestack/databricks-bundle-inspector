import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "path";
import { validateBundle } from "./extension/validateBundle.js";
import { getBundleDirFromEditor } from "./extension/bundleContext.js";

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
      const result = await validateBundle(bundleDir);

      if (!result.ok) {
        const errorMsg = result.error.details
          ? `${result.error.error}: ${result.error.details}`
          : result.error.error;
        console.error("[inspectBundle] validation failed", result.error);
        vscode.window.showErrorMessage(
          `Failed to validate bundle: ${errorMsg}`,
        );
        return;
      }

      // Log any issues (like warnings)
      if (result.issues) {
        for (const issue of result.issues) {
          console.warn(
            `[inspectBundle] ${issue.code}: ${issue.message}`,
            issue.details,
          );
        }
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
