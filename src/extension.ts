import * as vscode from "vscode";
import path from "path";
import {
  BUNDLE_PROBE_TARGET,
  validateBundle,
  extractBundleGraph,
} from "./bundle/validateBundle.js";
import type { BundleResult } from "./bundle/validateBundle.js";
import { targetFallback, type TargetFallback } from "./bundle/fallbackReason.js";
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
import {
  listProfiles,
  parseAmbiguousProfiles,
  profilesForHost,
  type DatabricksProfile,
} from "./databricksCli/profiles.js";
import { isOlderThanSupported, MIN_SUPPORTED_CLI_VERSION } from "./databricksCli/parsing.js";
import { getBundleDirFromEditor } from "./bundle/bundleContext.js";
import { bundleThatLoaded, jobKeyAtLine } from "./bundle/resourceFiles.js";
import { folderIgnoresCase } from "./bundle/pathCase.js";
import {
  BUNDLE_FILE_GLOB,
  hasBundleFile,
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
import { InspectorQuickFixProvider, QUICK_FIX_APPLIED_COMMAND } from "./extension/quickFixes.js";
import {
  countBucket,
  fileKind,
  parseWebviewTelemetryMessage,
  taskKinds,
} from "./telemetry/events.js";
import { isBundlePath, isOpenFilePathAllowed } from "./extension/paths.js";
import { cliFileName, configureCliLookup } from "./databricksCli/cliCandidates.js";
import {
  bundleProblemCount,
  folderProblemCount,
  forgetBundleDiagnostics,
  readIncludePatterns,
  runBundleDiagnostics,
  trackBundleFiles,
  updateBundleDiagnostics,
  setIssueDocsVersion,
  bundleLoadedFiles,
  type BundleValidationResult,
} from "./extension/diagnostics.js";
import { getWebviewContent, getWebviewPaths } from "./extension/webviewPanel.js";
import {
  bundleContents,
  bundleForFile,
  bundleSummary,
  checkingView,
  checkStateOf,
  orderForPicking,
  statusBarView,
  type BundleCheckState,
  type BundleContents,
  type CliIssue,
  type StatusBarView,
} from "./extension/statusBar.js";

// Re-exported so existing imports of it from this module keep working.
export { isOpenFilePathAllowed };

type InspectTrigger = "command" | "issues_command" | "target_switch" | "status_bar";

let telemetry: Telemetry | undefined;

export function activate(extensionContext: vscode.ExtensionContext) {
  console.log('Extension "databricks-bundle-inspector" is now active!');
  telemetry = createTelemetry(extensionContext);
  setIssueDocsVersion(String(extensionContext.extension.packageJSON.version ?? ""));
  configureCliLookup({
    // The Databricks extension ships its own CLI in `bin`, so users of it often have one
    // without having installed it. Read on every lookup, as it may be installed later.
    extraCandidates: () => {
      const databricksExtension = vscode.extensions.getExtension("databricks.databricks");
      if (!databricksExtension) return [];
      return [path.join(databricksExtension.extensionPath, "bin", cliFileName(process.platform))];
    },
    // The cliNotFound e2e suite needs no CLI found, even one Windows has stored the path of.
    readStoredPath: !(
      extensionContext.extensionMode === vscode.ExtensionMode.Test &&
      process.env.INSPECTOR_TEST_NO_STORED_PATH === "1"
    ),
  });

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
  /** Why the CLI could not be used, for bundles whose last check ended that way. */
  const cliIssues = new Map<string, CliIssue>();
  /** What the last check of each bundle covered, when it built a graph. */
  const bundleContentsByRoot = new Map<string, BundleContents>();
  /** Checks running now. The item turns only when one runs longer than a moment. */
  let checksRunning = 0;
  let showChecking = false;
  let checkingTimer: ReturnType<typeof setTimeout> | undefined;
  const CHECKING_DELAY_MS = 500;

  async function whileChecking<T>(run: () => Promise<T>): Promise<T> {
    checksRunning++;
    checkingTimer ??= setTimeout(() => {
      showChecking = true;
      renderStatusBar();
    }, CHECKING_DELAY_MS);
    try {
      return await run();
    } finally {
      checksRunning--;
      if (checksRunning === 0) {
        clearTimeout(checkingTimer);
        checkingTimer = undefined;
        showChecking = false;
        renderStatusBar();
      }
    }
  }
  /** Every bundle found in the open folders, checked or not, in the order found. */
  const foundBundles = new Set<string>();

  let lastStatusBarBundle: string | undefined;
  /** What the item shows now, for the e2e tests, which can't read the status bar. */
  let shownStatusBar: StatusBarView | undefined;

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

  // Whether each bundle's folder ignores letter case, as found when it is first watched.
  const ignoresCaseByRoot = new Map<string, boolean>();

  /**
   * The bundle an editor's file belongs to: the bundle file itself, or a file the bundle's
   * last check loaded through `include`, by the CLI's own list.
   */
  function bundleOfEditor(editor: vscode.TextEditor | undefined): string | undefined {
    const filePath = editor?.document.uri.scheme === "file" ? editor.document.fileName : undefined;
    if (!filePath) return undefined;
    return (
      getBundleDirFromEditor(editor) ??
      bundleThatLoaded(filePath, bundleLoadedFiles(), (root) => ignoresCaseByRoot.get(root) ?? false)
    );
  }

  // Shows Inspect on a resource file. One key for the file in front, set here, because the
  // extension compares paths the way the save handler does, on every platform; a list of
  // paths matched by `resourcePath in ...` would rely on VS Code's spelling of a path.
  let activeFileInBundle: boolean | undefined;
  function updateActiveFileContext(): void {
    const inBundle = bundleOfEditor(vscode.window.activeTextEditor) !== undefined;
    if (inBundle === activeFileInBundle) return;
    activeFileInBundle = inBundle;
    void vscode.commands.executeCommand("setContext", "databricksBundleInspector.activeFileInBundle", inBundle);
  }

  function renderStatusBar(): void {
    // Runs after every check and editor change, which is when the active file's bundle can change.
    updateActiveFileContext();
    const roots = [...foundBundles];
    const baseView = statusBarView(
      roots.map((root) => ({
        name: path.basename(root),
        state: checkStates.get(root) ?? "pending",
        count: bundleProblemCount(root, diagnosticCollection),
        contents: bundleContentsByRoot.get(root),
        cliIssue: cliIssues.get(root),
      })),
      roots.length > 1 ? folderProblemCount(roots, diagnosticCollection) : undefined,
    );
    if (!baseView) {
      shownStatusBar = undefined;
      statusBarItem.hide();
      return;
    }
    const view = showChecking
      ? checkingView(
          baseView,
          vscode.workspace.getConfiguration("workbench").get("reduceMotion") === "on",
        )
      : baseView;
    statusBarItem.text = view.text;
    shownStatusBar = view;
    if (view.tooltipList) {
      const tooltip = new vscode.MarkdownString();
      if (view.tooltip) {
        tooltip.appendText(view.tooltip);
        tooltip.appendMarkdown("\n\n");
      }
      for (const line of view.tooltipList) {
        tooltip.appendMarkdown("- ");
        tooltip.appendText(line);
        tooltip.appendMarkdown("\n");
      }
      if (view.tooltipMore) {
        // The picker lists every bundle with its result, so the rest are one click away.
        tooltip.isTrusted = { enabledCommands: [STATUS_BAR_COMMAND] };
        tooltip.appendMarkdown(`\n[Show ${view.tooltipMore} more](command:${STATUS_BAR_COMMAND})`);
      }
      statusBarItem.tooltip = tooltip;
    } else {
      statusBarItem.tooltip = view.tooltip;
    }
    statusBarItem.backgroundColor = view.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    statusBarItem.show();
  }

  function recordCheck(
    bundleRoot: string,
    result: BundleValidationResult,
    graph: Parameters<typeof bundleContents>[0] | undefined,
    options: { inspected?: boolean } = {},
  ): void {
    checkStates.set(bundleRoot, checkStateOf(result));
    if (result.ok && graph) {
      bundleContentsByRoot.set(bundleRoot, bundleContents(graph));
    } else {
      bundleContentsByRoot.delete(bundleRoot);
    }
    if (!result.ok && result.error.cliProblem) {
      cliIssues.set(bundleRoot, {
        problem: result.error.cliProblem,
        ...(result.error.cliVersionOutput !== undefined
          ? { versionOutput: result.error.cliVersionOutput }
          : {}),
      });
    } else {
      cliIssues.delete(bundleRoot);
    }
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
    // A bundle whose file was deleted is no longer one: forget it rather than report it unchecked.
    if (!hasBundleFile(bundleRoot)) {
      forgetBundle(bundleRoot);
      return undefined;
    }
    runningRefreshes.add(bundleRoot);
    try {
      const { result, graph } = await whileChecking(() =>
        runBundleDiagnostics(
          bundleRoot,
          currentConfiguredCliPath(),
          diagnosticCollection,
          fileToBundleRoot,
        ),
      );
      recordCheck(bundleRoot, result, graph);
      if (result.ok && graph) {
        await watchBundle(bundleRoot, result.data, graph);
      }
      if (livePanel() && activeBundleDir === bundleRoot) {
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

  /** Drops a bundle that is gone: its diagnostics, its watchers, and its place in the status bar. */
  function forgetBundle(bundleRoot: string): void {
    forgetBundleDiagnostics(bundleRoot, diagnosticCollection);
    const watch = bundleWatches.get(bundleRoot);
    watch?.rootWatcher.dispose();
    watch?.outsideWatchers.forEach((watcher) => watcher.dispose());
    bundleWatches.delete(bundleRoot);
    const pending = pendingRefreshes.get(bundleRoot);
    if (pending) clearTimeout(pending.timer);
    pendingRefreshes.delete(bundleRoot);
    foundBundles.delete(bundleRoot);
    checkStates.delete(bundleRoot);
    cliIssues.delete(bundleRoot);
    bundleContentsByRoot.delete(bundleRoot);
    if (lastStatusBarBundle === bundleRoot) lastStatusBarBundle = undefined;
    renderStatusBar();
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
      for (const folder of event.removed) {
        for (const root of [...foundBundles]) {
          if (root === folder.uri.fsPath || root.startsWith(folder.uri.fsPath + path.sep)) forgetBundle(root);
        }
      }
      void checkBundlesIn(event.added);
    }),
  );

  let activePanel: vscode.WebviewPanel | undefined;

  /**
   * The graph panel if it is still open. A closed panel throws on `.webview`; when its
   * close was missed it would otherwise stay "active" for the rest of the session, and
   * every Inspect and refresh would fail with "Webview is disposed".
   */
  function livePanel(): vscode.WebviewPanel | undefined {
    if (!activePanel) return undefined;
    try {
      void activePanel.webview;
      return activePanel;
    } catch {
      activePanel = undefined;
      return undefined;
    }
  }
  let activeBundleData: unknown;
  let activeBundleDir: string | undefined;
  let activeRequestedTarget: string | undefined;
  /**
   * Why the picked target fell back to the preview. Saves then refresh the preview only,
   * instead of running the failing target again; picking it again in the graph retries it.
   */
  let activeTargetFallback: TargetFallback | undefined;
  /**
   * Counts the user's own inspections (Inspect, a target picked in the graph). A check that
   * finishes after a newer one started is dropped. Save refreshes don't count: a refresh
   * that ran into the user's own pick would drop the pick, and with it the job asked for.
   */
  let latestGraphCheck = 0;
  let activeTargetOptions: string[] = [];
  let activeStructuralResolutionBundle: ParsedBundleConfig | undefined;

  function fallbackOf(inspection: { fallbackMessage?: string | undefined; fallbackReason?: string | undefined }): TargetFallback | undefined {
    return inspection.fallbackMessage === undefined
      ? undefined
      : { message: inspection.fallbackMessage, reason: inspection.fallbackReason ?? inspection.fallbackMessage };
  }

  async function inspectBundleAtTarget(bundleDir: string, requestedTarget?: string) {
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
    let fallbackReason: string | undefined;
    let fallbackErrorCode: string | undefined;

    if (!result.ok && requestedTarget) {
      ({ message: fallbackMessage, reason: fallbackReason } = targetFallback(result.error));
      fallbackErrorCode = result.error.errorCode;
      result = await validateBundle(bundleDir, undefined, configuredPath);
      inspectedTarget = BUNDLE_PROBE_TARGET;
      inspectedTargetMode = "probe";
      // No pop-up: the graph is on screen and says why it shows the preview.
    }

    if (!result.ok) {
      return { result, inspectedTarget, inspectedTargetMode, fallbackMessage, fallbackReason, fallbackErrorCode };
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
      // The whole config, as the Problems panel's check has it: `sync` and `include` decide
      // the sync and include checks. Only variables and targets come from the merge.
      { ...bundleData, ...resolutionBundle },
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
      fallbackReason,
      fallbackErrorCode,
    };
  }

  function postBundleData(data: object) {
    activeBundleData = data;
    livePanel()?.webview.postMessage({
      type: "bundleData",
      ...data,
    });
  }

  function bundleMessageDataFromInspection(
    inspection: Awaited<ReturnType<typeof inspectBundleAtTarget>>,
    requestedTarget?: string,
    options?: { focusIssues?: boolean; initialJobKey?: string | undefined; preserveView?: boolean },
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
      targetFallbackReason: inspection.fallbackReason ?? null,
      profileChoice: requestedTarget ? ambiguousProfilesOf(inspection) ?? null : null,
      focusIssuesNonce: options?.focusIssues ? Date.now() : null,
      preserveView: options?.preserveView === true,
      // The job a resource file defines, so the graph opens on it. A nonce, as the same job
      // may be asked for again after the user picked another.
      initialJob: options?.initialJobKey ? { key: options.initialJobKey, nonce: Date.now() } : null,
    };
  }

  /**
   * Several profiles in ~/.databrickscfg match the picked target's workspace and the CLI
   * won't choose. The graph offers a choice instead of the CLI's advice to set
   * DATABRICKS_CONFIG_PROFILE or pass --profile, which an extension user can't do.
   */
  function ambiguousProfilesOf(
    inspection: Awaited<ReturnType<typeof inspectBundleAtTarget>>,
  ): { host: string; names: string[] } | undefined {
    const messages = [
      ...(inspection.result.ok
        ? (inspection.result.issues ?? []).flatMap((issue) => [
            ...(issue.diagnostics ?? []).map((d) => d.message),
            issue.details ?? "",
          ])
        : []),
      inspection.fallbackMessage ?? "",
    ];
    for (const message of messages) {
      const found = parseAmbiguousProfiles(message);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Lets the user pick the login profile for real targets and saves it in their user
   * settings. With a host, only that workspace's profiles are offered. Returns whether
   * the setting changed.
   */
  async function chooseProfile(match?: { host: string; names: string[] }): Promise<boolean> {
    const cli = await resolveDatabricksCli(currentConfiguredCliPath());
    const all = cli.ok ? await listProfiles(cli.candidate) : [];
    const offered = match
      ? profilesForHost(all, match.host).length > 0
        ? profilesForHost(all, match.host)
        : match.names.map((name): DatabricksProfile => ({ name }))
      : all;
    const current = getConfiguredProfile(getConfiguration());
    const USE_DEFAULT = "Use the Databricks CLI's own choice";
    const items: vscode.QuickPickItem[] = [
      ...offered.map((profile) => ({
        label: profile.name,
        ...(profile.host ? { description: profile.host } : {}),
        ...(profile.name === current ? { detail: "Currently selected" } : {}),
      })),
      ...(match ? [] : [{ label: USE_DEFAULT, description: "Clears the saved profile" }]),
    ];
    if (offered.length === 0) {
      const clear = "Clear saved profile";
      const choice = await vscode.window.showInformationMessage(
        "No Databricks login profiles were found. Run `databricks auth login` in a terminal to add one." +
          (current ? ` The saved profile "${current}" no longer exists.` : ""),
        ...(current ? [clear] : []),
      );
      if (choice !== clear) return false;
      await getConfiguration().update("profile", undefined, vscode.ConfigurationTarget.Global);
      return true;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: "Databricks login profile",
      placeHolder: match
        ? "Several profiles match this workspace. Choose the one to use for real targets."
        : "Choose the profile to use when you pick a target in the graph",
    });
    if (!picked) return false;
    const value = picked.label === USE_DEFAULT ? undefined : picked.label;
    if (value === current) return false;
    await getConfiguration().update("profile", value, vscode.ConfigurationTarget.Global);
    return true;
  }

  async function refreshActiveBundlePanel(
    bundleDir: string,
    options?: { refreshTargets?: boolean },
  ) {
    // Dropped if the user inspects again while it runs; it never drops their inspection.
    const check = latestGraphCheck;
    try {
      let probeInspection: Awaited<ReturnType<typeof inspectBundleAtTarget>> | undefined;
      if (options?.refreshTargets) {
        probeInspection = await inspectBundleAtTarget(bundleDir, undefined);
        if (check !== latestGraphCheck) return;
        if (
          activeRequestedTarget &&
          activeTargetOptions.length > 0 &&
          !activeTargetOptions.includes(activeRequestedTarget)
        ) {
          activeRequestedTarget = undefined;
          activeTargetFallback = undefined;
        }
        if (!activeRequestedTarget) {
          const messageData = bundleMessageDataFromInspection(probeInspection, undefined, { preserveView: true });
          if (messageData) {
            postBundleData(messageData);
          }
          return;
        }
      }

      // A target that fell back is not run again on save: the preview is refreshed, and
      // the graph keeps saying why the target isn't shown.
      const fellBack = activeTargetFallback !== undefined;
      const inspected =
        fellBack && probeInspection
          ? probeInspection
          : await inspectBundleAtTarget(bundleDir, fellBack ? undefined : activeRequestedTarget);
      if (check !== latestGraphCheck) return;
      const inspection = fellBack
        ? { ...inspected, fallbackMessage: activeTargetFallback?.message, fallbackReason: activeTargetFallback?.reason }
        : inspected;
      if (!fellBack) activeTargetFallback = fallbackOf(inspected);
      const messageData = bundleMessageDataFromInspection(
        inspection,
        activeRequestedTarget,
        { preserveView: true },
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
        from_resource_file: fromResourceFile,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...properties,
      });
    const editor = vscode.window.activeTextEditor;
    const bundleDir = bundleDirOverride ?? bundleOfEditor(editor);
    // Started from a resource file `include` loads, not from the bundle file.
    const fromResourceFile =
      !bundleDirOverride && bundleDir !== undefined && !getBundleDirFromEditor(editor);
    const initialJobKey =
      fromResourceFile && editor
        ? jobKeyAtLine(editor.document.getText(), editor.selection.active.line)
        : undefined;

    if (!bundleDir) {
      const openPanel = livePanel();
      if (options?.focusIssues && openPanel && activeBundleData) {
        openPanel.reveal(vscode.ViewColumn.One);
        openPanel.webview.postMessage({ type: "focusIssues" });
        return;
      }
      logInspect("no_bundle_file");
      vscode.window.showInformationMessage(
        "Open a databricks.yml file, or a resource file it includes, then run Inspect Databricks Bundle.",
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
      activeTargetFallback = undefined;
      const check = ++latestGraphCheck;
      await trackBundleFiles(bundleDir, fileToBundleRoot);
      const inspection = await whileChecking(() =>
        inspectBundleAtTarget(bundleDir, requestedTarget),
      );
      // A newer pick or refresh started while this ran, such as the preview picked right
      // after a slow target: showing this one would put the older choice back.
      if (check !== latestGraphCheck) return;
      activeTargetFallback = fallbackOf(inspection);
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
        recordCheck(bundleDir, result, diagnosticsGraph, { inspected: true });
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
      // A picked target's errors are listed in the graph, which is on screen, so no pop-up.
      if (errorDiagnostics.length > 0 && showsPreview) {
        const suffix = errorDiagnostics.length > 1 ? ` (and ${errorDiagnostics.length - 1} more)` : "";
        const firstMessage = errorDiagnostics[0]?.message ?? "Unknown error";
        void vscode.window.showWarningMessage(
          `The bundle has validation errors, so the graph may be incomplete. ${firstMessage}${suffix}`,
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
        // A target that failed for lack of a login falls back to the preview, whose result
        // has no auth issue, so the reason for the fallback counts too.
        auth_configured:
          inspection.fallbackErrorCode !== "AUTH_NOT_CONFIGURED" &&
          !(result.issues ?? []).some((issue) => issue.code === "AUTH_NOT_CONFIGURED"),
        target_count: countBucket(inspection.targetOptions?.length ?? 0),
        job_count: countBucket(graphNodes.filter((n) => n.nodeType === "job").length),
        task_count: countBucket(graphNodes.filter((n) => n.nodeType === "task").length),
        task_kinds: taskKinds(graphNodes),
        issue_count: countBucket(inspection.inspectorIssues?.length ?? 0),
      });

      const bundleMessageData = bundleMessageDataFromInspection(
        inspection,
        requestedTarget,
        { ...options, initialJobKey, preserveView: options?.trigger === "target_switch" },
      );
      if (!bundleMessageData) return;

      // Create or show webview panel
      const shown = livePanel();
      if (shown) {
        shown.reveal(vscode.ViewColumn.One);
        postBundleData(bundleMessageData);
      } else {
        const created = vscode.window.createWebviewPanel(
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
        activePanel = created;
        // Before anything awaits: a panel closed while its HTML loads must not stay active.
        // Only this panel's own close clears it, not an older panel's late one.
        created.onDidDispose(() => {
          if (activePanel === created) activePanel = undefined;
        });

        created.webview.onDidReceiveMessage((message) => {
          if (message?.type === "webviewReady" && activeBundleData) {
            created.webview.postMessage({
              type: "bundleData",
              ...(activeBundleData as object),
            });
          }
          if (
            message?.type === "selectTarget" &&
            (typeof message.target === "string" || message.target === null)
          ) {
            void selectTarget(typeof message.target === "string" ? message.target : undefined);
          }
          if (message?.type === "chooseProfile") {
            void chooseProfileFromGraph();
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

        // Kept even if the panel closes while its page loads (a quick close, or a close
        // still under way from before): the next panel then gets it on "webviewReady".
        activeBundleData = bundleMessageData;
        try {
          created.webview.html = await getWebviewContent(
            created.webview,
            extensionContext.extensionUri,
          );
        } catch (error) {
          if (livePanel() !== created) return;
          throw error;
        }
        // Closed while loading: nothing to show it in.
        if (livePanel() !== created) return;

        postBundleData(bundleMessageData);
      }
    } catch (error) {
      logInspect("exception");
      vscode.window.showErrorMessage(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A target picked in the graph's dropdown, or the structural preview for `undefined`. */
  async function selectTarget(target: string | undefined): Promise<void> {
    const bundleDirForPanel = activeBundleDir;
    if (!bundleDirForPanel) return;
    await inspectBundle(target, { trigger: "target_switch" }, bundleDirForPanel);
  }

  /** The graph's "Choose profile" button: pick one of the matching profiles, then check the target again. */
  async function chooseProfileFromGraph(): Promise<void> {
    const match = (activeBundleData as { profileChoice?: { host: string; names: string[] } } | undefined)
      ?.profileChoice;
    if (await chooseProfile(match ?? undefined)) await selectTarget(activeRequestedTarget);
  }

  // Only when VS Code runs the e2e tests (--extensionTestsPath), never for users: the
  // tests cannot click in the graph, so they pick a target the way its dropdown does and
  // read what the graph was last sent.
  if (extensionContext.extensionMode === vscode.ExtensionMode.Test) {
    extensionContext.subscriptions.push(
      vscode.commands.registerCommand(
        "databricksBundleInspector.test.selectTarget",
        async (target?: string) => {
          await selectTarget(target);
          return activeBundleData;
        },
      ),
      vscode.commands.registerCommand(
        "databricksBundleInspector.test.graphData",
        () => activeBundleData,
      ),
      vscode.commands.registerCommand("databricksBundleInspector.test.statusBar", () => ({
        view: shownStatusBar,
        folderCount: folderProblemCount(foundBundles, diagnosticCollection),
      })),
      vscode.commands.registerCommand(
        "databricksBundleInspector.test.chooseProfileFromGraph",
        async () => {
          await chooseProfileFromGraph();
          return activeBundleData;
        },
      ),
    );
  }

  extensionContext.subscriptions.push(
    vscode.commands.registerCommand("databricksBundleInspector.chooseProfile", async () => {
      // A graph showing a real target checks it again with the new profile.
      if ((await chooseProfile()) && livePanel() && activeRequestedTarget) {
        await selectTarget(activeRequestedTarget);
      }
    }),
  );

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
  extensionContext.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: "file", language: "yaml" }],
      new InspectorQuickFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    // Runs after a quick fix is applied: counts which kind of fix, never the values.
    vscode.commands.registerCommand(QUICK_FIX_APPLIED_COMMAND, (kind: unknown) => {
      if (kind === "notebook_missing_extension" || kind === "include_matches_nothing") {
        telemetry?.logUsage("quick_fix_applied", { kind });
      }
    }),
  );

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
            cliIssues.get(root),
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
