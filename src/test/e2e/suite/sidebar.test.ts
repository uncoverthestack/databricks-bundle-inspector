import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
    checkAgainst: {
      description: string;
      options: Array<{ target: string | undefined; label: string; description: string; inUse: boolean }>;
    };
  }>;
  settings: { cli: { description: string; warning: boolean }; profile: { description: string } };
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
  shown.bundles[0]!.checkAgainst.options.length > 1;

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

    it("lists the bundle with the status bar's result, its targets, and the structural preview in use", async () => {
      const shown = await sidebarWhen(checked);
      assert.equal(shown.bundles.length, 1, JSON.stringify(shown));
      const bundle = shown.bundles[0]!;
      assert.equal(bundle.label, path.basename(fixtureRoot()));

      const statusBar = await vscode.commands.executeCommand<{ view?: { text: string } }>(
        "databricksBundleInspector.test.statusBar",
      );
      assert.ok(
        statusBar?.view?.text.includes(bundle.description),
        `the status bar "${statusBar?.view?.text}" should say "${bundle.description}"`,
      );

      assert.equal(bundle.checkAgainst.description, "structural preview");
      assert.deepEqual(
        bundle.checkAgainst.options.map((option) => option.label).sort(),
        ["Structural preview", "ambiguous", "dev"],
      );
      assert.deepEqual(
        bundle.checkAgainst.options.filter((option) => option.inUse).map((option) => option.label),
        ["Structural preview"],
      );
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
      assert.deepEqual(after.bundles[0]!.checkAgainst.options, before.bundles[0]!.checkAgainst.options);
    });

    it("a target the CLI rejects shows as not checked, and the structural preview again clears it", async function () {
      this.timeout(120_000);
      const root = (await sidebarWhen(checked)).bundles[0]!.root;
      // Opens the graph for this bundle, then picks a target with no usable login.
      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.inspect", { kind: "bundle", root });
      await vscode.commands.executeCommand("databricksBundleInspector.test.selectTarget", "ambiguous");

      const fellBack = await sidebarWhen((shown) => shown.bundles[0]!.checkAgainst.description !== "structural preview");
      const group = fellBack.bundles[0]!.checkAgainst;
      assert.equal(group.description, "structural preview · ambiguous couldn't be checked");
      assert.deepEqual(group.options.filter((option) => option.inUse).map((option) => option.label), ["Structural preview"]);

      await vscode.commands.executeCommand("databricksBundleInspector.test.selectTarget", undefined);
      const back = await sidebarWhen((shown) => shown.bundles[0]!.checkAgainst.description === "structural preview");
      assert.equal(back.bundles[0]!.checkAgainst.description, "structural preview");
    });
  });
}
