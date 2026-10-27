import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** Real CLI calls held by files, so the completion order does not depend on CPU speed. */
export function inspectionRacesSuite() {
  describe("overlapping checks preserve the user's latest action", function () {
    this.timeout(90_000);
    let root: string;
    let control: string | undefined;
    let alpha: vscode.TextDocument;
    let beta: vscode.TextDocument;
    let previousCli: string | undefined;
    const inspect = () => vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
    const graphData = () => vscode.commands.executeCommand<{
      parsedBundle?: { bundle?: { name?: string } };
      initialResource?: { group: string; key: string };
    }>(
        "databricksBundleInspector.test.graphData",
      );
    const graphName = async () => (await graphData())?.parsedBundle?.bundle?.name;
    const idle = () => waitFor(async () => {
      const status = await vscode.commands.executeCommand<{ checksPending: boolean }>("databricksBundleInspector.test.statusBar");
      return status?.checksPending === false;
    }, "all pending checks to finish");
    const file = (name: string) => path.join(control!, name);
    const release = async () => { if (control) await rm(file("hold"), { force: true }); };

    async function hold(call: number): Promise<void> {
      await idle();
      for (const name of ["started", "done", "count"]) await rm(file(name), { force: true });
      await writeFile(file("hold"), String(call));
    }

    before(async function () {
      // Windows cannot execute the shell wrapper. The production fix is shared;
      // these controlled-order tests run on Linux and macOS in CI.
      if (process.platform === "win32") this.skip();
      root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
      alpha = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "alpha/databricks.yml")));
      beta = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "beta/databricks.yaml")));
      await vscode.window.showTextDocument(alpha);
      await inspect();
      await idle();
      control = await mkdtemp(path.join(os.tmpdir(), "dbi-race-"));
      const cli = execFileSync("which", ["databricks"], { encoding: "utf8" }).trim();
      const wrapper = file("databricks");
      await writeFile(wrapper, `#!/bin/sh
if [ "$1" = bundle ] && [ "$2" = validate ] && [ "$PWD" = ${shellQuote(path.join(root, "alpha"))} ] && [ -f ${shellQuote(file("hold"))} ]; then
  count=0
  if [ -f ${shellQuote(file("count"))} ]; then count=$(cat ${shellQuote(file("count"))}); fi
  count=$((count + 1))
  printf '%s' "$count" > ${shellQuote(file("count"))}
  hold_at=$(cat ${shellQuote(file("hold"))})
  if [ "$count" = "$hold_at" ]; then
    : > ${shellQuote(file("started"))}
    attempts=0
    while [ -f ${shellQuote(file("hold"))} ] && [ "$attempts" -lt 400 ]; do sleep 0.05; attempts=$((attempts + 1)); done
    ${shellQuote(cli)} "$@"
    result=$?
    : > ${shellQuote(file("done"))}
    exit "$result"
  fi
fi
exec ${shellQuote(cli)} "$@"
`);
      await chmod(wrapper, 0o755);
      const config = vscode.workspace.getConfiguration("databricksBundleInspector");
      previousCli = config.inspect<string>("cliPath")?.globalValue;
      await config.update("cliPath", wrapper, vscode.ConfigurationTarget.Global);
    });

    after(async function () {
      if (!control) return;
      await release();
      await idle();
      await vscode.workspace.getConfiguration("databricksBundleInspector").update("cliPath", previousCli, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await rm(control, { recursive: true, force: true });
    });

    it("a slow earlier Inspect cannot replace the newer bundle", async function () {
      let earlier: Thenable<unknown> | undefined;
      try {
        await hold(1);
        await vscode.window.showTextDocument(alpha);
        earlier = inspect();
        await waitFor(() => existsSync(file("started")), "the slow alpha check");
        await vscode.window.showTextDocument(beta);
        await inspect();
        assert.equal(await graphName(), "resource_beta");
        await release();
        await earlier;
        assert.equal(await graphName(), "resource_beta", "an older completion must not replace the newer bundle");
      } finally {
        await release();
        await earlier;
      }
    });

    it("a save refresh for the previous bundle cannot replace the newly inspected bundle", async function () {
      const resource = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "alpha/resources/jobs.yml")));
      const original = resource.getText();
      try {
        await vscode.window.showTextDocument(alpha);
        await inspect();
        // First call updates diagnostics; hold the second, which refreshes the panel.
        await hold(2);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(resource.uri, resource.positionAt(original.length), "\n# exercise the in-flight refresh\n");
        await vscode.workspace.applyEdit(edit);
        await resource.save();
        await waitFor(() => existsSync(file("started")), "alpha's panel refresh");
        await vscode.window.showTextDocument(beta);
        await inspect();
        assert.equal(await graphName(), "resource_beta");
        await release();
        await waitFor(() => existsSync(file("done")), "the held CLI to finish");
        await idle();
        assert.equal(await graphName(), "resource_beta", "the previous bundle's refresh must not replace the new one");
      } finally {
        await release();
        const restore = new vscode.WorkspaceEdit();
        restore.replace(resource.uri, new vscode.Range(0, 0, resource.lineCount, 0), original);
        await vscode.workspace.applyEdit(restore);
        await resource.save();
        await idle();
      }
    });

    it("a newer job selection wins even when both inspections use the same bundle", async function () {
      let earlier: Thenable<unknown> | undefined;
      try {
        await hold(1);
        const resource = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "alpha/resources/jobs.yml")));
        const editor = await vscode.window.showTextDocument(resource);
        const first = resource.getText().split(/\r?\n/).findIndex(line => line.includes("name: alpha_first"));
        const second = resource.getText().split(/\r?\n/).findIndex(line => line.includes("name: alpha_second"));
        assert.ok(first >= 0 && second >= 0);
        editor.selection = new vscode.Selection(first, 0, first, 0);
        earlier = inspect();
        await waitFor(() => existsSync(file("started")), "the earlier job inspection");
        editor.selection = new vscode.Selection(second, 0, second, 0);
        await inspect();
        assert.equal((await graphData())?.initialResource?.key, "alpha_second");
        await release();
        await earlier;
        assert.equal((await graphData())?.initialResource?.key, "alpha_second", "an earlier job request must not undo the newer one");
      } finally {
        await release();
        await earlier;
      }
    });

    it("closing the graph cancels an inspection that started while it was open", async function () {
      let earlier: Thenable<unknown> | undefined;
      const graphOpen = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview));
      try {
        await vscode.window.showTextDocument(beta);
        await inspect();
        await waitFor(graphOpen, "the initial graph tab");
        await hold(1);
        await vscode.window.showTextDocument(alpha);
        earlier = inspect();
        await waitFor(() => existsSync(file("started")), "the pending inspection");
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await waitFor(() => !graphOpen(), "the graph tab to close");
        await release();
        await earlier;
        // Tab changes arrive after createWebviewPanel returns to the extension host.
        await sleep(300);
        assert.equal(graphOpen(), false, "the graph must stay closed after the old CLI finishes");
      } finally {
        await release();
        await earlier;
      }
    });
  });
}
