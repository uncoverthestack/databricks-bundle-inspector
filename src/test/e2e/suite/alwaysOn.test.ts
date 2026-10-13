import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";

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
          kind: String(d.code),
        })),
    )
    .sort((a, b) => a.file.localeCompare(b.file));
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
      assert.deepEqual(
        vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label)),
        [],
        "starting up must not open the inspector panel or any file",
      );
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
      } finally {
        await vscode.workspace.fs.writeFile(bundleUri, original);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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
