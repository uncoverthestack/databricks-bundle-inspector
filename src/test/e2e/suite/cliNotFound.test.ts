import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
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

/**
 * Runs Inspect in the real extension host with the given PATH, answers the error
 * or warning popup with `click`, and records the popups plus what the click opened.
 */
async function inspectWithPath(pathValue: string, click: string | undefined) {
  const popups: Popup[] = [];
  const warnings: Popup[] = [];
  const opened: string[] = [];
  const commands: unknown[][] = [];

  const originalPath = process.env.PATH;
  const window = vscode.window as { showErrorMessage: unknown; showWarningMessage: unknown };
  const env = vscode.env as { openExternal: unknown };
  const cmds = vscode.commands as { executeCommand: unknown };
  const originals = {
    showErrorMessage: window.showErrorMessage,
    showWarningMessage: window.showWarningMessage,
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
      if (PAUSE_MS > 0) {
        // Show the real notification too, then answer on its behalf after the pause.
        void (real as typeof vscode.window.showErrorMessage)(
          `[e2e, answering "${click ?? "dismiss"}" in ${PAUSE_MS / 1000}s] ${message}`,
          ...buttons,
        );
        await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
      }
      markAnswered();
      return click;
    };
  window.showErrorMessage = fakePopup(popups, originals.showErrorMessage);
  window.showWarningMessage = fakePopup(warnings, originals.showWarningMessage);
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
    await realExecute("databricksBundleInspector.inspectBundle");
    // The extension does not await the popup, so wait for it to be answered
    // (or give up if none appeared), then let the button handler run.
    await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, PAUSE_MS + 2_000))]);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    process.env.PATH = originalPath;
    window.showErrorMessage = originals.showErrorMessage;
    window.showWarningMessage = originals.showWarningMessage;
    env.openExternal = originals.openExternal;
    cmds.executeCommand = originals.executeCommand;
  }
  return { popups, warnings, opened, commands };
}

/** A directory holding a fake `databricks` script with the given body. */
async function fakeCli(script: string): Promise<string> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "fake-cli-"));
  const fake = path.join(bin, "databricks");
  await writeFile(fake, `#!/bin/sh\n${script}\n`);
  await chmod(fake, 0o755);
  return bin;
}

async function setCliPath(value: string | undefined) {
  await vscode.workspace
    .getConfiguration("databricksBundleInspector")
    .update("cliPath", value, vscode.ConfigurationTarget.Global);
}

export function cliNotFoundSuite() {
  describe("Databricks CLI not found popup", () => {
    before(async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder, "the fixture bundle folder should be open");
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(folder.uri, "databricks.yml"),
      );
      await vscode.window.showTextDocument(doc);
    });

    afterEach(async () => {
      await setCliPath(undefined);
      // Watch mode leaves each popup's copy on screen; clear them so they do not stack.
      await vscode.commands.executeCommand("notifications.clearAll");
    });

    it("CLI not installed: says so and opens this OS's install section", async () => {
      const { popups, opened } = await inspectWithPath(SYSTEM_PATH, "Open Install Guide");

      assert.deepEqual(popups, [
        {
          message:
            "Databricks CLI was not found. Install the Databricks CLI and ensure it is available on your PATH. If you just installed it, restart VS Code.",
          buttons: ["Open Install Guide"],
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
      assert.deepEqual(popups[0]!.buttons, ["Open Install Guide", "Open Settings"]);
      assert.deepEqual(commands, [
        ["workbench.action.openSettings", "databricksBundleInspector.cliPath"],
      ]);
      assert.deepEqual(opened, []);
    });

    it("legacy pip databricks-cli on PATH: says it is the wrong program", async function () {
      if (process.platform === "win32") this.skip();
      const bin = await fakeCli('echo "Version: 0.18.0"');

      const { popups } = await inspectWithPath(`${bin}:${SYSTEM_PATH}`, undefined);

      assert.equal(popups.length, 1);
      assert.match(
        popups[0]!.message,
        /^The "databricks" command on your PATH is not the Databricks CLI \(it printed "Version: 0\.18\.0"\)/,
      );
      assert.deepEqual(popups[0]!.buttons, ["Open Install Guide"]);
    });

    it("dismissing the popup opens nothing", async () => {
      const { popups, opened, commands } = await inspectWithPath(SYSTEM_PATH, undefined);

      assert.equal(popups.length, 1);
      assert.deepEqual(opened, []);
      assert.deepEqual(commands, []);
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
