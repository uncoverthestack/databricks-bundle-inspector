import * as vscode from "vscode";
import path from "path";
import { existsSync, readFileSync } from "fs";
import {
  BUNDLE_PROBE_TARGET,
  validateBundle,
  extractBundleGraph,
} from "./bundle/validateBundle.js";
import type { BundleResult } from "./bundle/validateBundle.js";
import { targetFallback, type FallbackCode, type TargetFallback } from "./bundle/fallbackReason.js";
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
import { isOlderThanSupported, MIN_SUPPORTED_CLI_VERSION, telemetryCliVersion } from "./databricksCli/parsing.js";
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
import { QUICK_FIX_KINDS, type SidebarAction, type TelemetryProperties } from "./telemetry/schema.js";
import { createTelemetry, type Telemetry } from "./telemetry/telemetry.js";
import {
  BundleProgressTracker,
  checkOwners,
  gitHead,
  progressFindings,
  type CheckObservation,
} from "./telemetry/bundleProgress.js";
import { InspectorQuickFixProvider, QUICK_FIX_APPLIED_COMMAND } from "./extension/quickFixes.js";
import {
  countBucket,
  fileKind,
  parseWebviewTelemetryMessage,
  taskKinds,
} from "./telemetry/events.js";
import { isBundlePath, isOpenFilePathAllowed } from "./extension/paths.js";
import {
  cliFileName,
  cliFilesOnPath,
  configureCliLookup,
  fileRunByName,
  realLookupEnvironment,
  storedWindowsPath,
} from "./databricksCli/cliCandidates.js";
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
  completeCheckFindings,
  bundleProblems,
  type BundleProblem,
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
import {
  bundleRow,
  bundlesMessage,
  cliCandidates,
  cliChoices,
  cliRow,
  graphRow,
  pathHints,
  problemsRow,
  profileRow,
  targetLine,
  targetsRow,
  type CliCandidate,
  type SidebarBundle,
  type SidebarCli,
} from "./extension/sidebar.js";
import {
  BUNDLES_VIEW,
  BundlesTreeProvider,
  CHOOSE_CLI_COMMAND,
  OPEN_PROBLEMS_COMMAND,
  OPEN_TARGET_COMMAND,
  SETTINGS_VIEW,
  SIDEBAR_ORIGIN,
  SettingsTreeProvider,
  type BundlesElement,
} from "./extension/sidebarView.js";
import { NEW_ISSUE_URL, usageDocsUrl } from "./bundle/issueDocs.js";
import { createCheckLimiter } from "./extension/checkLimiter.js";

// Re-exported so existing imports of it from this module keep working.
export { isOpenFilePathAllowed };

/** A sidebar shown this soon after the extension started counts as reopened by VS Code. */
const SIDEBAR_AT_START_MS = 5_000;

type InspectTrigger = "command" | "issues_command" | "target_switch" | "status_bar" | "sidebar";

let telemetry: Telemetry | undefined;

export function activate(extensionContext: vscode.ExtensionContext) {
  console.log('Extension "databricks-bundle-inspector" is now active!');
  const activatedAt = Date.now();
  // Each sidebar action once per window: whether it is used, not how often or in what order.
  const sidebarActionsLogged = new Set<SidebarAction>();
  function logSidebarAction(action: SidebarAction): void {
    if (sidebarActionsLogged.has(action)) return;
    sidebarActionsLogged.add(action);
    telemetry?.logUsage("sidebar_action", { action });
  }
  telemetry = createTelemetry(extensionContext);
  // Under test, every event the extension logs, so the e2e can check what is counted.
  const loggedEvents: Array<{ event: string; properties: TelemetryProperties }> = [];
  if (extensionContext.extensionMode === vscode.ExtensionMode.Test) {
    const inner = telemetry;
    telemetry = {
      logUsage: (event, properties) => {
        loggedEvents.push({ event, properties: properties ?? {} });
        inner?.logUsage(event, properties);
      },
      isEnabled: () => inner?.isEnabled() ?? false,
      shutdown: () => inner?.shutdown() ?? Promise.resolve(),
    };
  }
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
  /** The targets each bundle's last check listed, for the sidebar. */
  const targetsByRoot = new Map<string, string[]>();
  /** The Databricks CLI the checks use, for the sidebar's Settings. */
  let sidebarCli: SidebarCli;
  /** Counts each write of {@link sidebarCli}, so a lookup that a newer one overtook doesn't overwrite it. */
  let sidebarCliWrites = 0;
  /** Checks running now. The item turns only when one runs longer than a moment. */
  let checksRunning = 0;
  let showChecking = false;
  let checkingTimer: ReturnType<typeof setTimeout> | undefined;
  const CHECKING_DELAY_MS = 500;

  // Set once the sidebar's views exist, at the end of activation.
  let refreshSidebar: (() => void) | undefined;
  // Ends the progress bar on the Bundles view when the last check finishes.
  let endViewProgress: (() => void) | undefined;

  async function whileChecking<T>(run: () => Promise<T>): Promise<T> {
    checksRunning++;
    checkingTimer ??= setTimeout(() => {
      showChecking = true;
      renderStatusBar();
    }, CHECKING_DELAY_MS);
    if (!endViewProgress) {
      // Made before withProgress runs its task, so a second check never starts a second bar.
      const finished = new Promise<void>((resolve) => (endViewProgress = resolve));
      void vscode.window.withProgress({ location: { viewId: BUNDLES_VIEW } }, () => finished);
    }
    try {
      return await run();
    } finally {
      checksRunning--;
      if (checksRunning === 0) {
        clearTimeout(checkingTimer);
        checkingTimer = undefined;
        showChecking = false;
        endViewProgress?.();
        endViewProgress = undefined;
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
    refreshSidebar?.();
    const roots = [...foundBundles];
    const baseView = statusBarView(
      roots.map((root) => ({
        name: path.basename(root),
        state: checkStates.get(root) ?? "pending",
        count: bundleProblemCount(root),
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

  /**
   * Counts how often each bundle was forgotten (its folder removed, its file deleted). A
   * check started before that is about a bundle that is gone, and is dropped on finishing.
   */
  const bundleGenerations = new Map<string, number>();
  const generationOf = (bundleRoot: string) => bundleGenerations.get(bundleRoot) ?? 0;

  /** Records a check's result, unless the bundle was forgotten since `generation`. Says whether it did. */
  function recordCheck(
    bundleRoot: string,
    result: BundleValidationResult,
    graph: BundleGraph | undefined,
    options: { inspected?: boolean; cliPath: string | undefined; generation: number },
  ): boolean {
    if (generationOf(bundleRoot) !== options.generation) {
      // The check wrote its findings as it finished; they belong to no bundle now.
      forgetBundleDiagnostics(bundleRoot, diagnosticCollection);
      renderStatusBar();
      return false;
    }
    checkStates.set(bundleRoot, checkStateOf(result));
    // A failed check lists no targets; keep the last ones rather than show none.
    if (result.ok) targetsByRoot.set(bundleRoot, result.targetOptions ?? []);
    if (!result.ok && result.error.cliProblem && options.cliPath === currentConfiguredCliPath()) {
      // The check already says why; a lookup of a missing CLI isn't cached and would run again.
      // Not when the cliPath setting changed while it ran: its CLI is no longer the one in use.
      sidebarCliWrites++;
      sidebarCli = {
        ok: false,
        issue: {
          problem: result.error.cliProblem,
          ...(result.error.cliVersionOutput !== undefined ? { versionOutput: result.error.cliVersionOutput } : {}),
        },
      };
    } else {
      void updateSidebarCli();
    }
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
    observeProgress(bundleRoot, result, graph);
    foundBundles.add(bundleRoot);
    // The bundle whose graph was just opened is the one the user is looking at.
    if (options.inspected) lastStatusBarBundle = bundleRoot;
    renderStatusBar();
    return true;
  }
  // Whether findings get resolved, compared between complete checks of the same bundle on
  // this machine. Only a daily summary, in ranges, is sent; see telemetry/bundleProgress.ts.
  const PROGRESS_STORAGE_KEY = "telemetry.bundleProgress";
  const progress = new BundleProgressTracker({
    get: () => extensionContext.globalState.get(PROGRESS_STORAGE_KEY),
    set: (state) => extensionContext.globalState.update(PROGRESS_STORAGE_KEY, state),
  });
  const extensionVersion = String(extensionContext.extension.packageJSON.version ?? "");
  let progressUpdates: Promise<void> = Promise.resolve();
  function observeProgress(
    bundleRoot: string,
    result: BundleValidationResult,
    graph: BundleGraph | undefined,
  ): void {
    // Read now, before the next check replaces them.
    const issues = result.ok && graph ? completeCheckFindings(bundleRoot) : undefined;
    const nodeIds = graph?.nodes.map((node) => node.id) ?? [];
    const loadedFiles = [...(bundleLoadedFiles().get(bundleRoot) ?? [])];
    // One at a time, so two checks never read and write the stored state at once.
    progressUpdates = progressUpdates
      .then(async () => {
        if (!telemetry?.isEnabled()) {
          progress.clear();
          return;
        }
        let observation: CheckObservation = { complete: false };
        if (issues) {
          // Cached from the check, so this doesn't start the CLI again.
          const cli = await resolveDatabricksCli(currentConfiguredCliPath());
          observation = {
            complete: true,
            conditions: [extensionVersion, cli.ok ? (cli.versionOutput ?? "") : "", gitHead(bundleRoot)].join("\n"),
            findings: progressFindings(issues),
            owners: checkOwners(nodeIds, loadedFiles, issues),
          };
        }
        const event = progress.observe(bundleRoot, observation);
        if (event) telemetry.logUsage("bundle_progress", event);
      })
      .catch((error) => console.warn("[BundleInspector] recording bundle progress failed:", error));
  }
  // With several bundles in the folder, the item follows the file in front.
  extensionContext.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => renderStatusBar()),
  );

  function currentConfiguredCliPath(): string | undefined {
    return getConfiguredDatabricksCliPath(getConfiguration());
  }

  /**
   * Every place a CLI could come from, in the order the lookup tries them. With
   * `withWindowsPath`, also the Path Windows has stored, which runs `reg query`.
   */
  async function cliCandidateList(withWindowsPath: boolean): Promise<CliCandidate[]> {
    const lookup = realLookupEnvironment();
    return cliCandidates({
      setting: currentConfiguredCliPath(),
      onPath: cliFilesOnPath(lookup.pathValue, lookup.platform, lookup.isFile),
      windowsPath:
        withWindowsPath && lookup.platform === "win32"
          ? cliFilesOnPath(await storedWindowsPath(lookup), lookup.platform, lookup.isFile)
          : [],
      databricksExtension: lookup.extraCandidates().filter((file) => lookup.isFile(file)),
      ignoreCase: lookup.platform === "win32",
    });
  }

  /** Finds the CLI the checks use, for the sidebar's Settings. Cached once found, so this runs nothing again. */
  async function updateSidebarCli(): Promise<void> {
    const write = ++sidebarCliWrites;
    let found: SidebarCli;
    try {
      const cli = await resolveDatabricksCli(currentConfiguredCliPath());
      if (cli.ok) {
        // The lookup runs `databricks` by name first; say which file that is, and where it is from.
        const candidates = await cliCandidateList(false);
        const byName = !cli.candidate.includes("/") && !cli.candidate.includes("\\");
        const lookup = realLookupEnvironment();
        const file = byName
          ? (fileRunByName(cliFilesOnPath(lookup.pathValue, lookup.platform, lookup.isFile), lookup.platform) ?? cli.candidate)
          : cli.candidate;
        const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
        // A cliPath setting of just `databricks` still runs it by name, but from the setting.
        const fromSetting = cli.candidate === currentConfiguredCliPath();
        const source = fromSetting
          ? "setting"
          : (candidates.find((candidate) => same(candidate.path, file))?.source ??
            (byName || process.platform !== "win32" ? "path" : "windowsPath"));
        found = { ok: true, path: file, version: cli.versionOutput, source };
      } else {
        found = {
          ok: false,
          issue: { problem: cli.problem, ...(cli.versionOutput !== undefined ? { versionOutput: cli.versionOutput } : {}) },
        };
      }
    } catch (error) {
      console.warn("[BundleInspector] looking up the CLI for the sidebar failed:", error);
      found = undefined;
    }
    // A lookup started later, or a check that said why the CLI can't be used, wins.
    if (write !== sidebarCliWrites) return;
    sidebarCli = found;
    refreshSidebar?.();
  }

  // Maps inspected bundle-related files (databricks.yml + its includes) to their bundle root.
  // Populated lazily for the active bundle, then kept up-to-date after each CLI run.
  const fileToBundleRoot = new Map<string, string>();

  extensionContext.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("databricksBundleInspector.cliPath")) {
        invalidateDatabricksCliCache();
        void updateSidebarCli();
      }
      if (event.affectsConfiguration("databricksBundleInspector.profile")) refreshSidebar?.();
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
  /** Of those, the ones still waiting for a free slot: the sidebar doesn't show them as checking yet. */
  const waitingRefreshes = new Set<string>();
  // At most two checks run the CLI at once; the others wait their turn, in order.
  const checkSlots = createCheckLimiter(2);

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
    const generation = generationOf(bundleRoot);
    runningRefreshes.add(bundleRoot);
    waitingRefreshes.add(bundleRoot);
    await checkSlots.acquire();
    try {
      waitingRefreshes.delete(bundleRoot);
      refreshSidebar?.();
      // Forgotten (its folder removed) while it waited for its turn.
      if (generationOf(bundleRoot) !== generation) return undefined;
      // Deleted while it waited for its turn.
      if (!hasBundleFile(bundleRoot)) {
        forgetBundle(bundleRoot);
        return undefined;
      }
      const cliPath = currentConfiguredCliPath();
      const { result, graph } = await whileChecking(() =>
        runBundleDiagnostics(
          bundleRoot,
          cliPath,
          diagnosticCollection,
          fileToBundleRoot,
        ),
      );
      if (!recordCheck(bundleRoot, result, graph, { cliPath, generation })) return undefined;
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
      checkSlots.release();
      runningRefreshes.delete(bundleRoot);
      refreshSidebar?.();
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
    bundleGenerations.set(bundleRoot, generationOf(bundleRoot) + 1);
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
    targetsByRoot.delete(bundleRoot);
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
    /** The CLI's `major.minor`, when one was found and its version could be read. */
    cliVersion: string | undefined;
    /** Errors and warnings the checks put in the Problems panel. Undefined when nothing was checked. */
    issueCount: number | undefined;
  }
  /** The sidebar says "no bundle found" only after looking, not while it looks. */
  function bundlesSearched(): void {
    void vscode.commands.executeCommand("setContext", "databricksBundleInspector.bundlesSearched", true);
  }

  /** Every bundle in the folders, by the same rules on open and on Check All. */
  async function findBundleRoots(folders: readonly vscode.WorkspaceFolder[]): Promise<string[]> {
    const found = await Promise.all(
      folders
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) =>
          vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, BUNDLE_FILE_GLOB),
            SKIPPED_FOLDERS_GLOB,
            BUNDLE_SEARCH_MAX_FILES,
          ),
        ),
    );
    return selectBundleRoots(found.flat().map((uri) => uri.fsPath), Infinity);
  }

  async function checkBundlesIn(
    folders: readonly vscode.WorkspaceFolder[],
  ): Promise<OpenFoldersCheck> {
    const check: OpenFoldersCheck = {
      bundleCount: 0,
      bundleAtRoot: false,
      cliFound: undefined,
      cliVersion: undefined,
      issueCount: undefined,
    };
    try {
      const localFolders = folders.filter((folder) => folder.uri.scheme === "file");
      const allRoots = await findBundleRoots(localFolders);
      check.bundleCount = allRoots.length;
      for (const bundleRoot of allRoots) foundBundles.add(bundleRoot);
      bundlesSearched();
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
        // Cached from the checks above, so this doesn't start the CLI again.
        const cli = await resolveDatabricksCli(currentConfiguredCliPath());
        check.cliVersion = cli.ok ? telemetryCliVersion(cli.versionOutput) : undefined;
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
    } finally {
      // Also when the search failed, so the view never stays on "Looking for bundles…".
      bundlesSearched();
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

  // A bundle made while the folder is open (`databricks bundle init` in a terminal, a
  // checkout, a copy) is found as it appears, by the same rules as on open. A deleted one
  // is forgotten by its own watcher's next check.
  const newBundleWatcher = vscode.workspace.createFileSystemWatcher(BUNDLE_FILE_GLOB, false, true, true);
  extensionContext.subscriptions.push(
    newBundleWatcher,
    newBundleWatcher.onDidCreate((uri) => {
      if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) return;
      const [bundleRoot] = selectBundleRoots([uri.fsPath], Infinity);
      if (!bundleRoot || foundBundles.has(bundleRoot)) return;
      foundBundles.add(bundleRoot);
      renderStatusBar();
      scheduleRefresh(bundleRoot, "config");
    }),
  );

  let activePanel: vscode.WebviewPanel | undefined;
  // The text selected in the graph when it was last right-clicked, for the menu's Copy.
  let contextMenuSelection = "";

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
  let activeTargetOptions: string[] = [];
  let activeStructuralResolutionBundle: ParsedBundleConfig | undefined;
  // The latest user navigation owns the panel, even if an older CLI finishes later.
  let activeInspectionId = 0;

  function fallbackOf(inspection: {
    fallbackMessage?: string | undefined;
    fallbackReason?: string | undefined;
    fallbackCode?: FallbackCode | undefined;
  }): TargetFallback | undefined {
    return inspection.fallbackMessage === undefined
      ? undefined
      : {
          message: inspection.fallbackMessage,
          reason: inspection.fallbackReason ?? inspection.fallbackMessage,
          code: inspection.fallbackCode ?? "other",
        };
  }

  async function inspectBundleAtTarget(bundleDir: string, requestedTarget?: string) {
    const previousTargetOptions = activeBundleDir === bundleDir ? activeTargetOptions : [];
    const previousStructuralBundle = activeBundleDir === bundleDir ? activeStructuralResolutionBundle : undefined;
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
    let fallbackCode: FallbackCode | undefined;
    let fallbackErrorCode: string | undefined;

    if (!result.ok && requestedTarget) {
      ({ message: fallbackMessage, reason: fallbackReason, code: fallbackCode } = targetFallback(result.error));
      fallbackErrorCode = result.error.errorCode;
      result = await validateBundle(bundleDir, undefined, configuredPath);
      inspectedTarget = BUNDLE_PROBE_TARGET;
      inspectedTargetMode = "probe";
      // No pop-up: the graph is on screen and says why it shows the preview.
    }

    if (!result.ok) {
      return { result, inspectedTarget, inspectedTargetMode, fallbackMessage, fallbackReason, fallbackCode, fallbackErrorCode };
    }

    const bundleData = result.data;
    const discoveredTargetOptions =
      result.targetOptions && result.targetOptions.length > 0
        ? result.targetOptions
        : Object.keys(
            (bundleData as { targets?: Record<string, unknown> }).targets ?? {},
          );
    const targetOptions = discoveredTargetOptions.length > 0 ? discoveredTargetOptions : previousTargetOptions;
    const structuralResolutionBundle = discoveredTargetOptions.length > 0 ? bundleData : previousStructuralBundle;
    const previousResolutionBundle: Partial<ParsedBundleConfig> =
      structuralResolutionBundle ?? {};
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
      targetOptions,
      structuralResolutionBundle,
      resolutionBundle,
      inspectedTarget,
      inspectedTargetMode,
      fallbackMessage,
      fallbackReason,
      fallbackCode,
      fallbackErrorCode,
    };
  }

  function rememberInspection(inspection: Awaited<ReturnType<typeof inspectBundleAtTarget>>): void {
    if (!inspection.result.ok) return;
    activeTargetOptions = inspection.targetOptions ?? [];
    activeStructuralResolutionBundle = inspection.structuralResolutionBundle;
  }

  /**
   * The bundle whose graph the panel holds now. Not {@link activeBundleDir}, which is set
   * as soon as a bundle is asked for: when that check fails, the panel still shows the
   * bundle before it.
   */
  let shownBundleDir: string | undefined;

  function postBundleData(bundleDir: string, data: object) {
    shownBundleDir = bundleDir;
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
    const panel = livePanel();
    if (!panel || activeBundleDir !== bundleDir) return;
    const inspectionId = activeInspectionId;
    let requestedTarget = activeRequestedTarget;
    const isCurrent = () => inspectionId === activeInspectionId && activeBundleDir === bundleDir && livePanel() === panel;
    try {
      let probeInspection: Awaited<ReturnType<typeof inspectBundleAtTarget>> | undefined;
      if (options?.refreshTargets) {
        probeInspection = await inspectBundleAtTarget(bundleDir, undefined);
        if (!isCurrent()) return;
        rememberInspection(probeInspection);
        if (
          requestedTarget &&
          activeTargetOptions.length > 0 &&
          !activeTargetOptions.includes(requestedTarget)
        ) {
          requestedTarget = undefined;
          activeRequestedTarget = undefined;
          activeTargetFallback = undefined;
        }
        if (!requestedTarget) {
          const messageData = bundleMessageDataFromInspection(probeInspection, undefined, { preserveView: true });
          if (messageData) {
            postBundleData(bundleDir, messageData);
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
          : await inspectBundleAtTarget(bundleDir, fellBack ? undefined : requestedTarget);
      if (!isCurrent()) return;
      rememberInspection(inspected);
      const inspection = fellBack
        ? { ...inspected, fallbackMessage: activeTargetFallback?.message, fallbackReason: activeTargetFallback?.reason, fallbackCode: activeTargetFallback?.code }
        : inspected;
      if (!fellBack) activeTargetFallback = fallbackOf(inspected);
      const messageData = bundleMessageDataFromInspection(
        inspection,
        requestedTarget,
        { preserveView: true },
      );
      if (messageData) {
        postBundleData(bundleDir, messageData);
      }
    } catch (error) {
      if (!isCurrent()) return;
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
  /** The CLI's version as `major.minor` for telemetry, or nothing when it can't be read. */
  async function cliVersionForTelemetry(result: BundleResult): Promise<string | undefined> {
    if (!result.ok && result.error.errorCode === "CLI_NOT_FOUND") return undefined;
    // Cached from the validate run, so this doesn't start the CLI again.
    const cli = await resolveDatabricksCli(currentConfiguredCliPath());
    return cli.ok ? telemetryCliVersion(cli.versionOutput) : undefined;
  }

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
        "Open a databricks.yml file, or a resource file it includes, then use Open Graph.",
      );
      return;
    }

    const inspectionId = ++activeInspectionId;
    const panelAtStart = livePanel();
    let closedDuringInspection = false;
    // A close that is already under way belongs to the previous request. Only a tab
    // still open when this request starts can cancel it by being closed afterward.
    const tabWasOpen = panelAtStart && vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputWebview && tab.label === panelAtStart.title && tab.input.viewType.endsWith(panelAtStart.viewType),
    ));
    const closeListener = tabWasOpen ? panelAtStart.onDidDispose(() => { closedDuringInspection = true; }) : undefined;
    const isCurrent = () => inspectionId === activeInspectionId && !closedDuringInspection;
    try {
      if (activeBundleDir !== bundleDir) {
        activeTargetOptions = [];
        activeStructuralResolutionBundle = undefined;
      }
      activeBundleDir = bundleDir;
      activeRequestedTarget = requestedTarget;
      activeTargetFallback = undefined;
      await trackBundleFiles(bundleDir, fileToBundleRoot);
      if (!isCurrent()) return;
      const cliPath = currentConfiguredCliPath();
      const generation = generationOf(bundleDir);
      const inspection = await whileChecking(() =>
        inspectBundleAtTarget(bundleDir, requestedTarget),
      );
      if (!isCurrent()) return;
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
        if (!isCurrent()) return;
        const recorded = recordCheck(bundleDir, result, diagnosticsGraph, { inspected: true, cliPath, generation });
        if (recorded && result.ok && diagnosticsGraph) {
          await watchBundle(bundleDir, result.data, diagnosticsGraph);
        }
      }

      const cliOutdated = await checkCliVersion(result);
      if (!isCurrent()) return;
      const cliVersion = await cliVersionForTelemetry(result);
      const cliVersionProperty = {
        ...(cliOutdated === undefined ? {} : { cli_outdated: cliOutdated }),
        ...(cliVersion ? { cli_version: cliVersion } : {}),
        ...(inspection.fallbackCode ? { fallback_reason: inspection.fallbackCode } : {}),
      };

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

      rememberInspection(inspection);
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
        postBundleData(bundleDir, bundleMessageData);
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
          // A target picked in a closed graph no longer applies to its bundle's row.
          refreshSidebar?.();
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
          if (message?.type === "contextMenuSelection" && typeof message.text === "string") {
            contextMenuSelection = message.text;
          }
          if (message?.type === "telemetry") {
            const parsed = parseWebviewTelemetryMessage(message);
            if (parsed) telemetry?.logUsage(parsed.event, parsed.properties);
          }
        });

        // Kept even if the panel closes while its page loads (a quick close, or a close
        // still under way from before): the next panel then gets it on "webviewReady".
        activeBundleData = bundleMessageData;
        shownBundleDir = bundleDir;
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
        if (!isCurrent() || livePanel() !== created) return;

        postBundleData(bundleDir, bundleMessageData);
      }
    } catch (error) {
      if (!isCurrent()) return;
      logInspect("exception");
      vscode.window.showErrorMessage(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      closeListener?.dispose();
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
      // What the sidebar shows: its rows' text, as the views are built from it.
      vscode.commands.registerCommand("databricksBundleInspector.test.telemetryEvents", () => [...loggedEvents]),
      vscode.commands.registerCommand("databricksBundleInspector.test.sidebar", () => {
        const bundles = sidebarBundles();
        return {
          message: bundlesMessage(bundles),
          bundles: bundles.map((bundle) => ({
            root: bundle.root,
            ...bundleRow(bundle),
            graph: graphRow(bundle),
            problems: problemsRow(bundle),
            targets: targetsRow(bundle),
          })),
          settings: { cli: cliRow(sidebarCli), profile: profileRow(getConfiguredProfile(getConfiguration())) },
        };
      }),
      vscode.commands.registerCommand("databricksBundleInspector.test.statusBar", () => ({
        view: shownStatusBar,
        folderCount: folderProblemCount(foundBundles, diagnosticCollection),
        checksPending: checksRunning > 0 || pendingRefreshes.size > 0 || runningRefreshes.size > 0,
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
    vscode.commands.registerCommand("databricksBundleInspector.chooseProfile", async (origin?: unknown) => {
      if (origin === SIDEBAR_ORIGIN) logSidebarAction("choose_profile");
      // A graph showing a real target checks it again with the new profile.
      if ((await chooseProfile()) && livePanel() && activeRequestedTarget) {
        await selectTarget(activeRequestedTarget);
      }
    }),
    // The graph's own Copy menu item. VS Code's built-in one copies nothing when its
    // native menu takes focus from the webview (microsoft/vscode#141080).
    vscode.commands.registerCommand("databricksBundleInspector.copySelection", async () => {
      if (contextMenuSelection) await vscode.env.clipboard.writeText(contextMenuSelection);
    }),
  );

  // The sidebar: every bundle found, what the graph checks each against, and the CLI and
  // profile the checks use. Rows are things; their actions are icons (see package.json).
  function bundleFilePath(root: string): string {
    const yml = path.join(root, "databricks.yml");
    return existsSync(yml) ? yml : path.join(root, "databricks.yaml");
  }
  function sidebarBundles(): SidebarBundle[] {
    // A target only applies to the row of the bundle the graph shows.
    const graphBundle = livePanel() !== undefined && shownBundleDir === activeBundleDir ? shownBundleDir : undefined;
    const places = [...foundBundles].map((root) => ({
      root,
      name: path.basename(root),
      displayPath: vscode.workspace.asRelativePath(bundleFilePath(root), true),
    }));
    const hints = pathHints(places);
    return places.map(({ root, name, displayPath }) => {
      const target = graphBundle === root ? activeRequestedTarget : undefined;
      const pathHint = hints.get(root);
      return {
        root,
        name,
        displayPath,
        ...(pathHint ? { pathHint } : {}),
        state: checkStates.get(root),
        count: bundleProblemCount(root),
        contents: bundleContentsByRoot.get(root),
        cliIssue: cliIssues.get(root),
        checking: runningRefreshes.has(root) && !waitingRefreshes.has(root),
        targets: targetsByRoot.get(root) ?? [],
        ...(target ? { graphTarget: { target, fellBack: activeTargetFallback !== undefined } } : {}),
      };
    });
  }
  const bundlesTree = new BundlesTreeProvider(sidebarBundles, {
    light: vscode.Uri.joinPath(extensionContext.extensionUri, "resources", "inspect-light.svg"),
    dark: vscode.Uri.joinPath(extensionContext.extensionUri, "resources", "inspect-dark.svg"),
  });
  const settingsTree = new SettingsTreeProvider(() => ({
    cli: sidebarCli,
    profile: getConfiguredProfile(getConfiguration()),
  }));
  const bundlesView = vscode.window.createTreeView(BUNDLES_VIEW, { treeDataProvider: bundlesTree });
  const settingsView = vscode.window.createTreeView(SETTINGS_VIEW, { treeDataProvider: settingsTree });

  // Once per window, the first time either view shows. Showing within a few seconds of
  // the start, it was most likely left open and reopened by VS Code, not opened by hand.
  let sidebarShown = false;
  const noteSidebarShown = (visible: boolean) => {
    if (!visible || sidebarShown) return;
    sidebarShown = true;
    telemetry?.logUsage("sidebar_opened", { at_start: Date.now() - activatedAt < SIDEBAR_AT_START_MS });
  };
  noteSidebarShown(bundlesView.visible || settingsView.visible);

  // One at a time, as on open, so many bundles never start many CLI runs at once.
  /**
   * Searches the open folders again first: on Linux, VS Code can miss a bundle file written
   * the instant its folder was made (`cp -r`), and then only this finds it.
   */
  async function checkAllBundles(): Promise<void> {
    const roots = await findBundleRoots(vscode.workspace.workspaceFolders ?? []);
    const added = roots.filter((root) => !foundBundles.has(root));
    for (const root of added) foundBundles.add(root);
    if (added.length > 0) renderStatusBar();
    for (const root of [...foundBundles]) await refreshBundle(root, checkAgainFlags);
  }
  refreshSidebar = () => {
    bundlesTree.refresh();
    settingsTree.refresh();
    // An empty message shows nothing above the rows.
    bundlesView.message = bundlesMessage(sidebarBundles()) ?? "";
  };

  /** Selects the open file's bundle, as the Explorer selects the open file. Never takes focus. */
  function revealOpenFileBundle(): void {
    if (!bundlesView.visible) return;
    const editor = vscode.window.activeTextEditor;
    const root =
      bundleOfEditor(editor) ?? bundleForFile([...foundBundles], editor?.document.uri.fsPath, path.sep);
    if (!root || !foundBundles.has(root)) return;
    bundlesView.reveal(bundlesTree.element("bundle", root), { select: true, focus: false }).then(
      undefined,
      (error: unknown) => console.warn("[BundleInspector] revealing the bundle in the sidebar failed:", error),
    );
  }

  /** Opens where a target is defined: the bundle file, or a file its `include` loads. */
  async function openTarget(root: string, target: string): Promise<void> {
    const files = [bundleFilePath(root), ...(bundleLoadedFiles().get(root) ?? [])];
    for (const file of files) {
      // An open file as the editor has it, unsaved edits included, so the line is the one shown.
      const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === file);
      let text: string;
      try {
        text = open ? open.getText() : readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const line = targetLine(text, target);
      if (line === undefined) continue;
      const position = new vscode.Position(line, 0);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { selection: new vscode.Range(position, position) });
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(bundleFilePath(root)));
  }

  /**
   * The sidebar's Graph row. A graph already open on this bundle comes to the front as it
   * is, with the target it shows, as the row says; otherwise it opens on the structural preview.
   */
  /** The graph of a bundle, from the sidebar. */
  async function openGraph(root: string): Promise<void> {
    const panel = livePanel();
    // Only a graph that shows this bundle: a failed check of it leaves the one before on screen.
    if (panel && shownBundleDir === root && activeBundleDir === root) {
      panel.reveal();
      return;
    }
    await inspectBundle(undefined, { trigger: "sidebar" }, root);
  }

  /** Opens a problem where it is, with its explanation below the line, as F8 does. */
  async function openProblem(problem: BundleProblem): Promise<void> {
    const start = problem.range.start;
    await vscode.window.showTextDocument(problem.uri, { selection: new vscode.Range(start, start) });
    // From a cursor on the problem, VS Code's own "next problem" opens that one.
    await vscode.commands.executeCommand("editor.action.marker.next");
  }

  /**
   * The Problems row: one problem opens where it is. Several, often in several files, are
   * listed first, by file, so the count matches what can be picked; moving through the
   * list shows each one in the editor. Problems with no line in a file are in the graph.
   */
  async function openBundleProblems(root: string): Promise<void> {
    const { inFiles, graphOnly } = bundleProblems(root);
    if (inFiles.length === 1 && graphOnly === 0) return openProblem(inFiles[0]!);
    if (inFiles.length === 0) {
      if (graphOnly > 0) await openGraph(root);
      return;
    }
    type Item = vscode.QuickPickItem & { problem?: BundleProblem; graph?: true };
    const items: Item[] = [];
    // Headings name the file only, so the messages keep their room; two files with the
    // same name get their folder too.
    const files = [...new Set(inFiles.map((problem) => problem.uri.fsPath))];
    const sameName = (file: string) => files.filter((other) => path.basename(other) === path.basename(file)).length > 1;
    let file: string | undefined;
    for (const problem of inFiles) {
      if (problem.uri.fsPath !== file) {
        file = problem.uri.fsPath;
        const name = path.basename(file);
        items.push({
          label: sameName(file) ? `${name} (${path.basename(path.dirname(file))})` : name,
          kind: vscode.QuickPickItemKind.Separator,
        });
      }
      // The task first: several tasks often share one message, such as the same missing file.
      const icon = problem.severity === vscode.DiagnosticSeverity.Error ? "$(error)" : "$(warning)";
      items.push({
        label: `${icon} ${problem.owner ? `${problem.owner} · ` : ""}${problem.message}`,
        description: `Ln ${problem.range.start.line + 1}`,
        problem,
      });
    }
    if (graphOnly > 0) {
      items.push(
        { label: "Only in the graph", kind: vscode.QuickPickItemKind.Separator },
        {
          label: `$(type-hierarchy) ${graphOnly === 1 ? "1 problem has" : `${graphOnly} problems have`} no line in a file`,
          description: "opens the graph",
          graph: true,
        },
      );
    }
    const total = inFiles.length + graphOnly;
    const picked = await vscode.window.showQuickPick(items, {
      title: `${path.basename(root)}: ${total} problems · structural preview`,
      placeHolder: "Go to a problem…",
      matchOnDescription: true,
      onDidSelectItem: (item) => {
        const problem = (item as Item).problem;
        if (!problem) return;
        const start = problem.range.start;
        void vscode.window.showTextDocument(problem.uri, {
          preview: true,
          preserveFocus: true,
          selection: new vscode.Range(start, start),
        });
      },
    });
    if (picked?.problem) {
      logSidebarAction("pick_problem");
      await openProblem(picked.problem);
    }
    else if (picked?.graph) await openGraph(root);
  }

  /** Checks every bundle again, after the CLI changed. */
  function recheckAllBundles(): Promise<void> {
    for (const root of foundBundles) scheduleRefresh(root, "config");
    return Promise.resolve();
  }

  /**
   * The Settings CLI row: every Databricks CLI found, with its version and where it is from,
   * the one in use ticked. Picking one saves it to the cliPath setting.
   */
  async function chooseCli(): Promise<void> {
    const candidates = await cliCandidateList(true);
    const checked = await Promise.all(
      candidates.map(async (candidate) => {
        const result = await verifyCliPath(candidate.path);
        return { ...candidate, isDatabricksCli: result.ok, version: result.ok ? result.versionOutput : undefined };
      }),
    );
    const inUse = sidebarCli?.ok ? sidebarCli.path : undefined;
    const choices = cliChoices(checked, inUse);
    type Item = vscode.QuickPickItem & { path?: string; action?: "browse" | "clear" | "install" };
    const items: Item[] = [
      ...choices.map((choice) => ({
        label: choice.inUse ? `$(check) ${choice.label}` : choice.label,
        description: choice.description,
        detail: choice.path,
        path: choice.path,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(folder-opened) Browse for the Databricks CLI…", description: "saves to the cliPath setting", action: "browse" },
      ...(currentConfiguredCliPath()
        ? [{ label: "$(discard) Use the one on PATH", description: "clears the cliPath setting", action: "clear" as const }]
        : []),
      ...(choices.length === 0
        ? [{ label: "$(link-external) Open the Databricks CLI Install Guide", action: "install" as const }]
        : []),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Choose the Databricks CLI",
      placeHolder: choices.length > 0 ? "Pick a CLI, or browse for one" : "No Databricks CLI found. Browse for one, or install it",
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked.action === "browse") return locateCli(recheckAllBundles);
    if (picked.action === "install") {
      void vscode.env.openExternal(vscode.Uri.parse(databricksCliInstallUrl(process.platform)));
      return;
    }
    if (picked.action === "clear") {
      await getConfiguration().update("cliPath", undefined, vscode.ConfigurationTarget.Global);
    } else if (picked.path && picked.path !== inUse) {
      await getConfiguration().update("cliPath", picked.path, vscode.ConfigurationTarget.Global);
    } else {
      return;
    }
    invalidateDatabricksCliCache();
    await recheckAllBundles();
  }

  const checkAgainFlags = { config: true, saved: false, bundleFileSaved: false };
  extensionContext.subscriptions.push(
    bundlesTree,
    settingsTree,
    bundlesView,
    settingsView,
    vscode.window.onDidChangeActiveTextEditor(() => revealOpenFileBundle()),
    bundlesView.onDidChangeVisibility((event) => {
      if (event.visible) revealOpenFileBundle();
    }),
    bundlesView.onDidChangeVisibility((event) => noteSidebarShown(event.visible)),
    settingsView.onDidChangeVisibility((event) => noteSidebarShown(event.visible)),
    vscode.commands.registerCommand("databricksBundleInspector.sidebar.inspect", (element?: BundlesElement) => {
      if (!element) return undefined;
      logSidebarAction("open_graph");
      return openGraph(element.root);
    }),
    vscode.commands.registerCommand("databricksBundleInspector.sidebar.checkAgain", (element?: BundlesElement) => {
      if (!element) return undefined;
      logSidebarAction("check_again");
      return refreshBundle(element.root, checkAgainFlags);
    }),
    vscode.commands.registerCommand("databricksBundleInspector.checkAllBundles", () => checkAllBundles()),
    // The same, from the button at the top of the sidebar.
    vscode.commands.registerCommand("databricksBundleInspector.sidebar.checkAll", () => {
      logSidebarAction("check_all");
      return checkAllBundles();
    }),
    vscode.commands.registerCommand(OPEN_TARGET_COMMAND, (root: string, target: string) => {
      logSidebarAction("open_target");
      return openTarget(root, target);
    }),
    vscode.commands.registerCommand(OPEN_PROBLEMS_COMMAND, (element?: BundlesElement) => {
      if (!element) return undefined;
      logSidebarAction("open_problems");
      return openBundleProblems(element.root);
    }),
    vscode.commands.registerCommand("databricksBundleInspector.openGuide", () =>
      vscode.env.openExternal(vscode.Uri.parse(usageDocsUrl(extensionVersion))),
    ),
    vscode.commands.registerCommand("databricksBundleInspector.reportIssue", () =>
      vscode.env.openExternal(vscode.Uri.parse(NEW_ISSUE_URL)),
    ),
    vscode.commands.registerCommand("databricksBundleInspector.locateCli", () =>
      // locateCli re-checks every bundle that waited for the CLI, except the graph's,
      // which is the one it hands back here.
      locateCli(async () => {
        if (activeBundleDir && checkStates.get(activeBundleDir) === "cli_missing") {
          scheduleRefresh(activeBundleDir, "config");
        }
      }),
    ),
    vscode.commands.registerCommand("databricksBundleInspector.openCliInstallGuide", () =>
      vscode.env.openExternal(vscode.Uri.parse(databricksCliInstallUrl(process.platform))),
    ),
    vscode.commands.registerCommand(CHOOSE_CLI_COMMAND, (origin?: unknown) => {
      if (origin === SIDEBAR_ORIGIN) logSidebarAction("choose_cli");
      return chooseCli();
    }),
    vscode.commands.registerCommand("databricksBundleInspector.sidebar.openBundleFile", (element?: BundlesElement) => {
      if (!element) return undefined;
      logSidebarAction("open_bundle_file");
      return vscode.window.showTextDocument(vscode.Uri.file(bundleFilePath(element.root)));
    }),
  );
  refreshSidebar();
  void updateSidebarCli();

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
      if (typeof kind === "string" && QUICK_FIX_KINDS.includes(kind)) {
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
            bundleProblemCount(root),
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

  // A day the extension checked bundles is reported on the next day it starts, even before a check.
  if (telemetry?.isEnabled()) {
    const event = progress.rollOverDay();
    if (event) telemetry.logUsage("bundle_progress", event);
  } else {
    progress.clear();
  }
  void checkBundlesIn(vscode.workspace.workspaceFolders ?? []).then((check) =>
    telemetry?.logUsage("extension_activated", {
      bundle_count: countBucket(check.bundleCount),
      bundle_at_root: check.bundleAtRoot,
      ...(check.cliFound === undefined ? {} : { cli_found: check.cliFound }),
      ...(check.cliVersion ? { cli_version: check.cliVersion } : {}),
      ...(check.issueCount === undefined ? {} : { issue_count: countBucket(check.issueCount) }),
    }),
  );
}

export function deactivate(): Promise<void> | undefined {
  const pending = telemetry?.shutdown();
  telemetry = undefined;
  return pending;
}
