import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { codeValue } from "../../../bundle/issueDocs.js";
import { folderIgnoresCase } from "../../../bundle/pathCase.js";

type GraphData = {
  initialJob?: { key: string; nonce: number } | null;
  parsedBundle?: { bundle?: { name?: string } };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

export function resourceFilesSuite() {
  describe("resource file entry points across bundles and edits", function () {
    this.timeout(120_000);
    let root: string;
    let activeFileInBundle: boolean | undefined;
    let originalExecute: typeof vscode.commands.executeCommand;
    let realExecute: typeof vscode.commands.executeCommand;
    const uri = (relative: string) => vscode.Uri.file(path.join(root, relative));
    const data = () => realExecute<GraphData>("databricksBundleInspector.test.graphData");

    async function open(relative: string, within?: string): Promise<vscode.TextEditor> {
      const document = await vscode.workspace.openTextDocument(uri(relative));
      const editor = await vscode.window.showTextDocument(document);
      const line = within ? document.getText().split(/\r?\n/).findIndex(text => text.includes(within)) : 0;
      assert.ok(line >= 0, `expected ${within} in ${relative}`);
      editor.selection = new vscode.Selection(line, 0, line, 0);
      return editor;
    }

    async function inspect(relative: string, within: string, bundle: string, job: string): Promise<void> {
      await open(relative, within);
      await waitFor(() => activeFileInBundle === true, "Inspect enabled for the resource file");
      await realExecute("databricksBundleInspector.inspectBundle");
      const result = await data();
      assert.equal(result?.parsedBundle?.bundle?.name, bundle);
      assert.equal(result?.initialJob?.key, job);
    }

    async function inspectAlpha(): Promise<void> {
      await open("alpha/databricks.yml");
      await realExecute("databricksBundleInspector.inspectBundle");
    }

    before(async function () {
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder);
      root = folder.uri.fsPath;
      originalExecute = vscode.commands.executeCommand;
      realExecute = originalExecute.bind(vscode.commands);
      (vscode.commands as any).executeCommand = async (command: string, ...args: unknown[]) => {
        if (command === "setContext" && args[0] === "databricksBundleInspector.activeFileInBundle") {
          activeFileInBundle = Boolean(args[1]);
        }
        return realExecute(command, ...args);
      };
      await waitFor(async () => {
        const shown = await realExecute<{ view?: { text: string } }>("databricksBundleInspector.test.statusBar");
        return Boolean(shown?.view?.text.includes("3 bundles:"));
      }, "all three bundles checked");
    });

    after(async function () {
      (vscode.commands as any).executeCommand = originalExecute;
      await realExecute("workbench.action.closeAllEditors");
    });

    it("switches between bundles fifteen times and chooses the job under the cursor", async function () {
      for (let round = 0; round < 5; round++) {
        await inspect("alpha/resources/jobs.yml", "name: alpha_second", "resource_alpha", "alpha_second");
        await inspect("beta/resources/jobs.yml", "name: beta_second", "resource_beta", "beta_second");
        await inspect("alpha/teams/sales/resources/shared.yml", "name: sales_second", "resource_sales", "sales_second");
      }
    });

    it("uses the file's first job when the cursor is in a later variables section", async function () {
      await inspect("alpha/resources/jobs.yml", "default: alpha", "resource_alpha", "alpha_first");
    });

    it("disables Inspect for a YAML file no bundle loaded", async function () {
      await open("unloaded.yml");
      await waitFor(() => activeFileInBundle === false, "Inspect disabled for an unrelated YAML file");
    });

    it("uses the CLI's loaded files even when files.exclude hides resources", async function () {
      const config = vscode.workspace.getConfiguration("files");
      const previous = config.inspect("exclude")?.workspaceValue;
      try {
        await config.update("exclude", { "**/resources/**": true }, vscode.ConfigurationTarget.Workspace);
        await inspectAlpha();
        await inspect("alpha/resources/jobs.yml", "name: alpha_second", "resource_alpha", "alpha_second");
      } finally {
        await config.update("exclude", previous, vscode.ConfigurationTarget.Workspace);
      }
    });

    it("removes and restores the entry point when include changes", async function () {
      const document = await vscode.workspace.openTextDocument(uri("alpha/databricks.yml"));
      const original = document.getText();
      async function replace(text: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
        await inspectAlpha();
      }
      try {
        await replace(original.replace("  - resources/*.yml\n", ""));
        assert.ok(vscode.languages.getDiagnostics(uri("alpha/resources/jobs.yml"))
          .some(item => codeValue(item.code) === "resource_not_included"));
        await open("alpha/resources/jobs.yml");
        await waitFor(() => activeFileInBundle === false, "removed include no longer enables Inspect");
      } finally {
        await replace(original);
      }
      await inspect("alpha/resources/jobs.yml", "name: alpha_second", "resource_alpha", "alpha_second");
    });

    it("opens a renamed resource with spaces and Unicode in its path", async function () {
      const oldUri = uri("alpha/resources/jobs.yml");
      const newUri = uri("alpha/resources/renamed café job.yml");
      await realExecute("workbench.action.closeAllEditors");
      try {
        await vscode.workspace.fs.rename(oldUri, newUri);
        await inspectAlpha();
        await inspect("alpha/resources/renamed café job.yml", "name: alpha_second", "resource_alpha", "alpha_second");
      } finally {
        await vscode.workspace.fs.rename(newUri, oldUri);
        await inspectAlpha();
      }
    });

    it("matches another path spelling on a file system that ignores case", async function () {
      if (!(await folderIgnoresCase(root))) this.skip();
      await inspect("alpha/RESOURCES/JOBS.YML", "name: alpha_second", "resource_alpha", "alpha_second");
    });

    it("falls back to the parent owner after the nested bundle is deleted", async function () {
      const nested = uri("alpha/teams/sales/databricks.yaml");
      const original = await vscode.workspace.fs.readFile(nested);
      try {
        await vscode.workspace.fs.delete(nested);
        await waitFor(async () => {
          const shown = await realExecute<{ view?: { text: string } }>("databricksBundleInspector.test.statusBar");
          return Boolean(shown?.view?.text.includes("2 bundles:"));
        }, "deleted bundle forgotten");
        await inspect("alpha/teams/sales/resources/shared.yml", "name: sales_second", "resource_alpha", "sales_second");
      } finally {
        await vscode.workspace.fs.writeFile(nested, original);
      }
    });
  });
}
