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
const SYSTEM_PATH = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin";

type Popup = { message: string; buttons: string[] };

/** How long to leave each real popup on screen before answering it. 0 in normal runs. */
const PAUSE_MS = Number(process.env.E2E_PAUSE_MS ?? 0);

/**
 * Runs Inspect in the real extension host with the given PATH, answers the error
 * popup with `click`, and records the popup plus what the click opened.
 */
async function inspectWithPath(pathValue: string, click: string | undefined) {
  const popups: Popup[] = [];
  const opened: string[] = [];
  const commands: unknown[][] = [];

  const originalPath = process.env.PATH;
  const window = vscode.window as { showErrorMessage: unknown };
  const env = vscode.env as { openExternal: unknown };
  const cmds = vscode.commands as { executeCommand: unknown };
  const originals = {
    showErrorMessage: window.showErrorMessage,
    openExternal: env.openExternal,
    executeCommand: cmds.executeCommand,
  };
  const realExecute = vscode.commands.executeCommand.bind(vscode.commands);
  let markAnswered: () => void = () => {};
  const answered = new Promise<void>((resolve) => (markAnswered = resolve));

  window.showErrorMessage = async (message: string, ...buttons: string[]) => {
    popups.push({ message, buttons });
    if (PAUSE_MS > 0) {
      // Show the real notification too, then answer on its behalf after the pause.
      void (originals.showErrorMessage as typeof vscode.window.showErrorMessage)(
        `[e2e, answering "${click ?? "dismiss"}" in ${PAUSE_MS / 1000}s] ${message}`,
        ...buttons,
      );
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
    markAnswered();
    return click;
  };
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
    env.openExternal = originals.openExternal;
    cmds.executeCommand = originals.executeCommand;
  }
  return { popups, opened, commands };
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
            "Databricks CLI was not found. Install the Databricks CLI and ensure it is available on your PATH.",
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
      const bin = await mkdtemp(path.join(os.tmpdir(), "legacy-cli-"));
      const fake = path.join(bin, "databricks");
      await writeFile(fake, '#!/bin/sh\necho "Version: 0.18.0"\n');
      await chmod(fake, 0o755);

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
  });
}
