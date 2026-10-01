import * as vscode from "vscode";
import path from "path";
import {
  BUNDLE_PROBE_TARGET,
  validateBundle,
  extractBundleGraph,
} from "./bundle/validateBundle.js";
import type { BundleResult } from "./bundle/validateBundle.js";
import { enrichGraphWithFileContent } from "./bundle/graph/enrichGraph.js";
import { buildInspectorIssues } from "./bundle/issues.js";
import {
  getConfiguration,
  getConfiguredDatabricksCliPath,
} from "./databricksCli/config.js";
import {
  databricksCliInstallUrl,
  databricksCliUpdateUrl,
  invalidateDatabricksCliCache,
  resolveDatabricksCli,
  type CliProblem,
} from "./databricksCli/validateDatabricksCli.js";
import { isOlderThanSupported, MIN_SUPPORTED_CLI_VERSION } from "./databricksCli/parsing.js";
import { getBundleDirFromEditor } from "./bundle/bundleContext.js";
import type { BundleGraph, ParsedBundleConfig } from "./bundle/graph/bundleGraph.js";
import {
  classifyChange,
  collectWatchSpec,
  filesOutsideRoot,
  type BundleChange,
  type BundleWatchSpec,
} from "./bundle/watchedFiles.js";
import { createTelemetry, type Telemetry } from "./telemetry/telemetry.js";
import {
  countBucket,
  fileKind,
  parseWebviewTelemetryMessage,
  taskKinds,
} from "./telemetry/events.js";
import { isBundlePath, isOpenFilePathAllowed } from "./extension/paths.js";
import {
  readIncludePatterns,
  runBundleDiagnostics,
  trackBundleFiles,
  updateBundleDiagnostics,
  type BundleValidationResult,
} from "./extension/diagnostics.js";
import { getWebviewContent, getWebviewPaths } from "./extension/webviewPanel.js";

// Re-exported so existing imports of it from this module keep working.
export { isOpenFilePathAllowed };

type InspectTrigger = "command" | "issues_command" | "target_switch";

let telemetry: Telemetry | undefined;

export function activate(extensionContext: vscode.ExtensionContext) {
  console.log('Extension "databricks-bundle-inspector" is now active!');
  telemetry = createTelemetry(extensionContext);

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

  // Re-checks a bundle when a file it depends on is saved, created, changed or
  // deleted. Saves and watcher events share one debounce, so a save (which also
  // fires a change event) or a branch switch runs a single check.
  const REFRESH_DEBOUNCE_MS = 500;
  interface PendingRefresh {
    timer: ReturnType<typeof setTimeout>;
    config: boolean;
    saved: boolean;
    bundleFileSaved: boolean;
  }
  const pendingRefreshes = new Map<string, PendingRefresh>();
  const runningRefreshes = new Set<string>();

  function scheduleRefresh(
    bundleRoot: string,
    change: BundleChange,
    save?: { bundleFile: boolean },
  ): void {
    const pending = pendingRefreshes.get(bundleRoot);
    if (pending) clearTimeout(pending.timer);
    const next: PendingRefresh = {
      config: Boolean(pending?.config) || change === "config",
      saved: Boolean(pending?.saved) || save !== undefined,
      bundleFileSaved: Boolean(pending?.bundleFileSaved) || Boolean(save?.bundleFile),
      timer: setTimeout(() => {
        pendingRefreshes.delete(bundleRoot);
        void refreshBundle(bundleRoot, next);
      }, REFRESH_DEBOUNCE_MS),
    };
    pendingRefreshes.set(bundleRoot, next);
  }

  async function refreshBundle(
    bundleRoot: string,
    flags: Omit<PendingRefresh, "timer">,
  ): Promise<void> {
    // One check per bundle at a time, so an older result never overwrites a newer one.
    if (runningRefreshes.has(bundleRoot)) {
      scheduleRefresh(
        bundleRoot,
        flags.config ? "config" : "source",
        flags.saved ? { bundleFile: flags.bundleFileSaved } : undefined,
      );
      return;
    }
    runningRefreshes.add(bundleRoot);
    try {
      const { result, graph } = await runBundleDiagnostics(
        bundleRoot,
        currentConfiguredCliPath(),
        diagnosticCollection,
        fileToBundleRoot,
      );
      if (result.ok && graph) {
        await watchBundle(bundleRoot, result.data, graph);
      }
      if (activePanel && activeBundleDir === bundleRoot) {
        if (flags.saved) {
          telemetry?.logUsage("bundle_refreshed_on_save", {
            bundle_file: flags.bundleFileSaved,
          });
        }
        await refreshActiveBundlePanel(bundleRoot, {
          refreshTargets: flags.config,
        });
      }
    } finally {
      runningRefreshes.delete(bundleRoot);
    }
  }

  interface BundleWatch {
    spec: BundleWatchSpec;
    rootWatcher: vscode.FileSystemWatcher;
    outsideWatchers: vscode.FileSystemWatcher[];
    outsideFiles: string;
  }
  const bundleWatches = new Map<string, BundleWatch>();

  function createWatcher(
    bundleRoot: string,
    pattern: vscode.RelativePattern,
  ): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onEvent = (uri: vscode.Uri) => {
      const spec = bundleWatches.get(bundleRoot)?.spec;
      const change = spec && classifyChange(spec, uri.fsPath);
      if (change) scheduleRefresh(bundleRoot, change);
    };
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);
    watcher.onDidDelete(onEvent);
    return watcher;
  }

  /**
   * Updates what a bundle watches from its latest check: the files and folders
   * `databricks.yml` points at. One watcher covers the bundle root; files outside
   * it (for example through `sync.paths`) get their own.
   */
  async function watchBundle(
    bundleRoot: string,
    config: ParsedBundleConfig,
    graph: BundleGraph,
  ): Promise<void> {
    const spec = collectWatchSpec(
      graph,
      config,
      bundleRoot,
      await readIncludePatterns(bundleRoot),
    );
    const outside = filesOutsideRoot(spec).sort();
    const existing = bundleWatches.get(bundleRoot);
    if (existing && existing.outsideFiles === outside.join("\n")) {
      existing.spec = spec;
      return;
    }
    existing?.outsideWatchers.forEach((watcher) => watcher.dispose());
    bundleWatches.set(bundleRoot, {
      spec,
      rootWatcher:
        existing?.rootWatcher ??
        createWatcher(bundleRoot, new vscode.RelativePattern(bundleRoot, "**/*")),
      outsideWatchers: outside.map((file) =>
        createWatcher(
          bundleRoot,
          new vscode.RelativePattern(path.dirname(file), path.basename(file)),
        ),
      ),
      outsideFiles: outside.join("\n"),
    });
  }

  extensionContext.subscriptions.push({
    dispose: () => {
      for (const pending of pendingRefreshes.values()) clearTimeout(pending.timer);
      pendingRefreshes.clear();
      for (const watch of bundleWatches.values()) {
        watch.rootWatcher.dispose();
        watch.outsideWatchers.forEach((watcher) => watcher.dispose());
      }
      bundleWatches.clear();
    },
  });

  // On save: re-check the bundle that owns the saved file. Also covers bundles
  // not inspected yet, which have no watcher.
  extensionContext.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const filePath = document.uri.fsPath;
      const isSavedBundleFile = isBundlePath(filePath);
      const bundleRoot = isSavedBundleFile
        ? path.dirname(filePath)
        : fileToBundleRoot.get(filePath);
      if (!bundleRoot) return;
      scheduleRefresh(bundleRoot, "config", { bundleFile: isSavedBundleFile });
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

  async function showCliNotFound(message: string, problem: CliProblem | undefined) {
    const install = "Open Install Guide";
    const settings = "Open Settings";
    const choice = await vscode.window.showErrorMessage(
      message,
      install,
      ...(problem === "configured_path_invalid" ? [settings] : []),
    );
    if (choice === install) {
      void vscode.env.openExternal(vscode.Uri.parse(databricksCliInstallUrl(process.platform)));
    } else if (choice === settings) {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "databricksBundleInspector.cliPath",
      );
    }
  }

  // CLI versions already warned about this session, so re-inspecting doesn't repeat it.
  const warnedCliVersions = new Set<string>();

  /**
   * Warns once per session when the CLI in use is older than the oldest tested version.
   * Returns whether it is, or undefined when no CLI was found.
   */
  async function checkCliVersion(result: BundleResult): Promise<boolean | undefined> {
    if (!result.ok && result.error.errorCode === "CLI_NOT_FOUND") return undefined;
    // Cached from the validate run, so this doesn't start the CLI again.
    const cli = await resolveDatabricksCli(currentConfiguredCliPath());
    if (!cli.ok) return undefined;
    const version = cli.versionOutput;
    if (!version || !isOlderThanSupported(version)) return false;
    if (!warnedCliVersions.has(version)) {
      warnedCliVersions.add(version);
      const update = "Open Update Guide";
      void vscode.window
        .showWarningMessage(
          `Databricks CLI ${version} is older than ${MIN_SUPPORTED_CLI_VERSION}, the oldest version this inspector is tested with. Results may be incomplete. Update the Databricks CLI.`,
          update,
        )
        .then((choice) => {
          if (choice === update) {
            // The cached CLI keeps the old version; check again on the next Inspect.
            invalidateDatabricksCliCache();
            void vscode.env.openExternal(vscode.Uri.parse(databricksCliUpdateUrl(process.platform)));
          }
        });
    }
    return true;
  }

  async function inspectBundle(
    requestedTarget?: string,
    options?: { focusIssues?: boolean; trigger?: InspectTrigger },
    bundleDirOverride?: string,
  ) {
    const startedAt = Date.now();
    const logInspect = (
      outcome: string,
      properties: Record<string, string | number | boolean> = {},
    ) =>
      telemetry?.logUsage("inspect_bundle", {
        trigger: options?.trigger ?? "command",
        outcome,
        duration_ms: Date.now() - startedAt,
        ...properties,
      });
    const bundleDir =
      bundleDirOverride ?? getBundleDirFromEditor(vscode.window.activeTextEditor);

    if (!bundleDir) {
      if (options?.focusIssues && activePanel && activeBundleData) {
        activePanel.reveal(vscode.ViewColumn.One);
        activePanel.webview.postMessage({ type: "focusIssues" });
        return;
      }
      logInspect("no_bundle_file");
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
      const diagnosticsGraph = await updateBundleDiagnostics(
        result,
        bundleDir,
        diagnosticCollection,
        fileToBundleRoot,
      );
      if (result.ok && diagnosticsGraph) {
        await watchBundle(bundleDir, result.data, diagnosticsGraph);
      }

      const cliOutdated = await checkCliVersion(result);
      const cliVersionProperty = cliOutdated === undefined ? {} : { cli_outdated: cliOutdated };

      if (!result.ok) {
        logInspect(result.error.errorCode?.toLowerCase() ?? "validation_failed", {
          ...cliVersionProperty,
          has_diagnostics: Boolean(result.error.diagnostics?.length),
          ...(result.error.cliProblem ? { cli_problem: result.error.cliProblem } : {}),
        });
        console.error("[inspectBundle] validation failed", result.error);
        if (result.error.errorCode === "CLI_NOT_FOUND") {
          void showCliNotFound(result.error.error, result.error.cliProblem);
        } else if (result.error.diagnostics?.length) {
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

      const graphNodes = inspection.enrichedGraph?.nodes ?? [];
      logInspect(errorDiagnostics.length > 0 ? "ok_with_errors" : "ok", {
        ...cliVersionProperty,
        target_mode: inspection.inspectedTargetMode,
        fell_back_to_probe: inspection.fallbackMessage !== undefined,
        auth_configured: !(result.issues ?? []).some(
          (issue) => issue.code === "AUTH_NOT_CONFIGURED",
        ),
        target_count: countBucket(inspection.targetOptions?.length ?? 0),
        job_count: countBucket(graphNodes.filter((n) => n.nodeType === "job").length),
        task_count: countBucket(graphNodes.filter((n) => n.nodeType === "task").length),
        task_kinds: taskKinds(graphNodes),
        issue_count: countBucket(inspection.inspectorIssues?.length ?? 0),
      });

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
              { trigger: "target_switch" },
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
            telemetry?.logUsage("file_opened", { file_kind: fileKind(targetPath) });
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
            telemetry?.logUsage("review_summary_copied");
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
          if (message?.type === "telemetry") {
            const parsed = parseWebviewTelemetryMessage(message);
            if (parsed) telemetry?.logUsage(parsed.event, parsed.properties);
          }
        });

        activePanel.onDidDispose(() => {
          activePanel = undefined;
        });

        postBundleData(bundleMessageData);
      }
    } catch (error) {
      logInspect("exception");
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
    () => inspectBundle(undefined, { focusIssues: true, trigger: "issues_command" }),
  );
  extensionContext.subscriptions.push(
    disposable,
    openIssuesDisposable,
  );
}

export function deactivate(): Promise<void> | undefined {
  const pending = telemetry?.shutdown();
  telemetry = undefined;
  return pending;
}
