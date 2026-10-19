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
  getConfiguredProfile,
} from "./databricksCli/config.js";
import {
  databricksCliInstallUrl,
  databricksCliUpdateUrl,
  invalidateDatabricksCliCache,
  resolveDatabricksCli,
  verifyCliPath,
  type CliProblem,
} from "./databricksCli/validateDatabricksCli.js";
import { isOlderThanSupported, MIN_SUPPORTED_CLI_VERSION } from "./databricksCli/parsing.js";
import { getBundleDirFromEditor } from "./bundle/bundleContext.js";
import { folderIgnoresCase } from "./bundle/pathCase.js";
import {
  BUNDLE_FILE_GLOB,
  MAX_BUNDLES_CHECKED_ON_OPEN,
  SKIPPED_FOLDERS_GLOB,
  selectBundleRoots,
} from "./bundle/bundleDiscovery.js";
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
  bundleProblemCount,
  readIncludePatterns,
  runBundleDiagnostics,
  trackBundleFiles,
  updateBundleDiagnostics,
  type BundleValidationResult,
} from "./extension/diagnostics.js";
import { getWebviewContent, getWebviewPaths } from "./extension/webviewPanel.js";
import {
  bundleForFile,
  bundleSummary,
  checkStateOf,
  orderForPicking,
  statusBarView,
  type BundleCheckState,
} from "./extension/statusBar.js";

// Re-exported so existing imports of it from this module keep working.
export { isOpenFilePathAllowed };

type InspectTrigger = "command" | "issues_command" | "target_switch" | "status_bar";

let telemetry: Telemetry | undefined;

export function activate(extensionContext: vscode.ExtensionContext) {
  console.log('Extension "databricks-bundle-inspector" is now active!');
  telemetry = createTelemetry(extensionContext);

  const diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "databricks-bundle-inspector",
  );
  extensionContext.subscriptions.push(diagnosticCollection);

  // One quiet item in the status bar: whether the checks ran, how many problems they
  // found, and a way into the graph from any file. It is the only place that says the
  // Databricks CLI is missing without the user having clicked Inspect first.
  const STATUS_BAR_COMMAND = "databricksBundleInspector.statusBarAction";
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.name = "Databricks Bundle Inspector";
  statusBarItem.command = STATUS_BAR_COMMAND;
  extensionContext.subscriptions.push(statusBarItem);
  const checkStates = new Map<string, BundleCheckState>();
  /** Every bundle found in the open folders, checked or not, in the order found. */
  const foundBundles = new Set<string>();

  let lastStatusBarBundle: string | undefined;

  /**
   * The bundle the item is about, and a click opens: the open file's. With no file in
   * front (the graph, Settings), it stays on the bundle it was last about, so it does
   * not jump to another bundle while the user looks at this one's graph.
   */
  function statusBarBundle(): string | undefined {
    const roots = [...foundBundles];
    const ofOpenFile = bundleForFile(
      roots,
      vscode.window.activeTextEditor?.document.uri.fsPath,
      path.sep,
    );
    const remembered =
      lastStatusBarBundle && foundBundles.has(lastStatusBarBundle) ? lastStatusBarBundle : undefined;
    lastStatusBarBundle = ofOpenFile ?? remembered ?? roots[0];
    return lastStatusBarBundle;
  }

  function renderStatusBar(): void {
    const bundleRoot = statusBarBundle();
    const view =
      bundleRoot &&
      statusBarView(
        checkStates.get(bundleRoot) ?? "pending",
        bundleProblemCount(bundleRoot, diagnosticCollection),
        path.basename(bundleRoot),
        foundBundles.size - 1,
      );
    if (!view) {
      statusBarItem.hide();
      return;
    }
    statusBarItem.text = view.text;
    statusBarItem.tooltip = view.tooltip;
    statusBarItem.backgroundColor = view.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    statusBarItem.show();
  }

  function recordCheck(
    bundleRoot: string,
    result: BundleValidationResult,
    options: { inspected?: boolean } = {},
  ): void {
    checkStates.set(bundleRoot, checkStateOf(result));
    foundBundles.add(bundleRoot);
    // The bundle whose graph was just opened is the one the user is looking at.
    if (options.inspected) lastStatusBarBundle = bundleRoot;
    renderStatusBar();
  }
  // With several bundles in the folder, the item follows the file in front.
  extensionContext.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => renderStatusBar()),
  );

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

  /** Returns the check's result, or undefined when it was put off behind one already running. */
  async function refreshBundle(
    bundleRoot: string,
    flags: Omit<PendingRefresh, "timer">,
  ): Promise<BundleValidationResult | undefined> {
    // One check per bundle at a time, so an older result never overwrites a newer one.
    if (runningRefreshes.has(bundleRoot)) {
      scheduleRefresh(
        bundleRoot,
        flags.config ? "config" : "source",
        flags.saved ? { bundleFile: flags.bundleFileSaved } : undefined,
      );
      return undefined;
    }
    runningRefreshes.add(bundleRoot);
    try {
      const { result, graph } = await runBundleDiagnostics(
        bundleRoot,
        currentConfiguredCliPath(),
        diagnosticCollection,
        fileToBundleRoot,
      );
      recordCheck(bundleRoot, result);
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
      return result;
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
  const ignoresCaseByRoot = new Map<string, boolean>();

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
    let ignoresCase = ignoresCaseByRoot.get(bundleRoot);
    if (ignoresCase === undefined) {
      ignoresCase = await folderIgnoresCase(bundleRoot);
      ignoresCaseByRoot.set(bundleRoot, ignoresCase);
    }
    const spec = collectWatchSpec(
      graph,
      config,
      bundleRoot,
      await readIncludePatterns(bundleRoot),
      { ignoresCase },
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
      ignoresCaseByRoot.clear();
    },
  });

  // On save: re-check the bundle that owns the saved file. Bundle YAML also covers
  // bundles not checked yet, which have no watcher.
  extensionContext.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const filePath = document.uri.fsPath;
      const isSavedBundleFile = isBundlePath(filePath);
      const bundleRoot = isSavedBundleFile
        ? path.dirname(filePath)
        : fileToBundleRoot.get(filePath);
      if (bundleRoot) {
        scheduleRefresh(bundleRoot, "config", { bundleFile: isSavedBundleFile });
        return;
      }
      // Any other file a checked bundle points at: a notebook, a Python or SQL file,
      // a .gitignore. The watcher reports these too, but a save in the editor should
      // not depend on it. A duplicate from the watcher joins the same debounce.
      for (const [watchedRoot, watch] of bundleWatches) {
        const change = classifyChange(watch.spec, filePath);
        if (change) scheduleRefresh(watchedRoot, change);
      }
    }),
  );

  // When a folder opens: check the bundles in it, so the Problems panel is filled
  // before the first save. Runs unasked, so it shows no messages and opens no panel.
  const BUNDLE_SEARCH_MAX_FILES = 200;
  interface OpenFoldersCheck {
    bundleCount: number;
    bundleAtRoot: boolean;
    /** Undefined when no bundle was checked. */
    cliFound: boolean | undefined;
    /** Errors and warnings the checks put in the Problems panel. Undefined when nothing was checked. */
    issueCount: number | undefined;
  }
  async function checkBundlesIn(
    folders: readonly vscode.WorkspaceFolder[],
  ): Promise<OpenFoldersCheck> {
    const check: OpenFoldersCheck = {
      bundleCount: 0,
      bundleAtRoot: false,
      cliFound: undefined,
      issueCount: undefined,
    };
    try {
      const localFolders = folders.filter((folder) => folder.uri.scheme === "file");
      const found = await Promise.all(
        localFolders.map((folder) =>
          vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, BUNDLE_FILE_GLOB),
            SKIPPED_FOLDERS_GLOB,
            BUNDLE_SEARCH_MAX_FILES,
          ),
        ),
      );
      const allRoots = selectBundleRoots(found.flat().map((uri) => uri.fsPath), Infinity);
      check.bundleCount = allRoots.length;
      for (const bundleRoot of allRoots) foundBundles.add(bundleRoot);
      renderStatusBar();
      check.bundleAtRoot = localFolders.some((folder) => allRoots.includes(folder.uri.fsPath));
      // One at a time, so a folder with several bundles does not start several CLI runs at once.
      for (const bundleRoot of allRoots.slice(0, MAX_BUNDLES_CHECKED_ON_OPEN)) {
        const result = await refreshBundle(bundleRoot, {
          config: true,
          saved: false,
          bundleFileSaved: false,
        });
        if (result && check.cliFound === undefined) {
          check.cliFound =
            result.ok ||
            (result.error.errorCode !== "CLI_NOT_FOUND" &&
              result.error.errorCode !== "CLI_NOT_EXECUTABLE");
        }
      }
      if (check.cliFound) {
        let issueCount = 0;
        diagnosticCollection.forEach((_uri, diagnostics) => {
          issueCount += diagnostics.filter(
            (diagnostic) =>
              diagnostic.severity === vscode.DiagnosticSeverity.Error ||
              diagnostic.severity === vscode.DiagnosticSeverity.Warning,
          ).length;
        });
        check.issueCount = issueCount;
      }
    } catch (error) {
      console.warn("[BundleInspector] checking bundles on open failed:", error);
    }
    return check;
  }
  extensionContext.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      void checkBundlesIn(event.added);
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
    const config = getConfiguration();
    const configuredPath = getConfiguredDatabricksCliPath(config);
    let result = await validateBundle(
      bundleDir,
      requestedTarget,
      configuredPath,
      getConfiguredProfile(config),
    );
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

  const LOCATE_CLI = "Locate CLI…";

  async function showCliNotFound(
    message: string,
    problem: CliProblem | undefined,
    inspectAgain: () => Promise<void>,
  ) {
    const install = "Open Install Guide";
    const settings = "Open Settings";
    const choice = await vscode.window.showErrorMessage(
      message,
      install,
      LOCATE_CLI,
      ...(problem === "configured_path_invalid" ? [settings] : []),
    );
    if (choice === install) {
      void vscode.env.openExternal(vscode.Uri.parse(databricksCliInstallUrl(process.platform)));
    } else if (choice === LOCATE_CLI) {
      await locateCli(inspectAgain);
    } else if (choice === settings) {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "databricksBundleInspector.cliPath",
      );
    }
  }

  /**
   * Lets the user pick the CLI file when it is not on VS Code's PATH. Only a file that
   * answers `--version` as the Databricks CLI is saved, to the cliPath user setting.
   */
  async function locateCli(inspectAgain: () => Promise<void>): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: "Select the Databricks CLI",
      openLabel: "Use this CLI",
      canSelectMany: false,
      ...(process.platform === "win32" ? { filters: { Programs: ["exe"] } } : {}),
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;

    const cli = await verifyCliPath(file);
    if (!cli.ok) {
      const name = path.basename(file);
      const printed = cli.otherProgramOutput?.trim().slice(0, 60);
      const expected = process.platform === "win32" ? "databricks.exe" : "databricks";
      const choice = await vscode.window.showErrorMessage(
        printed
          ? `${name} is not the Databricks CLI (it printed "${printed}"). Pick ${expected}.`
          : `${name} could not be run as the Databricks CLI. Pick ${expected}.`,
        LOCATE_CLI,
      );
      if (choice === LOCATE_CLI) await locateCli(inspectAgain);
      return;
    }

    await getConfiguration().update("cliPath", file, vscode.ConfigurationTarget.Global);
    invalidateDatabricksCliCache();
    void vscode.window.showInformationMessage(
      `Using Databricks CLI${cli.versionOutput ? ` ${cli.versionOutput}` : ""} from ${file}. Saved to the databricksBundleInspector.cliPath setting.`,
    );
    // Other bundles that were waiting for the CLI get checked too.
    for (const [bundleRoot, state] of checkStates) {
      if (state === "cli_missing" && bundleRoot !== activeBundleDir) {
        scheduleRefresh(bundleRoot, "config");
      }
    }
    await inspectAgain();
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
      // The Problems panel and the status bar always show the structural preview, which
      // needs no login, so a save never flips them to another target. A real target picked
      // in the graph changes the graph only. A target that fell back to the preview counts.
      const showsPreview = inspection.inspectedTargetMode === "probe";
      if (showsPreview) {
        const diagnosticsGraph = await updateBundleDiagnostics(
          result,
          bundleDir,
          diagnosticCollection,
          fileToBundleRoot,
        );
        recordCheck(bundleDir, result, { inspected: true });
        if (result.ok && diagnosticsGraph) {
          await watchBundle(bundleDir, result.data, diagnosticsGraph);
        }
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
          void showCliNotFound(result.error.error, result.error.cliProblem, () =>
            inspectBundle(requestedTarget, options, bundleDir),
          );
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
          // A picked target's errors are in the graph only: the Problems panel shows the preview.
          ...(showsPreview ? ["Show Problems"] : []),
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
  // A click on the status bar item. Inspect does the rest: it opens the graph with the
  // issues, or says what is wrong (for a missing CLI, with the install guide button).
  // With several bundles in the folder it first asks which one, the one in view on top.
  const statusBarDisposable = vscode.commands.registerCommand(STATUS_BAR_COMMAND, async () => {
    let bundleRoot = statusBarBundle();
    if (foundBundles.size > 1) {
      const picked = await vscode.window.showQuickPick(
        orderForPicking([...foundBundles], bundleRoot).map((root) => ({
          label: path.basename(root),
          description: vscode.workspace.asRelativePath(root, true),
          detail: bundleSummary(
            checkStates.get(root),
            bundleProblemCount(root, diagnosticCollection),
          ),
          root,
        })),
        {
          title: "Databricks Bundle Inspector",
          placeHolder: "Which bundle do you want to open in the graph?",
          matchOnDescription: true,
        },
      );
      if (!picked) return;
      bundleRoot = picked.root;
    }
    await inspectBundle(undefined, { focusIssues: true, trigger: "status_bar" }, bundleRoot);
  });
  extensionContext.subscriptions.push(
    disposable,
    openIssuesDisposable,
    statusBarDisposable,
  );

  void checkBundlesIn(vscode.workspace.workspaceFolders ?? []).then((check) =>
    telemetry?.logUsage("extension_activated", {
      bundle_count: countBucket(check.bundleCount),
      bundle_at_root: check.bundleAtRoot,
      ...(check.cliFound === undefined ? {} : { cli_found: check.cliFound }),
      ...(check.issueCount === undefined ? {} : { issue_count: countBucket(check.issueCount) }),
    }),
  );
}

export function deactivate(): Promise<void> | undefined {
  const pending = telemetry?.shutdown();
  telemetry = undefined;
  return pending;
}
