import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

/**
 * A multi-root workspace (a copy of fixtures/workspace-changes, see runTest.ts) whose
 * bundles share a file, and whose folders and bundles come and go while it is open.
 * Every result is the real Databricks CLI's.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ShownBundle {
  root: string;
  status: string;
  problems: { description: string };
  targets: { targets: Array<{ target: string }> };
}

async function bundles(): Promise<ShownBundle[]> {
  return (await vscode.commands.executeCommand<{ bundles: ShownBundle[] }>("databricksBundleInspector.test.sidebar"))!.bundles;
}

async function waitFor(ready: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (await ready()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** No check running or waiting to start. */
async function idle(): Promise<void> {
  await waitFor(
    async () =>
      !(await vscode.commands.executeCommand<{ checksPending: boolean }>("databricksBundleInspector.test.statusBar"))!.checksPending,
    "the checks to finish",
  );
}

/** The fixture's folders sit side by side; the workspace file is next to them. */
function base(): string {
  const file = vscode.workspace.workspaceFile;
  assert.ok(file, "the workspace-changes fixture opens as a .code-workspace");
  return path.dirname(file.fsPath);
}
const folder = (name: string) => path.join(base(), name);
const bundleFile = (name: string) => path.join(folder(name), "databricks.yml");
const shown = async (name: string) => (await bundles()).find((bundle) => bundle.root === folder(name));
const sharedFindings = () =>
  vscode.languages
    .getDiagnostics(vscode.Uri.file(path.join(base(), "shared", "job.yml")))
    .filter((diagnostic) => diagnostic.source?.startsWith("Databricks Bundle"));

async function removeFolder(name: string): Promise<void> {
  const index = vscode.workspace.workspaceFolders!.findIndex((f) => f.uri.fsPath === folder(name));
  assert.ok(index >= 0 && vscode.workspace.updateWorkspaceFolders(index, 1), `remove ${name}`);
  await waitFor(async () => !(await shown(name)), `${name} to leave the sidebar`);
}

async function addFolder(name: string): Promise<void> {
  vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders!.length, 0, { uri: vscode.Uri.file(folder(name)) });
  await waitFor(async () => (await shown(name))?.problems.description.includes("structural preview") ?? false, `${name} to be checked`);
  await idle();
}

/** Replaces a document's text in the editor, without saving. */
async function replaceText(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
}

function realCli(): string | undefined {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", ["databricks"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export function workspaceChangesSuite(): void {
  describe("Bundle Inspector: workspace changes", function () {
    this.timeout(120_000);

    before(async function () {
      if (!realCli()) this.skip();
      await vscode.extensions.getExtension("UncoverTheStack.databricks-bundle-inspector")!.activate();
      await waitFor(async () => (await bundles()).length === 4, "the four bundles");
      await waitFor(
        async () => (await bundles()).every((bundle) => bundle.problems.description.includes("structural preview")),
        "every bundle's first check",
      );
      await idle();
    });

    it("a finding in a file three bundles load shows once, naming each, and counts for each", async () => {
      const findings = sharedFindings();
      assert.equal(findings.length, 1, JSON.stringify(findings.map((d) => d.source)));
      assert.equal(findings[0]!.source, "Databricks Bundle Inspector (alpha, beta, gamma)");
      for (const name of ["alpha", "beta", "gamma"]) {
        assert.equal((await shown(name))?.problems.description, "1 · structural preview", name);
      }
    });

    it("removing one of those bundles keeps the others' finding in the shared file", async () => {
      await removeFolder("beta");
      try {
        await idle();
        const findings = sharedFindings();
        assert.equal(findings.length, 1);
        assert.equal(findings[0]!.source, "Databricks Bundle Inspector (alpha, gamma)");
        assert.equal((await shown("alpha"))?.problems.description, "1 · structural preview");
      } finally {
        await addFolder("beta");
      }
    });

    it("lists a target a `<<` merge brings in, and opens it where the anchor writes it", async () => {
      const alpha = await shown("alpha");
      assert.deepEqual(alpha?.targets.targets.map((t) => t.target), ["dev", "staging"]);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openTarget", folder("alpha"), "staging");
      const editor = vscode.window.activeTextEditor;
      assert.equal(editor?.document.fileName, bundleFile("alpha"));
      assert.equal(editor?.document.lineAt(editor.selection.active.line).text, "  staging:");
    });

    it("opens a target at its line in the editor's text, unsaved edits included", async () => {
      const document = await vscode.workspace.openTextDocument(bundleFile("alpha"));
      const original = document.getText();
      try {
        await vscode.window.showTextDocument(document);
        await replaceText(document, "\n\n\n\n\n" + original);
        await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openTarget", folder("alpha"), "dev");
        const editor = vscode.window.activeTextEditor;
        assert.equal(editor?.document.lineAt(editor.selection.active.line).text, "  dev:");
      } finally {
        await replaceText(document, original);
        await document.save();
        await idle();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("names each task in the problem list, also when tasks share an anchor and so a line", async () => {
      const window = vscode.window as { showQuickPick: typeof vscode.window.showQuickPick };
      const showQuickPick = window.showQuickPick;
      let offered: vscode.QuickPickItem[] = [];
      window.showQuickPick = (async (items: readonly vscode.QuickPickItem[]) => {
        offered = [...items];
        return undefined;
      }) as unknown as typeof vscode.window.showQuickPick;
      try {
        await vscode.commands.executeCommand("databricksBundleInspector.sidebar.openProblems", { kind: "problems", root: folder("anchored") });
      } finally {
        window.showQuickPick = showQuickPick;
      }
      const tasks = offered
        .filter((item) => item.kind !== vscode.QuickPickItemKind.Separator && item.label.includes("missing_notebook"))
        .map((item) => /^\$\(\w+\) (\w+) · /.exec(item.label)?.[1]);
      assert.deepEqual(tasks.sort(), ["load_a", "load_b", "load_c"], JSON.stringify(offered.map((item) => item.label)));
    });

    it("after a bundle's graph fails to open, its Graph row doesn't show the graph before it", async () => {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("databricksBundleInspector.sidebar.inspect", { kind: "graph", root: folder("alpha") });
      const graphName = async () =>
        (await vscode.commands.executeCommand<{ parsedBundle?: { bundle?: { name?: string } } }>("databricksBundleInspector.test.graphData"))
          ?.parsedBundle?.bundle?.name;
      assert.equal(await graphName(), "alpha");
      const original = await readFile(bundleFile("beta"), "utf8");
      const window = vscode.window as Record<string, unknown>;
      const popups = { showErrorMessage: window.showErrorMessage, showWarningMessage: window.showWarningMessage };
      let shownMessages = 0;
      window.showErrorMessage = window.showWarningMessage = async () => {
        shownMessages++;
        return undefined;
      };
      try {
        await writeFile(bundleFile("beta"), "bundle: [\n");
        await idle();
        await vscode.commands.executeCommand("databricksBundleInspector.sidebar.inspect", { kind: "graph", root: folder("beta") });
        const afterFirst = shownMessages;
        assert.ok(afterFirst > 0, "the failed check says so");
        // Clicked again: it checks beta again and says why it fails, not alpha's graph as beta's.
        await vscode.commands.executeCommand("databricksBundleInspector.sidebar.inspect", { kind: "graph", root: folder("beta") });
        assert.ok(shownMessages > afterFirst, "the second click checks beta again");
      } finally {
        Object.assign(window, popups);
        await writeFile(bundleFile("beta"), original);
        await idle();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });

    it("finds a bundle made on disk while the folder is open", async () => {
      const made = path.join(folder("alpha"), "made-later");
      await mkdir(made);
      try {
        await writeFile(path.join(made, "databricks.yml"), "bundle:\n  name: made_later\n\ntargets:\n  dev:\n    default: true\n");
        await waitFor(async () => (await bundles()).some((bundle) => bundle.root === made), "the new bundle in the sidebar");
        await waitFor(async () => (await bundles()).find((bundle) => bundle.root === made)?.problems.description === "none found · structural preview", "its check");
      } finally {
        await rm(made, { recursive: true, force: true });
        // Its watcher's check finds the file gone and forgets the bundle.
        await vscode.commands.executeCommand("databricksBundleInspector.checkAllBundles");
        await waitFor(async () => !(await bundles()).some((bundle) => bundle.root === made), "the deleted bundle to leave");
        await idle();
      }
    });

    it("a check still running when its folder is removed doesn't bring the bundle back", async function () {
      // The CLI is held by a #!/bin/sh wrapper, which Windows can't run.
      if (process.platform === "win32") this.skip();
      const work = path.join(base(), "..");
      const wrapper = path.join(work, "held-cli");
      const hold = path.join(work, "hold");
      const started = path.join(work, "started");
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      await writeFile(hold, "");
      await writeFile(
        wrapper,
        `#!/bin/sh\nif [ "$1" = bundle ] && [ "$2" = validate ]; then\n  touch ${quote(started)}\n  while [ -f ${quote(hold)} ]; do sleep 0.05; done\nfi\nexec ${quote(realCli()!)} "$@"\n`,
      );
      await chmod(wrapper, 0o755);
      const config = vscode.workspace.getConfiguration("databricksBundleInspector");
      let check: Thenable<unknown> | undefined;
      let removed = false;
      try {
        await config.update("cliPath", wrapper, vscode.ConfigurationTarget.Global);
        await idle();
        await rm(started, { force: true });
        check = vscode.commands.executeCommand("databricksBundleInspector.sidebar.checkAgain", { kind: "bundle", root: folder("gamma") });
        await waitFor(() => existsSync(started), "the held check to start");
        await removeFolder("gamma");
        removed = true;
        await rm(hold);
        await check;
        await idle();
        assert.equal(await shown("gamma"), undefined, "gamma stays gone");
        assert.equal(sharedFindings()[0]?.source, "Databricks Bundle Inspector (alpha, beta)");
      } finally {
        await rm(hold, { force: true });
        await check;
        await config.update("cliPath", undefined, vscode.ConfigurationTarget.Global);
        if (removed) await addFolder("gamma");
      }
    });
  });
}
