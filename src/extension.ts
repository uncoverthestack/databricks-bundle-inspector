import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "path";
import {
  BUNDLE_PROBE_TARGET,
  validateBundle,
  extractBundleGraph,
} from "./bundle/validateBundle.js";
import type { BundleDiagnostic } from "./bundle/validateBundle.js";
import { enrichGraphWithFileContent } from "./bundle/graph/enrichGraph.js";
import {
  buildInspectorIssues,
  type InspectorIssue,
} from "./bundle/issues.js";
import {
  getConfiguration,
  getConfiguredDatabricksCliPath,
} from "./databricksCli/config.js";
import { invalidateDatabricksCliCache } from "./databricksCli/validateDatabricksCli.js";
import { getBundleDirFromEditor, isBundleFile } from "./bundle/bundleContext.js";
import { getIncludedFiles } from "./bundle/bundleIncludes.js";
import type { ParsedBundleConfig } from "./bundle/graph/bundleGraph.js";

function isBundlePath(filePath: string): boolean {
  return isBundleFile(path.basename(filePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const relativePath = path.relative(resolvedDirectoryPath, resolvedFilePath);

  return (
    relativePath === "" ||
    (relativePath.length > 0 &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

export function isOpenFilePathAllowed(
  filePath: string,
  activeBundleDir: string | undefined,
  workspaceFolders:
    | readonly { uri: { fsPath: string } }[]
    | undefined,
): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return false;

  if (activeBundleDir && isPathInDirectory(filePath, activeBundleDir)) {
    return true;
  }

  return (workspaceFolders ?? []).some((folder) =>
    isPathInDirectory(filePath, folder.uri.fsPath),
  );
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

type BundleValidationResult = Awaited<ReturnType<typeof validateBundle>>;

/**
 * Updates diagnostics for one bundle root from an existing validation result.
 *
 * Diagnostics are updated per-file so existing entries for files not in the new
 * result are cleared and stale errors do not linger after a fix.
 */
async function updateBundleDiagnostics(
  result: BundleValidationResult,
  bundleRoot: string,
  collection: vscode.DiagnosticCollection,
  fileToBundleRoot: Map<string, string>,
): Promise<void> {
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
  if (result.ok) {
    try {
      const graph = await extractBundleGraph(result.data, bundleRoot);
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
}

/**
 * Runs bundle validate for a single bundle root and updates diagnostics for
 * files that belong to that bundle.
 */
async function runBundleDiagnostics(
  bundleRoot: string,
  configuredCliPath: string | undefined,
  collection: vscode.DiagnosticCollection,
  fileToBundleRoot: Map<string, string>,
): Promise<void> {
  const result = await validateBundle(bundleRoot, undefined, configuredCliPath);
  await updateBundleDiagnostics(result, bundleRoot, collection, fileToBundleRoot);
}

/**
 * Tracks the inspected bundle file and its declared includes so saves can refresh
 * diagnostics without scanning unrelated bundle YAML files in the workspace.
 */
async function trackBundleFiles(
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

  function currentConfiguredCliPath(): string | undefined {
    return getConfiguredDatabricksCliPath(getConfiguration());
  }

  // Maps inspected bundle-related files (databricks.yml + its includes) to their bundle root.
  // Populated lazily for the active bundle, then kept up-to-date after each CLI run.
  const fileToBundleRoot = new Map<string, string>();

  extensionContext.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("databricksBundleInspector.cliPath")) {
        invalidateDatabricksCliCache();
      }
    }),
  );

  // On save: re-run diagnostics for the bundle that owns the saved file.
  extensionContext.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const filePath = document.uri.fsPath;
      const isSavedBundleFile = isBundlePath(filePath);
      const bundleRoot = isSavedBundleFile
        ? path.dirname(filePath)
        : fileToBundleRoot.get(filePath);
      if (!bundleRoot) return;
      void (async () => {
        await runBundleDiagnostics(
          bundleRoot,
          currentConfiguredCliPath(),
          diagnosticCollection,
          fileToBundleRoot,
        );
        if (activePanel && activeBundleDir === bundleRoot) {
          await refreshActiveBundlePanel(bundleRoot, {
            refreshTargets: isSavedBundleFile,
          });
        }
      })();
    }),
  );

  let activePanel: vscode.WebviewPanel | undefined;
  let activeBundleData: unknown;
  let activeBundleDir: string | undefined;
  let activeRequestedTarget: string | undefined;
  let activeTargetOptions: string[] = [];
  let activeStructuralResolutionBundle: ParsedBundleConfig | undefined;

  async function inspectBundleAtTarget(
    bundleDir: string,
    requestedTarget?: string,
    options?: { silentFallback?: boolean },
  ) {
    const configuredPath = getConfiguredDatabricksCliPath(getConfiguration());
    let result = await validateBundle(bundleDir, requestedTarget, configuredPath);
    let inspectedTarget = requestedTarget ?? BUNDLE_PROBE_TARGET;
    let inspectedTargetMode: "target" | "probe" =
      requestedTarget ? "target" : "probe";
    let fallbackMessage: string | undefined;

    if (!result.ok && requestedTarget) {
      fallbackMessage = result.error.details ?? result.error.error;
      result = await validateBundle(bundleDir, undefined, configuredPath);
      inspectedTarget = BUNDLE_PROBE_TARGET;
      inspectedTargetMode = "probe";
      if (!options?.silentFallback) {
        vscode.window.showWarningMessage(
          `Could not inspect target "${requestedTarget}". Showing structural preview instead.`,
        );
      }
    }

    if (!result.ok) {
      return { result, inspectedTarget, inspectedTargetMode, fallbackMessage };
    }

    const bundleData = result.data;
    const discoveredTargetOptions =
      result.targetOptions && result.targetOptions.length > 0
        ? result.targetOptions
        : Object.keys(
            (bundleData as { targets?: Record<string, unknown> }).targets ?? {},
          );
    if (discoveredTargetOptions.length > 0) {
      activeTargetOptions = discoveredTargetOptions;
      activeStructuralResolutionBundle = bundleData;
    }
    const previousResolutionBundle: Partial<ParsedBundleConfig> =
      activeStructuralResolutionBundle ?? {};
    const mergedVariables = {
      ...(previousResolutionBundle.variables ?? {}),
      ...(bundleData.variables ?? {}),
    } as ParsedBundleConfig["variables"];
    const mergedTargets =
      (bundleData as { targets?: ParsedBundleConfig["targets"] }).targets ??
      previousResolutionBundle.targets;
    const resolutionBundle: ParsedBundleConfig = {
      bundle: bundleData.bundle,
      ...(mergedVariables ? { variables: mergedVariables } : {}),
      ...(mergedTargets ? { targets: mergedTargets } : {}),
    };
    const graph = await extractBundleGraph(bundleData, bundleDir);
    const enrichedGraph = await enrichGraphWithFileContent(graph);
    const inspectorIssues = buildInspectorIssues(
      enrichedGraph,
      resolutionBundle,
      result.issues ?? [],
      bundleDir,
      inspectedTargetMode === "target" ? inspectedTarget : undefined,
    );

    return {
      result,
      bundleData,
      enrichedGraph,
      inspectorIssues,
      targetOptions: activeTargetOptions,
      resolutionBundle,
      inspectedTarget,
      inspectedTargetMode,
      fallbackMessage,
    };
  }

  function postBundleData(data: object) {
    activeBundleData = data;
    activePanel?.webview.postMessage({
      type: "bundleData",
      ...data,
    });
  }

  function bundleMessageDataFromInspection(
    inspection: Awaited<ReturnType<typeof inspectBundleAtTarget>>,
    requestedTarget?: string,
    options?: { focusIssues?: boolean },
  ): object | undefined {
    const { result } = inspection;
    if (!result.ok) return undefined;

    const bundleData = inspection.bundleData;
    const enrichedGraph = inspection.enrichedGraph;
    const inspectorIssues = inspection.inspectorIssues;
    if (!bundleData || !enrichedGraph || !inspectorIssues) return undefined;

    return {
      parsedBundle: bundleData,
      resolutionBundle: inspection.resolutionBundle ?? bundleData,
      graph: enrichedGraph,
      validationIssues: result.issues ?? [],
      inspectorIssues,
      targetOptions: inspection.targetOptions ?? [],
      inspectedTarget: inspection.inspectedTarget,
      inspectedTargetMode: inspection.inspectedTargetMode,
      requestedTarget: requestedTarget ?? null,
      targetFallbackMessage: inspection.fallbackMessage ?? null,
      focusIssuesNonce: options?.focusIssues ? Date.now() : null,
    };
  }

  async function refreshActiveBundlePanel(
    bundleDir: string,
    options?: { refreshTargets?: boolean },
  ) {
    try {
      if (options?.refreshTargets) {
        const probeInspection = await inspectBundleAtTarget(bundleDir, undefined, {
          silentFallback: true,
        });
        if (
          activeRequestedTarget &&
          activeTargetOptions.length > 0 &&
          !activeTargetOptions.includes(activeRequestedTarget)
        ) {
          activeRequestedTarget = undefined;
        }
        if (!activeRequestedTarget) {
          const messageData = bundleMessageDataFromInspection(probeInspection);
          if (messageData) {
            postBundleData(messageData);
          }
          return;
        }
      }

      const inspection = await inspectBundleAtTarget(
        bundleDir,
        activeRequestedTarget,
        { silentFallback: true },
      );
      const messageData = bundleMessageDataFromInspection(
        inspection,
        activeRequestedTarget,
      );
      if (messageData) {
        postBundleData(messageData);
      }
    } catch (error) {
      console.warn(
        `[BundleInspector] active panel refresh failed for ${bundleDir}:`,
        error,
      );
    }
  }

  async function inspectBundle(
    requestedTarget?: string,
    options?: { focusIssues?: boolean },
    bundleDirOverride?: string,
  ) {
    const bundleDir =
      bundleDirOverride ?? getBundleDirFromEditor(vscode.window.activeTextEditor);

    if (!bundleDir) {
      if (options?.focusIssues && activePanel && activeBundleData) {
        activePanel.reveal(vscode.ViewColumn.One);
        activePanel.webview.postMessage({ type: "focusIssues" });
        return;
      }
      vscode.window.showInformationMessage(
        "Open a databricks.yaml or databricks.yml file, then run Inspect Databricks Bundle.",
      );
      return;
    }

    try {
      if (activeBundleDir !== bundleDir) {
        activeTargetOptions = [];
        activeStructuralResolutionBundle = undefined;
      }
      activeBundleDir = bundleDir;
      activeRequestedTarget = requestedTarget;
      await trackBundleFiles(bundleDir, fileToBundleRoot);
      const inspection = await inspectBundleAtTarget(bundleDir, requestedTarget);
      const { result } = inspection;
      await updateBundleDiagnostics(
        result,
        bundleDir,
        diagnosticCollection,
        fileToBundleRoot,
      );

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

      const errorDiagnostics =
        result.issues
          ?.filter((issue) => issue.code !== "AUTH_NOT_CONFIGURED")
          .flatMap((i) => i.diagnostics ?? [])
          .filter((d) => d.severity === "error") ?? [];
      if (errorDiagnostics.length > 0) {
        const suffix = errorDiagnostics.length > 1 ? ` (+${errorDiagnostics.length - 1} more)` : "";
        const firstMessage = errorDiagnostics[0]?.message ?? "Unknown error";
        void vscode.window.showWarningMessage(
          `Bundle has validation errors — graph may be incomplete. ${firstMessage}${suffix}`,
          "Show Problems",
        ).then((choice) => {
          if (choice === "Show Problems") {
            void vscode.commands.executeCommand("workbench.actions.view.problems");
          }
        });
      }

      const bundleMessageData = bundleMessageDataFromInspection(
        inspection,
        requestedTarget,
        options,
      );
      if (!bundleMessageData) return;

      // Create or show webview panel
      if (activePanel) {
        activePanel.reveal(vscode.ViewColumn.One);
        postBundleData(bundleMessageData);
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
              ...(activeBundleData as object),
            });
          }
          if (
            message?.type === "selectTarget" &&
            (typeof message.target === "string" || message.target === null)
          ) {
            const bundleDirForPanel = activeBundleDir;
            if (!bundleDirForPanel) return;
            void inspectBundle(
              typeof message.target === "string" ? message.target : undefined,
              undefined,
              bundleDirForPanel,
            );
          }
          if (message?.type === "openFile" && typeof message.path === "string") {
            if (
              !isOpenFilePathAllowed(
                message.path,
                activeBundleDir,
                vscode.workspace.workspaceFolders,
              )
            ) {
              console.warn(
                `[BundleInspector] blocked webview file open outside workspace: ${message.path}`,
              );
              return;
            }

            const targetPath = path.resolve(message.path);
            const uri = vscode.Uri.file(targetPath);
            if (targetPath.endsWith(".ipynb")) {
              // Jupyter editor has no line-jump API — open at top
              void vscode.commands.executeCommand("vscode.open", uri);
            } else {
              const lineNum = typeof message.line === "number" ? Math.max(0, message.line - 1) : 0;
              const columnNum =
                typeof message.column === "number"
                  ? Math.max(0, message.column - 1)
                  : 0;
              const pos = new vscode.Position(lineNum, columnNum);
              void vscode.window.showTextDocument(uri, {
                selection: new vscode.Range(pos, pos),
              });
            }
          }
          if (
            message?.type === "copyReviewSummary" &&
            typeof message.markdown === "string"
          ) {
            void vscode.env.clipboard
              .writeText(message.markdown)
              .then(
                () =>
                  vscode.window.showInformationMessage(
                    "Bundle review summary copied.",
                  ),
                (error: unknown) =>
                  vscode.window.showWarningMessage(
                    `Could not copy bundle review summary: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  ),
              );
          }
        });

        activePanel.onDidDispose(() => {
          activePanel = undefined;
        });

        postBundleData(bundleMessageData);
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
  const openIssuesDisposable = vscode.commands.registerCommand(
    "databricksBundleInspector.openBundleIssues",
    () => inspectBundle(undefined, { focusIssues: true }),
  );
  extensionContext.subscriptions.push(
    disposable,
    openIssuesDisposable,
  );
}

export function deactivate() {}
