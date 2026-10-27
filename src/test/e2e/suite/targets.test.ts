import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { codeValue } from "../../../bundle/issueDocs.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A profile from ~/.databrickscfg for the cases that need a login. The fixture has no
 * workspace host: the CLI takes it from this profile, so nothing about a real workspace
 * is committed. Run with `npm run test:e2e:targets -- --profile <profile>`.
 */
const profile = process.env.INSPECTOR_TEST_PROFILE?.trim() || undefined;

/** What the extension last sent to the graph (the parts these tests read). */
interface GraphData {
  inspectedTargetMode: "target" | "probe";
  inspectedTarget: string;
  targetFallbackMessage: string | null;
  targetFallbackReason: string | null;
  inspectorIssues: Array<{ kind: string; title: string }>;
  parsedBundle: { resources?: { jobs?: Record<string, { name?: string }> } };
  profileChoice?: { host: string; names: string[] } | null;
  graph: { nodes: Array<{ nodeType: string; taskData?: { fileReferences: Array<{ exists: boolean }> } }> };
}

const jobName = (data: GraphData | undefined) => data?.parsedBundle.resources?.jobs?.nightly?.name;

/** Whether the graph found the task's notebook on disk. */
const notebookFound = (data: GraphData | undefined) =>
  data?.graph.nodes.some((node) => node.taskData?.fileReferences.some((ref) => ref.exists)) ?? false;

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
    .filter((d) => codeValue(d.code) === "widget_not_set")
    .map((d) => /widget "([^"]+)"/.exec(d.message)?.[1] ?? "")
    .sort();
}

/** Names of the widgets the graph's issue list warns about. */
function graphWidgets(data: GraphData | undefined): string[] {
  return (data?.inspectorIssues ?? [])
    .filter((issue) => issue.kind === "widget_not_set")
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

/**
 * Points the extension at a wrapper around the real CLI that logs each run, and can wait
 * before a real target answers. POSIX shell only, so the cases using it skip on Windows.
 */
async function withLoggingCli<T>(
  options: { slowTarget?: string },
  body: (runs: () => Promise<string[]>) => Promise<T>,
): Promise<T> {
  const log = path.join(os.tmpdir(), `bdi-e2e-cli-${process.pid}.log`);
  const wrapper = path.join(os.tmpdir(), `bdi-e2e-cli-${process.pid}.sh`);
  const real = execFileSync("which", ["databricks"], { encoding: "utf8" }).trim();
  const wait = options.slowTarget ? `case "$*" in *"--target ${options.slowTarget}"*) sleep 2;; esac\n` : "";
  await writeFile(wrapper, `#!/bin/sh\necho "$*" >> "${log}"\n${wait}exec "${real}" "$@"\n`, { mode: 0o755 });
  const config = vscode.workspace.getConfiguration("databricksBundleInspector");
  await config.update("cliPath", wrapper, vscode.ConfigurationTarget.Global);
  try {
    return await body(async () =>
      (existsSync(log) ? await readFile(log, "utf8") : "").split("\n").filter((line) => line.startsWith("bundle validate")),
    );
  } finally {
    await config.update("cliPath", undefined, vscode.ConfigurationTarget.Global);
    await rm(log, { force: true });
    await rm(wrapper, { force: true });
  }
}

/**
 * Runs `body` with the CLI reading an empty `~/.databrickscfg` stand-in, so a missing
 * profile gives the same message on every machine: with no config file at all (as on CI)
 * the CLI reports no credentials instead. The tests run in the extension's own process,
 * so the CLI it starts sees this.
 */
async function withEmptyCliConfig<T>(body: () => Promise<T>): Promise<T> {
  const config = path.join(os.tmpdir(), `bdi-e2e-empty-${process.pid}.cfg`);
  const saved = process.env.DATABRICKS_CONFIG_FILE;
  await writeFile(config, "");
  process.env.DATABRICKS_CONFIG_FILE = config;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.DATABRICKS_CONFIG_FILE;
    else process.env.DATABRICKS_CONFIG_FILE = saved;
    await rm(config, { force: true });
  }
}

const MISSING_PROFILE_REASON = 'there\'s no sign-in profile named "NO_SUCH_PROFILE_E2E"';

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
    let notebook: string;
    let original: string;
    let originalNotebook: string;

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
      notebook = path.join(root, "src", "load.py");
      originalNotebook = await readFile(notebook, "utf8");

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
      if (originalNotebook !== undefined) await writeFile(notebook, originalNotebook);
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

    // When the CLI fails on a real target it still prints a bundle, but one it stopped
    // building part way, so the graph shows the structural preview and the CLI's reason.

    it("a target the CLI rejects shows the preview and leaves the bundle folder alone", async function () {
      // For example a target removed from databricks.yml after the dropdown listed it.
      const data = await pickTarget("no_such_target");

      assert.equal(data?.inspectedTargetMode, "probe");
      assert.match(data?.targetFallbackMessage ?? "", /no_such_target/);
      assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();
    });

    it("with a profile that doesn't exist, the graph shows the preview and the CLI's error", async function () {
      await setProfile("NO_SUCH_PROFILE_E2E");

      const data = await withEmptyCliConfig(() => pickTarget("dev"));

      // Without the fallback the graph said "dev" but held the base task, so it warned
      // about run_date, which dev passes (#136).
      assert.equal(data?.inspectedTargetMode, "probe", "the graph is not labelled dev");
      assert.match(data?.targetFallbackMessage ?? "", /NO_SUCH_PROFILE_E2E/);
      assert.equal(data?.targetFallbackReason, MISSING_PROFILE_REASON);
      assert.deepEqual(graphWidgets(data), ["run_date"], "the preview's warning, labelled as the preview");
      assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();
    });

    describe("signing in for a target (no account used)", function () {
      type Banner = { target: string; stage: string; blockedReason?: string } | null;
      const banner = () => vscode.commands.executeCommand<Banner>("databricksBundleInspector.test.signIn");
      const HOST = "https://signin-e2e.example.invalid";
      let dir: string;
      let config: string;
      let typed: Array<{ text: string; addNewLine: boolean | undefined }>;
      const saved: Record<string, string | undefined> = {};
      const window = vscode.window as {
        createTerminal: typeof vscode.window.createTerminal;
        showInputBox: typeof vscode.window.showInputBox;
      };
      const originals = { createTerminal: window.createTerminal, showInputBox: window.showInputBox };

      beforeEach(async function () {
        this.timeout(60_000);
        dir = await mkdtemp(path.join(os.tmpdir(), "bdi-e2e-signin-"));
        config = path.join(dir, "databrickscfg");
        await writeFile(config, "");
        for (const key of ["DATABRICKS_CONFIG_FILE", "DATABRICKS_AUTH_STORAGE"]) saved[key] = process.env[key];
        process.env.DATABRICKS_CONFIG_FILE = config;
        // The CLI reads a file token cache, never the OS keychain.
        process.env.DATABRICKS_AUTH_STORAGE = "plaintext";
        typed = [];
        // A stand-in terminal records what would be typed; no shell is started.
        window.createTerminal = (() => ({
          show: () => {},
          sendText: (text: string, addNewLine?: boolean) => void typed.push({ text, addNewLine }),
          dispose: () => {},
        })) as unknown as typeof vscode.window.createTerminal;
        window.showInputBox = (async () => HOST) as typeof vscode.window.showInputBox;
        await setProfile("NO_SUCH_PROFILE_E2E");
      });

      afterEach(async function () {
        window.createTerminal = originals.createTerminal;
        window.showInputBox = originals.showInputBox;
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await pickTarget(undefined);
        await rm(dir, { recursive: true, force: true });
      });

      const openTerminal = () =>
        vscode.commands.executeCommand("databricksBundleInspector.sidebar.openSignInTerminal", { kind: "graph", root });

      it("a missing sign-in offers the terminal, which gets the command typed and not run", async function () {
        this.timeout(120_000);
        const data = (await pickTarget("dev")) as GraphData & { signIn?: Banner };
        assert.equal(data?.inspectedTargetMode, "probe", "the graph shows the structural preview");
        assert.deepEqual(data?.signIn, { target: "dev", stage: "needed" });

        await openTerminal();
        // dev has no workspace host, so the URL was asked for.
        assert.deepEqual(typed, [
          { text: `databricks auth login --host "${HOST}" --profile "NO_SUCH_PROFILE_E2E"`, addNewLine: false },
        ]);
        assert.equal((await banner())?.stage, "terminal");

        // Another profile changing is not this sign-in.
        await writeFile(config, "[someone-else]\nhost = https://other.example.invalid\nauth_type = databricks-cli\n");
        await sleep(1_500);
        assert.equal((await banner())?.stage, "terminal");

        // What `auth login` writes: the profile with browser sign-in, and a copy of the old file.
        await writeFile(`${config}.bak`, "[someone-else]\n");
        await writeFile(
          config,
          `[someone-else]\nhost = https://other.example.invalid\nauth_type = databricks-cli\n\n[NO_SUCH_PROFILE_E2E]\nhost = ${HOST}\nauth_type = databricks-cli\n`,
        );
        await waitFor(async () => (await banner())?.stage === "updated", "the profile-updated banner");

        // Checking again: no token was ever saved, so dev falls back, and the banner starts over.
        const again = (await vscode.commands.executeCommand("databricksBundleInspector.test.checkTargetAgain", "dev")) as GraphData & {
          signIn?: Banner;
        };
        assert.equal(again?.inspectedTargetMode, "probe");
        assert.deepEqual(again?.signIn, { target: "dev", stage: "needed" });
        assert.equal(typed.length, 1, "nothing typed again by itself");
        noDatabricksFolder();
      });

      it("picking the preview while the terminal waits clears the banner, and a later sign-in changes nothing", async function () {
        this.timeout(120_000);
        await pickTarget("dev");
        await openTerminal();
        assert.equal((await banner())?.stage, "terminal");

        const preview = (await pickTarget(undefined)) as GraphData & { signIn?: Banner };
        assert.equal(preview?.signIn ?? null, null);
        await writeFile(config, `[NO_SUCH_PROFILE_E2E]\nhost = ${HOST}\nauth_type = databricks-cli\n`);
        await sleep(1_500);
        assert.equal(await banner(), null);
      });

      it("a config file that can't be written: nothing is typed, and the banner says why", async function () {
        if (process.platform === "win32") this.skip();
        this.timeout(60_000);
        await pickTarget("dev");
        await chmod(dir, 0o500);
        try {
          await openTerminal();
          assert.deepEqual(typed, []);
          assert.match((await banner())?.blockedReason ?? "", /can't be written/);
        } finally {
          await chmod(dir, 0o700);
        }
      });
    });

    it("after a fallback, saves refresh the preview without running the target again", async function () {
      if (process.platform === "win32") this.skip();
      await setProfile("NO_SUCH_PROFILE_E2E");
      await withEmptyCliConfig(() => withLoggingCli({}, async (runs) => {
        const picked = await pickTarget("dev");
        assert.equal(picked?.inspectedTargetMode, "probe");

        const document = await vscode.workspace.openTextDocument(jobFile);
        const editor = await vscode.window.showTextDocument(document);
        const before = (await runs()).length;
        for (let i = 0; i < 2; i++) {
          await editor.edit((edit) => edit.insert(document.positionAt(document.getText().length), `# save ${i}\n`));
          await document.save();
          await waitFor(async () => (await runs()).length > before + i, "the save's check");
          await sleep(1000);
        }
        const afterSaves = (await runs()).slice(before);
        assert.deepEqual(afterSaves.filter((run) => run.includes("--target dev")), [], "the failing target is not run on save");
        const data = await graphData();
        assert.equal(data?.inspectedTargetMode, "probe");
        assert.equal(data?.targetFallbackReason, MISSING_PROFILE_REASON, "the note stays");

        // Picking the target again retries it.
        const count = (await runs()).length;
        await pickTarget("dev");
        assert.ok((await runs()).slice(count).some((run) => run.includes("--target dev")), "picking again runs the target");
      }));
      await writeFile(jobFile, original);
      await setProfile(undefined);
      noDatabricksFolder();
    });

    it("picking the preview while a slow target is still checked shows the preview (needs a login)", async function () {
      if (!profile || process.platform === "win32") this.skip();
      await setProfile(profile);
      await withLoggingCli({ slowTarget: "dev" }, async () => {
        const slow = pickTarget("dev");
        await sleep(200);
        await pickTarget(undefined);
        await slow;
        await sleep(500);
        assert.equal((await graphData())?.inspectedTargetMode, "probe", "the last pick wins");
      });
      await setProfile(undefined);
    });

    it("a real target changes the graph, not the Problems panel (needs a login)", async function () {
      if (!profile) this.skip();
      await setProfile(profile);

      const data = await pickTarget("dev");

      assert.equal(data?.inspectedTargetMode, "target");
      assert.equal(data?.inspectedTarget, "dev");
      assert.equal(jobName(data), "targets-e2e-nightly");
      // The CLI gives a workspace path; the inspector reads the local notebook instead,
      // so "no warning" below means checked, not skipped.
      assert.ok(notebookFound(data), "the graph should find the local notebook");
      assert.deepEqual(graphWidgets(data), [], "dev passes run_date");
      assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();
    });

    it("a notebook saved while a target is shown is checked in the graph (needs a login)", async function () {
      if (!profile) this.skip();
      const document = await vscode.workspace.openTextDocument(notebook);
      const editor = await vscode.window.showTextDocument(document);
      // A widget nobody passes: the preview and dev both warn about it.
      await editor.edit((edit) =>
        edit.insert(document.positionAt(document.getText().length), 'region = dbutils.widgets.get("region")\n'),
      );
      await document.save();

      await waitFor(
        async () => graphWidgets(await graphData()).includes("region"),
        "the graph to check the saved notebook",
      );
      const data = await graphData();
      assert.equal(data?.inspectedTargetMode, "target", "the graph stays on dev");
      assert.deepEqual(graphWidgets(data), ["region"], "dev still passes run_date");
      await waitFor(() => problemsWidgets().includes("region"), "the Problems panel to check it too");
      assert.deepEqual(problemsWidgets(), ["region", "run_date"], "the Problems panel keeps the preview");
      noDatabricksFolder();

      // Put the notebook back for the next case.
      await writeFile(notebook, originalNotebook);
      await waitFor(() => !problemsWidgets().includes("region"), "the region warning to clear");
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

    it("several matching profiles: the graph offers a choice, which is saved, with no pop-up", async function () {
      // Two profiles for the `ambiguous` target's made-up workspace, in a throwaway config.
      // The tests run in the extension's own process, so the CLI it starts sees this.
      const config = path.join(os.tmpdir(), `bdi-e2e-profiles-${process.pid}.cfg`);
      await writeFile(
        config,
        "[first-one]\nhost = https://ambiguous.example.invalid\ntoken = dapi-fake-1\n\n" +
          "[second one]\nhost = https://ambiguous.example.invalid\ntoken = dapi-fake-2\n",
      );
      const savedEnv = {
        DATABRICKS_CONFIG_FILE: process.env.DATABRICKS_CONFIG_FILE,
        DATABRICKS_CONFIG_PROFILE: process.env.DATABRICKS_CONFIG_PROFILE,
        DATABRICKS_HOST: process.env.DATABRICKS_HOST,
      };
      const { showWarningMessage, showQuickPick } = vscode.window;
      const warnings: string[] = [];
      let offered: string[] = [];
      try {
        process.env.DATABRICKS_CONFIG_FILE = config;
        delete process.env.DATABRICKS_CONFIG_PROFILE;
        delete process.env.DATABRICKS_HOST;
        await setProfile(undefined);
        (vscode.window as any).showWarningMessage = async (message: string) => {
          warnings.push(message);
          return undefined;
        };
        (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
          offered = items.map((item) => item.label);
          return items.find((item) => item.label === "second one");
        };

        const data = await pickTarget("ambiguous");

        assert.deepEqual(data?.profileChoice?.names, ["first-one", "second one"]);
        assert.deepEqual(warnings, [], "the choice is offered in the graph, not in a pop-up");
        assert.deepEqual(problemsWidgets(), ["run_date"], "the Problems panel keeps the preview");

        const after = await vscode.commands.executeCommand<GraphData | undefined>(
          "databricksBundleInspector.test.chooseProfileFromGraph",
        );

        assert.deepEqual(offered, ["first-one", "second one"], "only the matching profiles are offered");
        assert.equal(
          vscode.workspace.getConfiguration("databricksBundleInspector").get("profile"),
          "second one",
        );
        // Checked again with that profile: the made-up workspace can't be reached, but the
        // CLI no longer reports several profiles.
        assert.equal(after?.profileChoice ?? null, null);
        noDatabricksFolder();
      } finally {
        (vscode.window as any).showWarningMessage = showWarningMessage;
        (vscode.window as any).showQuickPick = showQuickPick;
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(config, { force: true });
        await setProfile(undefined);
      }
    });

    it("the Choose Databricks Login Profile command: lists every profile, can clear it, and says when there are none", async function () {
      const config = path.join(os.tmpdir(), `bdi-e2e-profiles-cmd-${process.pid}.cfg`);
      const savedConfigFile = process.env.DATABRICKS_CONFIG_FILE;
      const { showQuickPick, showInformationMessage } = vscode.window;
      const infos: string[] = [];
      let offered: string[] = [];
      let answer = "";
      try {
        await writeFile(
          config,
          "[alpha]\nhost = https://a.example.invalid\ntoken = x\n\n[beta]\nhost = https://b.example.invalid\ntoken = y\n",
        );
        process.env.DATABRICKS_CONFIG_FILE = config;
        (vscode.window as any).showQuickPick = async (items: vscode.QuickPickItem[]) => {
          offered = items.map((item) => item.label);
          return items.find((item) => item.label === answer);
        };
        (vscode.window as any).showInformationMessage = async (message: string) => {
          infos.push(message);
          return undefined;
        };
        const profileSetting = () =>
          vscode.workspace.getConfiguration("databricksBundleInspector").get<string>("profile") ?? "";

        answer = "beta";
        await vscode.commands.executeCommand("databricksBundleInspector.chooseProfile");
        assert.deepEqual(offered, ["alpha", "beta", "Use the Databricks CLI's own choice"]);
        assert.equal(profileSetting(), "beta");

        answer = "Use the Databricks CLI's own choice";
        await vscode.commands.executeCommand("databricksBundleInspector.chooseProfile");
        assert.equal(profileSetting(), "", "the saved profile is cleared");

        await writeFile(config, "");
        offered = [];
        await vscode.commands.executeCommand("databricksBundleInspector.chooseProfile");
        assert.deepEqual(offered, [], "no list without profiles");
        assert.equal(infos.length, 1);
        assert.match(infos[0]!, /No Databricks login profiles were found/);
      } finally {
        (vscode.window as any).showQuickPick = showQuickPick;
        (vscode.window as any).showInformationMessage = showInformationMessage;
        if (savedConfigFile === undefined) delete process.env.DATABRICKS_CONFIG_FILE;
        else process.env.DATABRICKS_CONFIG_FILE = savedConfigFile;
        await rm(config, { force: true });
        await setProfile(undefined);
      }
    });

    it("picking the structural preview again shows the preview in the graph", async function () {
      const data = await pickTarget(undefined);

      assert.equal(data?.inspectedTargetMode, "probe");
      assert.ok(graphWidgets(data).includes("run_date"));
      noDatabricksFolder();
    });
  });
}
