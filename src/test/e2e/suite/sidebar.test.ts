import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the sidebar shows (a test-only command; the API can't read a tree view's rows). */
interface ShownSidebar {
  message: string | undefined;
  bundles: Array<{
    root: string;
    label: string;
    description: string;
    status: string;
    graph: { description: string; tooltip: string };
    problems: { description: string; tooltip: string; status: string; canOpen: boolean };
    targets: { description: string; targets: Array<{ target: string; description: string }> };
  }>;
  settings: { cli: { description: string; tooltip: string; warning: boolean }; profile: { description: string } };
}

async function sidebar(): Promise<ShownSidebar> {
  return (await vscode.commands.executeCommand<ShownSidebar>("databricksBundleInspector.test.sidebar"))!;
}

/** Waits until `ready` holds for what the sidebar shows, and returns it then (or at the timeout). */
async function sidebarWhen(ready: (shown: ShownSidebar) => boolean, timeoutMs = 60_000): Promise<ShownSidebar> {
  let shown = await sidebar();
  for (let waited = 0; !ready(shown) && waited < timeoutMs; waited += 250) {
    await sleep(250);
    shown = await sidebar();
  }
  return shown;
}

const checked = (shown: ShownSidebar) =>
  shown.bundles.length === 1 &&
  shown.bundles[0]!.status !== "pending" &&
  shown.bundles[0]!.status !== "checking" &&
  shown.bundles[0]!.targets.targets.length > 0;

function databricksCliAvailable(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function fixtureRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the targets fixture should be open");
  return folder.uri.fsPath;
}

/**
 * Opens the targets fixture with a real Databricks CLI. The sidebar has to show the bundle
 * the extension checked by itself, with the result the status bar shows, and its targets.
 * Needs no workspace login.
 */
export function sidebarSuite() {
  describe("sidebar (needs a real Databricks CLI)", function () {
    before(function () {
      if (!databricksCliAvailable()) this.skip();
    });

    it("lists the bundle with the status bar's result, its graph, problems and targets", async () => {
      const shown = await sidebarWhen(checked);
      assert.equal(shown.bundles.length, 1, JSON.stringify(shown));
      const bundle = shown.bundles[0]!;
      assert.equal(bundle.label, path.basename(fixtureRoot()));

      const statusBar = await vscode.commands.executeCommand<{ view?: { text: string } }>(
        "databricksBundleInspector.test.statusBar",
      );
      const result = bundle.description.split(" · ")[0]!;
      assert.ok(
        statusBar?.view?.text.includes(result),
        `the status bar "${statusBar?.view?.text}" should say "${result}"`,
      );

      assert.equal(bundle.description, result);
      assert.match(bundle.graph.description, /^\d+ jobs? · \d+ tasks?/);
      assert.match(bundle.problems.description, /structural preview$/);
      assert.deepEqual(bundle.targets.targets, [
        { target: "ambiguous", description: "" },
        { target: "dev", description: "" },
      ]);
      assert.equal(shown.message, undefined);
      assert.match(shown.settings.cli.description, /^v\d+\.\d+\.\d+/);
    });

    it("a target row opens the bundle file at that target", async () => {
      const root = (await sidebarWhen(checked)).bundles[0]!.root;
      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openTarget", root, "ambiguous");

      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, "a file should be open");
      assert.equal(path.basename(editor.document.fileName), "databricks.yml");
      const lines = (await readFile(path.join(root, "databricks.yml"), "utf8")).split(/\r?\n/);
      assert.equal(editor.selection.active.line, lines.indexOf("  ambiguous:"));
    });

    it("focusing the view selects the open file's bundle without an error", async () => {
      await vscode.commands.executeCommand("databricksBundleInspector.bundles.focus");
      const document = await vscode.workspace.openTextDocument(path.join(fixtureRoot(), "resources", "job.yml"));
      await vscode.window.showTextDocument(document);
      await sleep(500);
      assert.equal((await sidebar()).bundles.length, 1);
    });

    it("Check Again checks the bundle again and keeps its rows", async () => {
      // Check Again during a running check is queued behind it, so start from a quiet state.
      for (let waited = 0; waited < 30_000; waited += 250) {
        const statusBar = await vscode.commands.executeCommand<{ checksPending: boolean }>(
          "databricksBundleInspector.test.statusBar",
        );
        if (!statusBar?.checksPending) break;
        await sleep(250);
      }
      const before = await sidebarWhen(checked);
      const root = before.bundles[0]!.root;
      const result = await vscode.commands.executeCommand<{ ok: boolean } | undefined>(
        "databricksBundleInspector.sidebar.checkAgain",
        { kind: "bundle", root },
      );
      // Undefined would mean the check was put off behind one already running.
      assert.equal(result?.ok, true, "Check Again should run a check and return its result");
      const after = await sidebarWhen(checked);
      assert.equal(after.bundles[0]!.description, before.bundles[0]!.description);
      assert.deepEqual(after.bundles[0]!.targets, before.bundles[0]!.targets);
    });

    it("a target the CLI rejects shows as not checked, and the structural preview again clears it", async function () {
      this.timeout(120_000);
      const root = (await sidebarWhen(checked)).bundles[0]!.root;
      // Opens the graph for this bundle, then picks a target with no usable login.
      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.inspect", { kind: "bundle", root });
      await vscode.commands.executeCommand("databricksBundleInspector.test.selectTarget", "ambiguous");

      const fellBack = await sidebarWhen((shown) => shown.bundles[0]!.graph.description.includes("ambiguous"));
      assert.equal(fellBack.bundles[0]!.graph.description, "ambiguous couldn't be checked");

      // Clicking Graph shows the graph as it is: it doesn't go back to the structural preview.
      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.inspect", { kind: "graph", root });
      await sleep(2_000);
      assert.equal((await sidebar()).bundles[0]!.graph.description, "ambiguous couldn't be checked");
      assert.ok(fellBack.bundles[0]!.targets.targets.every((item) => item.description === ""));

      await vscode.commands.executeCommand("databricksBundleInspector.test.selectTarget", undefined);
      const back = await sidebarWhen((shown) => !shown.bundles[0]!.graph.description.includes("ambiguous"));
      assert.match(back.bundles[0]!.graph.description, /^\d+ jobs? · \d+ tasks?/);
    });

    it("the Problems row opens the first problem where it is, as F8 does", async () => {
      // The fixture's notebook reads a widget the job doesn't pass: one warning, in src/load.py.
      const shown = await sidebarWhen((current) => checked(current) && current.bundles[0]!.problems.canOpen);
      const bundle = shown.bundles[0]!;
      assert.equal(bundle.problems.status, "problems", JSON.stringify(bundle.problems));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");

      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openProblems", { kind: "problems", root: bundle.root });
      const editor = vscode.window.activeTextEditor;
      const notebook = path.join(bundle.root, "src", "load.py");
      assert.equal(editor?.document.fileName, notebook);
      const lines = (await readFile(notebook, "utf8")).split(/\r?\n/);
      assert.equal(editor?.selection.active.line, lines.findIndex((line) => line.includes("dbutils.widgets.get")));
    });

    it("with problems in several files, the Problems row lists them all by file to pick from", async function () {
      this.timeout(120_000);
      const root = (await sidebarWhen(checked)).bundles[0]!.root;
      const jobFile = path.join(root, "resources", "job.yml");
      const original = await readFile(jobFile, "utf8");
      const document = await vscode.workspace.openTextDocument(jobFile);
      const replaceAll = async (text: string) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
      };
      const window = vscode.window as { showQuickPick: typeof vscode.window.showQuickPick };
      const showQuickPick = window.showQuickPick;
      try {
        // A second task whose notebook doesn't exist: a problem in job.yml, next to the one in load.py.
        const extra = "\n        - task_key: extra\n          notebook_task:\n            notebook_path: ../src/missing_notebook.py\n";
        await replaceAll(original.trimEnd() + extra);
        const two = await sidebarWhen((shown) => shown.bundles[0]?.problems.description === "2 · structural preview");
        assert.equal(two.bundles[0]!.problems.description, "2 · structural preview", JSON.stringify(two.bundles[0]!.problems));

        let offered: Array<vscode.QuickPickItem & { problem?: { message: string } }> = [];
        window.showQuickPick = (async (items: readonly vscode.QuickPickItem[]) => {
          offered = [...items];
          return offered.find((item) => item.label.includes("missing_notebook"));
        }) as unknown as typeof vscode.window.showQuickPick;
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openProblems", { kind: "problems", root });

        const separators = offered.filter((item) => item.kind === vscode.QuickPickItemKind.Separator).map((item) => item.label);
        // Short headings, the file name only, so the messages keep their room.
        assert.deepEqual(separators, ["job.yml", "load.py"], JSON.stringify(offered));
        const problems = offered.filter((item) => item.problem).map((item) => item.label);
        assert.equal(problems.length, 2);
        // Each one starts with its task.
        assert.match(problems[0]!, /^\$\(error\) extra · /, problems[0]);
        assert.match(problems[1]!, /^\$\(warning\) load · /, problems[1]);
        assert.equal(two.bundles[0]!.problems.status, "errors");
        assert.equal(two.bundles[0]!.status, "errors");
        const editor = vscode.window.activeTextEditor;
        assert.equal(editor?.document.fileName, jobFile);
        const lines = (original.trimEnd() + extra).split(/\r?\n/);
        assert.equal(editor?.selection.active.line, lines.findIndex((line) => line.includes("missing_notebook")));
      } finally {
        window.showQuickPick = showQuickPick;
        await replaceAll(original);
        await sidebarWhen((shown) => shown.bundles[0]?.problems.description === "1 · structural preview");
      }
    });

    it("Open Bundle File opens the bundle's databricks.yml", async () => {
      const root = (await sidebarWhen(checked)).bundles[0]!.root;
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openBundleFile", { kind: "bundle", root });
      assert.equal(vscode.window.activeTextEditor?.document.fileName, path.join(root, "databricks.yml"));
    });

    it("clicking the CLI row lists each CLI found with where it is from, the one in use ticked", async () => {
      const shown = await sidebarWhen(checked);
      const window = vscode.window as { showQuickPick: typeof vscode.window.showQuickPick };
      const original = window.showQuickPick;
      let offered: Array<vscode.QuickPickItem & { path?: string }> = [];
      window.showQuickPick = (async (items: readonly vscode.QuickPickItem[]) => {
        offered = [...items];
        return undefined;
      }) as unknown as typeof vscode.window.showQuickPick;
      try {
        await vscode.commands.executeCommand("databricksBundleInspector.chooseCli");
      } finally {
        window.showQuickPick = original;
      }
      const inUse = offered.filter((item) => item.label.startsWith("$(check) "));
      assert.equal(inUse.length, 1, JSON.stringify(offered));
      assert.equal(inUse[0]!.label, `$(check) ${shown.settings.cli.description.split(" · ")[0]}`);
      assert.match(inUse[0]!.description ?? "", /^(on PATH|cliPath setting|Windows Path|Databricks extension) · in use/);
      assert.ok(inUse[0]!.detail && path.isAbsolute(inUse[0]!.detail), `the file in use should be shown: ${inUse[0]!.detail}`);
      assert.ok(offered.some((item) => item.label.includes("Browse for the Databricks CLI")));
      // Nothing was picked, so the setting is unchanged.
      assert.equal(vscode.workspace.getConfiguration("databricksBundleInspector").get("cliPath") || undefined, undefined);
    });

    it("counts each sidebar action once per window, and not the same commands from the Command Palette", async function () {
      this.timeout(120_000);
      const root = (await sidebarWhen(checked)).bundles[0]!.root;
      type Logged = { event: string; properties: Record<string, unknown> };
      const logged = async () =>
        (await vscode.commands.executeCommand<Logged[]>("databricksBundleInspector.test.telemetryEvents"))!;
      const actions = async () =>
        (await logged()).filter((event) => event.event === "sidebar_action").map((event) => event.properties.action);
      const window = vscode.window as { showQuickPick: typeof vscode.window.showQuickPick };
      const original = window.showQuickPick;
      window.showQuickPick = (async () => undefined) as unknown as typeof vscode.window.showQuickPick;
      try {
        // From the Command Palette: not sidebar use.
        await vscode.commands.executeCommand("databricksBundleInspector.chooseCli");
        await vscode.commands.executeCommand("databricksBundleInspector.checkAllBundles");
        assert.ok(!(await actions()).includes("choose_cli"), JSON.stringify(await actions()));
        assert.ok(!(await actions()).includes("check_all"), JSON.stringify(await actions()));

        // From the sidebar, twice each: counted once.
        for (let round = 0; round < 2; round++) {
          await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openBundleFile", { kind: "bundle", root });
          await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openTarget", root, "dev");
          await vscode.commands.executeCommand("databricksBundleInspector.sidebar.checkAgain", { kind: "bundle", root });
          await vscode.commands.executeCommand("databricksBundleInspector.sidebar.checkAll");
          await vscode.commands.executeCommand("databricksBundleInspector.chooseCli", "sidebar");
        }
        const before = (await logged()).length;
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("databricksBundleInspector.sidebar.inspect", { kind: "graph", root });
        const inspect = (await logged()).slice(before).find((event) => event.event === "inspect_bundle");
        assert.equal(inspect?.properties.trigger, "sidebar");
        assert.match(String(inspect?.properties.cli_version), /^\d+\.\d+$/);
      } finally {
        window.showQuickPick = original;
      }
      const counted = await actions();
      for (const action of ["open_bundle_file", "open_target", "check_again", "check_all", "choose_cli", "open_graph"]) {
        assert.equal(counted.filter((each) => each === action).length, 1, `${action}: ${JSON.stringify(counted)}`);
      }
      assert.equal(new Set(counted).size, counted.length, JSON.stringify(counted));
      // The extension started with this window, so the start event is there too.
      const all = await logged();
      const started = all.find((event) => event.event === "extension_activated");
      assert.match(String(started?.properties.cli_version), /^\d+\.\d+$/, JSON.stringify(started));
      // An earlier test focused the view: counted once. Whether that was within 5 seconds of
      // the start depends on how fast this machine runs the tests, so only its type is checked.
      const opened = all.filter((event) => event.event === "sidebar_opened");
      assert.equal(opened.length, 1, JSON.stringify(opened));
      assert.equal(typeof opened[0]!.properties.at_start, "boolean");
    });

    it("switching from a slow CLI to a quicker one shows the quicker one, even when the slow lookup ends last", async function () {
      // A shell script stands in for the slow CLI, so not on Windows.
      if (process.platform === "win32") this.skip();
      this.timeout(60_000);
      const realCli = execFileSync("which", ["databricks"], { encoding: "utf8" }).trim();
      const dir = await mkdtemp(path.join(tmpdir(), "bundle-inspector-slow-cli-"));
      const slowCli = path.join(dir, "databricks");
      await writeFile(slowCli, '#!/bin/sh\nsleep 3\necho "Databricks CLI v9.9.9"\n');
      await chmod(slowCli, 0o755);
      const settings = vscode.workspace.getConfiguration("databricksBundleInspector");
      try {
        await settings.update("cliPath", slowCli, vscode.ConfigurationTarget.Global);
        await settings.update("cliPath", realCli, vscode.ConfigurationTarget.Global);
        // Long enough for the slow lookup to end.
        await sleep(5_000);
        const shown = await sidebarWhen((current) => current.settings.cli.tooltip.includes(realCli), 10_000);
        assert.ok(shown.settings.cli.tooltip.includes(realCli), JSON.stringify(shown.settings.cli));
        assert.doesNotMatch(shown.settings.cli.description, /v9\.9\.9/);
      } finally {
        await settings.update("cliPath", undefined, vscode.ConfigurationTarget.Global);
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
