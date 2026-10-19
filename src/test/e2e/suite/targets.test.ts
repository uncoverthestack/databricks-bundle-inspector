import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A profile from ~/.databrickscfg for the cases that need a login. The fixture has no
 * workspace host: the CLI takes it from this profile, so nothing about a real workspace
 * is committed. Run with `INSPECTOR_TEST_PROFILE=<profile> npm run test:e2e:targets`.
 */
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim() || undefined;

/** What the extension last sent to the graph (the parts these tests read). */
interface GraphData {
  inspectedTargetMode: "target" | "probe";
  inspectedTarget: string;
  inspectorIssues: Array<{ kind: string; title: string }>;
  parsedBundle: { resources?: { jobs?: Record<string, { name?: string }> } };
}

const jobName = (data: GraphData | undefined) => data?.parsedBundle.resources?.jobs?.nightly?.name;

function databricksCliAvailable(): boolean {
  try {
    execFileSync("databricks", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Names of the widgets the Problems panel warns about. */
function problemsWidgets(): string[] {
  return vscode.languages
    .getDiagnostics()
    .flatMap(([, diagnostics]) => diagnostics)
    .filter((d) => d.code === "widget_parameter_mismatch")
    .map((d) => /widget "([^"]+)"/.exec(d.message)?.[1] ?? "")
    .sort();
}

/** Names of the widgets the graph's issue list warns about. */
function graphWidgets(data: GraphData | undefined): string[] {
  return (data?.inspectorIssues ?? [])
    .filter((issue) => issue.kind === "widget_parameter_mismatch")
    .map((issue) => /widget "([^"]+)"/.exec(issue.title)?.[1] ?? "")
    .sort();
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; waited < 20_000; waited += 250) {
    if (await check()) return;
    await sleep(250);
  }
  assert.fail(`waited 20 seconds for ${what}`);
}

const graphData = async () =>
  vscode.commands.executeCommand<GraphData | undefined>("databricksBundleInspector.test.graphData");

/** Picks a target the way the graph's dropdown does; `undefined` is the structural preview. */
const pickTarget = async (target: string | undefined) =>
  vscode.commands.executeCommand<GraphData | undefined>(
    "databricksBundleInspector.test.selectTarget",
    target,
  );

async function setProfile(value: string | undefined): Promise<void> {
  // The test VS Code has its own throwaway user settings; nothing is written to the fixture.
  await vscode.workspace
    .getConfiguration("databricksBundleInspector")
    .update("profile", value, vscode.ConfigurationTarget.Global);
}

/**
 * Picking a target in the graph changes the graph only. The Problems panel keeps the
 * structural preview, which needs no login, including after a save, and nothing is
 * written into the bundle folder. The preview warns about the widget `run_date`; the
 * Problems panel must keep that warning whatever the graph shows.
 */
export function targetsSuite() {
  describe("picking a target in the graph (needs a real Databricks CLI)", function () {
    let root: string;
    let jobFile: string;
    let original: string;

    const noDatabricksFolder = () =>
      assert.equal(
        existsSync(path.join(root, ".databricks")),
        false,
        "nothing should be written into the bundle folder",
      );

    before(async function () {
      if (!databricksCliAvailable()) this.skip();
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(folder, "the targets fixture should be the open folder");
      root = folder;
      jobFile = path.join(root, "resources", "job.yml");
      original = await readFile(jobFile, "utf8");

      await waitFor(
        () => problemsWidgets().includes("run_date"),
        "the structural preview's warning in the Problems panel",
      );
      const bundleFile = await vscode.workspace.openTextDocument(path.join(root, "databricks.yml"));
      await vscode.window.showTextDocument(bundleFile);
      await vscode.commands.executeCommand("databricksBundleInspector.inspectBundle");
      await waitFor(async () => (await graphData()) !== undefined, "the graph to open");
    });

    after(async function () {
      if (original !== undefined) await writeFile(jobFile, original);
      await setProfile(undefined);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });

    it("starts on the structural preview", async function () {
      const data = await graphData();
      assert.equal(data?.inspectedTargetMode, "probe");
      assert.deepEqual(graphWidgets(data), ["run_date"]);
      assert.deepEqual(problemsWidgets(), ["run_date"]);
      noDatabricksFolder();
    });

    // When the CLI fails but still prints a bundle, the graph shows what it printed. How
    // the graph should label that is #136; these cases check what this change owns.

    it("a target the CLI rejects leaves the Problems panel and the bundle folder alone", async function () {
      // For example a target removed from databricks.yml after the dropdown listed it.
      await pickTarget("no_such_target");

      assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();
    });

    it("with a profile that doesn't exist, the CLI's error reaches the graph's issue list", async function () {
      await setProfile("NO_SUCH_PROFILE_E2E");

      const data = await pickTarget("dev");

      assert.ok(
        data?.inspectorIssues.some((issue) => issue.kind === "validation_diagnostic"),
        "the CLI's login error should be listed in the graph",
      );
      assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();
    });

    it("a real target changes the graph, not the Problems panel (needs a login)", async function () {
      if (!profile) this.skip();
      await setProfile(profile);

      const data = await pickTarget("dev");

      assert.equal(data?.inspectedTargetMode, "target");
      assert.equal(data?.inspectedTarget, "dev");
      assert.equal(jobName(data), "targets-e2e-nightly");
      assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();
    });

    it("after a save, the Problems panel stays on the preview and the graph on the target (needs a login)", async function () {
      if (!profile) this.skip();
      const document = await vscode.workspace.openTextDocument(jobFile);
      const editor = await vscode.window.showTextDocument(document);
      const start = document.getText().indexOf("targets-e2e-nightly");
      await editor.edit((edit) =>
        edit.insert(document.positionAt(start + "targets-e2e-nightly".length), "-renamed"),
      );
      await document.save();

      await waitFor(
        async () => jobName(await graphData()) === "targets-e2e-nightly-renamed",
        "the graph to show the saved change",
      );
      const data = await graphData();
      assert.equal(data?.inspectedTargetMode, "target", "the graph stays on dev");
      assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();
    });

    it("picking the structural preview again shows the preview in the graph", async function () {
      const data = await pickTarget(undefined);

      assert.equal(data?.inspectedTargetMode, "probe");
      assert.ok(graphWidgets(data).includes("run_date"));
      noDatabricksFolder();
    });
  });
}
