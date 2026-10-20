import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

const INSTALL_DOCS = "https://docs.databricks.com/aws/en/dev-tools/cli/install";
const INSTALL_SECTION: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "#homebrew-installation-for-macos",
  win32: "#winget-installation-for-windows",
  linux: "#curl-installation-for-linux-macos-and-windows",
};
const UPDATE_SECTION: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "#homebrew-update-for-linux-or-macos",
  win32: "#winget-update-for-windows",
  linux: "#curl-update-for-linux-macos-and-windows",
};
const SYSTEM_PATH = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin";

type Popup = { message: string; buttons: string[] };

/** How long to leave each real popup on screen before answering it. 0 in normal runs. */
const PAUSE_MS = Number(process.env.E2E_PAUSE_MS ?? 0);

type Recorded = {
  popups: Popup[];
  warnings: Popup[];
  infos: Popup[];
  opened: string[];
  commands: unknown[][];
};

/**
 * Runs Inspect in the real extension host with the given PATH, answers the error
 * or warning popups with `click` (one answer per popup when it is a list), and
 * records the popups plus what the click opened. `pick` is the file the open dialog
 * returns; `until` keeps waiting for a flow that goes on after the first answer.
 */
async function inspectWithPath(
  pathValue: string,
  click: string | readonly (string | undefined)[] | undefined,
  options: {
    command?: string;
    pick?: string;
    until?: (recorded: Recorded) => boolean;
  } = {},
) {
  const command = options.command ?? "databricksBundleInspector.inspectBundle";
  const answers = Array.isArray(click) ? [...click] : [click];
  const popups: Popup[] = [];
  const warnings: Popup[] = [];
  const infos: Popup[] = [];
  const opened: string[] = [];
  const commands: unknown[][] = [];
  const recorded: Recorded = { popups, warnings, infos, opened, commands };

  const originalPath = process.env.PATH;
  const window = vscode.window as {
    showErrorMessage: unknown;
    showWarningMessage: unknown;
    showInformationMessage: unknown;
    showOpenDialog: unknown;
  };
  const env = vscode.env as { openExternal: unknown };
  const cmds = vscode.commands as { executeCommand: unknown };
  const originals = {
    showErrorMessage: window.showErrorMessage,
    showWarningMessage: window.showWarningMessage,
    showInformationMessage: window.showInformationMessage,
    showOpenDialog: window.showOpenDialog,
    openExternal: env.openExternal,
    executeCommand: cmds.executeCommand,
  };
  const realExecute = vscode.commands.executeCommand.bind(vscode.commands);
  let markAnswered: () => void = () => {};
  const answered = new Promise<void>((resolve) => (markAnswered = resolve));

  const fakePopup =
    (recorded: Popup[], real: unknown) =>
    async (message: string, ...buttons: string[]) => {
      recorded.push({ message, buttons });
      const answer = answers.shift();
      if (PAUSE_MS > 0) {
        // Show the real notification too, then answer on its behalf after the pause.
        void (real as typeof vscode.window.showErrorMessage)(
          `[e2e, answering "${answer ?? "dismiss"}" in ${PAUSE_MS / 1000}s] ${message}`,
          ...buttons,
        );
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
      markAnswered();
      return answer;
    };
  window.showErrorMessage = fakePopup(popups, originals.showErrorMessage);
  window.showWarningMessage = fakePopup(warnings, originals.showWarningMessage);
  window.showInformationMessage = async (message: string, ...buttons: string[]) => {
    infos.push({ message, buttons });
    return undefined;
  };
  window.showOpenDialog = async () => (options.pick ? [vscode.Uri.file(options.pick)] : undefined);
  env.openExternal = async (uri: vscode.Uri) => {
    opened.push(uri.toString(true));
    return true;
  };
  cmds.executeCommand = async (command: string, ...args: unknown[]) => {
    if (command === "workbench.action.openSettings") {
      commands.push([command, ...args]);
      return undefined;
    }
    return realExecute(command, ...args);
  };

  try {
    process.env.PATH = pathValue;
    await realExecute(command);
    // The extension does not await the popup, so wait for it to be answered
    // (or give up if none appeared), then let the button handler run.
    await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, PAUSE_MS + 2_000))]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const deadline = Date.now() + 10_000;
    while (options.until && !options.until(recorded) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    process.env.PATH = originalPath;
    window.showErrorMessage = originals.showErrorMessage;
    window.showWarningMessage = originals.showWarningMessage;
    window.showInformationMessage = originals.showInformationMessage;
    window.showOpenDialog = originals.showOpenDialog;
    env.openExternal = originals.openExternal;
    cmds.executeCommand = originals.executeCommand;
  }
  return recorded;
}

/** A directory holding a fake `databricks` (or `name`) script with the given body. */
async function fakeCli(script: string, name = "databricks"): Promise<string> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "fake-cli-"));
  const fake = path.join(bin, name);
  await writeFile(fake, `#!/bin/sh\n${script}\n`);
  await chmod(fake, 0o755);
  return bin;
}

async function setCliPath(value: string | undefined) {
  await vscode.workspace
    .getConfiguration("databricksBundleInspector")
    .update("cliPath", value, vscode.ConfigurationTarget.Global);
}

async function showBundleFile() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the fixture bundle folder should be open");
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder.uri, "databricks.yml"),
  );
  await vscode.window.showTextDocument(doc);
}

export function cliNotFoundSuite() {
  describe("Databricks CLI not found popup", () => {
    before(showBundleFile);

    afterEach(async () => {
      await setCliPath(undefined);
      // A test that finds the CLI opens the graph, which takes the front from databricks.yml.
      await showBundleFile();
      // Watch mode leaves each popup's copy on screen; clear them so they do not stack.
      await vscode.commands.executeCommand("notifications.clearAll");
    });

    it("CLI not installed: says so and opens this OS's install section", async () => {
      const { popups, opened } = await inspectWithPath(SYSTEM_PATH, "Open Install Guide");

      assert.deepEqual(popups, [
        {
          message:
            "Databricks CLI not found. Just installed it? Restart VS Code. Otherwise, locate it.",
          buttons: ["Open Install Guide", "Locate CLI…"],
        },
      ]);
      assert.deepEqual(opened, [INSTALL_DOCS + (INSTALL_SECTION[process.platform] ?? "")]);
    });

    it("bad cliPath setting: names the setting and Open Settings goes to it", async () => {
      await setCliPath("/nonexistent/databricks");

      const { popups, commands, opened } = await inspectWithPath(SYSTEM_PATH, "Open Settings");

      assert.equal(popups.length, 1);
      assert.match(
        popups[0]!.message,
        /^The databricksBundleInspector\.cliPath setting \("\/nonexistent\/databricks"\) is not a working Databricks CLI/,
      );
      assert.deepEqual(popups[0]!.buttons, ["Open Install Guide", "Locate CLI…", "Open Settings"]);
      assert.deepEqual(commands, [
        ["workbench.action.openSettings", "databricksBundleInspector.cliPath"],
      ]);
      assert.deepEqual(opened, []);
    });

    it("legacy pip databricks-cli on PATH: says it is the wrong program", async function () {
      if (process.platform === "win32") this.skip();
      // What the legacy package prints (databricks_cli/version.py, tag 0.18.0).
      const bin = await fakeCli('echo "Version 0.18.0"');

      const { popups } = await inspectWithPath(`${bin}:${SYSTEM_PATH}`, undefined);

      assert.equal(popups.length, 1);
      assert.match(
        popups[0]!.message,
        /^The "databricks" command on your PATH is the legacy databricks-cli pip package \(0\.18\.0\)/,
      );
      assert.deepEqual(popups[0]!.buttons, ["Open Install Guide", "Locate CLI…"]);
    });

    it("clicking the status bar item says the same, with no file open", async () => {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      try {
        const { popups, opened } = await inspectWithPath(
          SYSTEM_PATH,
          "Open Install Guide",
          { command: "databricksBundleInspector.statusBarAction" },
        );

        assert.deepEqual(popups, [
          {
            message:
              "Databricks CLI not found. Just installed it? Restart VS Code. Otherwise, locate it.",
            buttons: ["Open Install Guide", "Locate CLI…"],
          },
        ]);
        assert.deepEqual(opened, [INSTALL_DOCS + (INSTALL_SECTION[process.platform] ?? "")]);
      } finally {
        await showBundleFile();
      }
    });

    it("dismissing the popup opens nothing", async () => {
      const { popups, opened, commands } = await inspectWithPath(SYSTEM_PATH, undefined);

      assert.equal(popups.length, 1);
      assert.deepEqual(opened, []);
      assert.deepEqual(commands, []);
    });

    it("Locate CLI…: a working CLI is saved as cliPath and the bundle is inspected again", async function () {
      if (process.platform === "win32") this.skip();
      const calls = path.join(await mkdtemp(path.join(os.tmpdir(), "fake-cli-calls-")), "calls");
      const bin = await fakeCli(
        [
          'if [ "$1" = "--version" ]; then echo "Databricks CLI v0.299.2"; exit 0; fi',
          `echo "$1 $2" >> "${calls}"`,
          'echo \'{"bundle":{"name":"e2e_cli_not_found"}}\'',
        ].join("\n"),
      );
      const cli = path.join(bin, "databricks");

      const { popups, infos } = await inspectWithPath(SYSTEM_PATH, "Locate CLI…", {
        pick: cli,
        until: (recorded) => recorded.infos.length > 0 && existsSync(calls),
      });

      assert.equal(popups.length, 1, `the second Inspect finds the CLI; pop-ups: ${JSON.stringify(popups)}`);
      assert.deepEqual(infos, [
        {
          message: `Using Databricks CLI v0.299.2 from ${cli}. Saved to the databricksBundleInspector.cliPath setting.`,
          buttons: [],
        },
      ]);
      assert.equal(
        vscode.workspace.getConfiguration("databricksBundleInspector").get("cliPath"),
        cli,
      );
      assert.match(await readFile(calls, "utf8"), /^bundle validate$/m);
    });

    it("Locate CLI…: a program that isn't the CLI is refused and nothing is saved", async function () {
      if (process.platform === "win32") this.skip();
      const bin = await fakeCli('echo "jq-1.7.1"', "jq");

      const { popups, infos } = await inspectWithPath(SYSTEM_PATH, ["Locate CLI…", undefined], {
        pick: path.join(bin, "jq"),
        until: (recorded) => recorded.popups.length >= 2,
      });

      assert.deepEqual(popups[1], {
        message: 'jq is not the Databricks CLI (it printed "jq-1.7.1"). Pick databricks.',
        buttons: ["Locate CLI…"],
      });
      assert.deepEqual(infos, []);
      assert.equal(
        vscode.workspace.getConfiguration("databricksBundleInspector").get("cliPath"),
        "",
      );
    });

    // Last: a CLI that is found stays cached for the rest of the session.
    it("CLI older than v0.299.0: warns once, and Open Update Guide opens the update section", async function () {
      if (process.platform === "win32") this.skip();
      const bin = await fakeCli(
        [
          'if [ "$1" = "--version" ]; then echo "Databricks CLI v0.250.0"; exit 0; fi',
          'echo \'{"bundle":{"name":"e2e_cli_not_found"}}\'',
        ].join("\n"),
      );

      const first = await inspectWithPath(`${bin}:${SYSTEM_PATH}`, "Open Update Guide");

      assert.deepEqual(first.popups, [], "an outdated CLI still inspects the bundle");
      assert.deepEqual(first.warnings, [
        {
          message:
            "Databricks CLI v0.250.0 is older than v0.299.0, the oldest version this inspector is tested with. Results may be incomplete. Update the Databricks CLI.",
          buttons: ["Open Update Guide"],
        },
      ]);
      assert.deepEqual(first.opened, [INSTALL_DOCS + (UPDATE_SECTION[process.platform] ?? "")]);

      const second = await inspectWithPath(`${bin}:${SYSTEM_PATH}`, undefined);
      assert.deepEqual(second.warnings, [], "the warning is shown once per session");
    });
  });
}
