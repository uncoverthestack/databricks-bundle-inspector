import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";
import { codeValue } from "../../../bundle/issueDocs.js";

/** How long to leave the result on screen before the window closes. 0 in normal runs. */
const PAUSE_MS = Number(process.env.E2E_PAUSE_MS ?? 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function databricksCliAvailable(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The inspector's own entries in the Problems panel, as `file:line kind`. */
function inspectorProblems(root: string): { file: string; line: number; kind: string }[] {
  return vscode.languages
    .getDiagnostics()
    .flatMap(([uri, diagnostics]) =>
      diagnostics
        .filter((d) => d.source?.startsWith("Databricks Bundle Inspector"))
        .map((d) => ({
          file: path.relative(root, uri.fsPath).split(path.sep).join("/"),
          line: d.range.start.line + 1,
          kind: codeValue(d.code) ?? "",
        })),
    )
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Errors and warnings in the Problems panel from the inspector, as its own count would have them. */
function inspectorProblemCount(): number {
  return vscode.languages
    .getDiagnostics()
    .flatMap(([, diagnostics]) => diagnostics)
    .filter(
      (d) =>
        d.source?.startsWith("Databricks Bundle Inspector") &&
        (d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning),
    ).length;
}

interface ShownStatusBar {
  view?: { text: string; tooltip: string; tooltipList?: string[] };
  folderCount: { problems: number; notes: number; graphOnly: number };
}

/** What the status bar item shows now (a test-only command; the API can't read it). */
async function statusBar(): Promise<ShownStatusBar> {
  return (await vscode.commands.executeCommand<ShownStatusBar>("databricksBundleInspector.test.statusBar"))!;
}

/** Waits until the item shows `text`, and returns what it shows then (or at the timeout). */
async function statusBarText(text: string, timeoutMs = 30_000): Promise<ShownStatusBar> {
  let shown = await statusBar();
  for (let waited = 0; shown.view?.text !== text && waited < timeoutMs; waited += 250) {
    await sleep(250);
    shown = await statusBar();
  }
  return shown;
}

/**
 * Opens the always-on fixture with a real Databricks CLI and never runs Inspect.
 * The extension has to start by itself and report the bundle in the subfolder.
 * Run it with `npm run test:e2e:always-on:watch` to watch the Problems panel fill in.
 */
export function alwaysOnSuite() {
  describe("always-on checks (needs a real Databricks CLI)", function () {
    before(function () {
      if (!databricksCliAvailable()) this.skip();
    });

    it("reports a bundle in a subfolder without Inspect, opens nothing and skips venv", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the always-on fixture should be the open folder");

      for (let waited = 0; inspectorProblems(root).length === 0 && waited < 30_000; waited += 500) await sleep(500);
      // Give a check of the skipped folder time to show up, if one wrongly ran.
      await sleep(2_000);

      await vscode.commands.executeCommand("workbench.actions.view.problems");
      if (PAUSE_MS > 0) await sleep(PAUSE_MS);

      assert.deepEqual(inspectorProblems(root), [
        { file: "teams/sales/databricks.yml", line: 6, kind: "include_matches_nothing" },
      ]);

      // Two bundles (venv is skipped): the item covers both, problems first in the list,
      // and its count is the Problems panel's.
      const shown = await statusBarText("$(warning) 2 bundles: 1 problem");
      assert.equal(shown.view?.text, "$(warning) 2 bundles: 1 problem");
      assert.deepEqual(shown.view?.tooltipList, ["sales: 1 problem", "marketing: no problems"]);
      assert.equal(shown.folderCount.problems, inspectorProblemCount());
      assert.equal(shown.folderCount.graphOnly, 0);
      assert.deepEqual(
        vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label)),
        [],
        "starting up must not open the inspector panel or any file",
      );
    });

    it("shows the same folder-wide text whichever bundle's file is open", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the always-on fixture should be the open folder");
      const texts: (string | undefined)[] = [];
      try {
        for (const file of ["teams/sales/databricks.yml", "teams/marketing/databricks.yml", "teams/sales/databricks.yml"]) {
          await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, file)));
          await sleep(300);
          texts.push((await statusBar()).view?.text);
        }
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
      assert.deepEqual(texts, Array(3).fill("$(warning) 2 bundles: 1 problem"));
    });

    it("re-checks on save, still without Inspect", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the always-on fixture should be the open folder");
      const bundleUri = vscode.Uri.file(path.join(root, "teams/sales/databricks.yml"));
      const original = await vscode.workspace.fs.readFile(bundleUri);

      try {
        const fixed = Buffer.from(original).toString("utf8").replace("resource/*.yml", "resources/*.yml");
        const document = await vscode.workspace.openTextDocument(bundleUri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(bundleUri, new vscode.Range(0, 0, document.lineCount, 0), fixed);
        await vscode.workspace.applyEdit(edit);
        await document.save();

        for (let waited = 0; inspectorProblems(root).length > 0 && waited < 30_000; waited += 500) await sleep(500);
        if (PAUSE_MS > 0) await sleep(PAUSE_MS);

        assert.deepEqual(inspectorProblems(root), [], "fixing the include clears the warning");
        const shown = await statusBarText("$(pass) 2 bundles: no problems");
        assert.equal(shown.view?.text, "$(pass) 2 bundles: no problems");
        assert.equal(shown.folderCount.problems, 0);
      } finally {
        await vscode.workspace.fs.writeFile(bundleUri, original);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("drops a bundle whose file is deleted, and says what the one left covers", async function () {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(root, "the always-on fixture should be the open folder");
      const bundleUri = vscode.Uri.file(path.join(root, "teams/sales/databricks.yml"));
      const original = await vscode.workspace.fs.readFile(bundleUri);
      try {
        await vscode.workspace.fs.delete(bundleUri);
        const shown = await statusBarText("$(pass) Bundle: no problems · 1 task");
        if (PAUSE_MS > 0) await sleep(PAUSE_MS);

        assert.equal(shown.view?.text, "$(pass) Bundle: no problems · 1 task");
        assert.equal(
          shown.view?.tooltip,
          "Checked 1 job, 1 task and 1 file.",
        );
        assert.equal(shown.view?.tooltipList, undefined);
      } finally {
        // The bundle stays forgotten for the rest of the run: only opening a folder looks for new ones.
        await vscode.workspace.fs.writeFile(bundleUri, original);
      }
    });

    it("the status bar item opens the graph with no file open", async function () {
      const openTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
      assert.deepEqual(openTabs(), [], "this test starts with every editor closed");

      await vscode.commands.executeCommand("databricksBundleInspector.statusBarAction");
      for (let waited = 0; openTabs().length === 0 && waited < 15_000; waited += 250) await sleep(250);
      if (PAUSE_MS > 0) await sleep(PAUSE_MS);

      assert.ok(
        openTabs().some((tab) => tab.input instanceof vscode.TabInputWebview),
        "clicking the item should open the inspector panel for the bundle that was found",
      );
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
  });
}
