/**
 * Runs the e2e suite inside a real VS Code with this extension loaded.
 * Build first with `npm run test:e2e`, which bundles this file to out/e2e.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";
import { folderIgnoresCase, swapLetterCase } from "../../bundle/pathCase.js";

async function main() {
  const root = path.resolve(__dirname, "../..");
  // Set in terminals inside VS Code; it would make the test VS Code start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // A fresh, short user data dir: macOS caps VS Code's socket path at 103 characters,
  // and a clean profile means no leftover cliPath setting.
  const userData = await mkdtemp(path.join(os.tmpdir(), "dbi-e2e-"));
  const suite = process.env.E2E_SUITE ?? "cliNotFound";
  let folder = path.join(root, process.env.E2E_FIXTURE ?? "src/test/e2e/fixtures/bundle");
  // `E2E_FOLDER_CASE=other` opens the folder under another letter case, as happens when
  // someone types a path by hand. That path only exists where the file system ignores case.
  if (process.env.E2E_FOLDER_CASE === "other") {
    if (!(await folderIgnoresCase(folder))) {
      console.log("Skipped: this file system tells letter case apart, so the folder has one spelling.");
      return;
    }
    folder = path.join(path.dirname(folder), swapLetterCase(path.basename(folder)));
  }
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out/e2e/suite/index.cjs"),
    // `npm run test:e2e:watch` sets this so each popup stays on screen long enough to read.
    // `E2E_SUITE` and `E2E_FIXTURE` pick another suite and the folder it opens; see `npm run test:e2e:include`.
    extensionTestsEnv: {
      E2E_PAUSE_MS: process.env.E2E_PAUSE_MS ?? "0",
      E2E_SUITE: suite,
      // A ~/.databrickscfg profile for the cases that need a login (see the targets fixture).
      ...(process.env.INSPECTOR_TEST_PROFILE
        ? { INSPECTOR_TEST_PROFILE: process.env.INSPECTOR_TEST_PROFILE }
        : {}),
      // The extension checks the open bundle as soon as VS Code starts. A real CLI found
      // then stays cached for the session, so this suite starts with none on the PATH.
      ...(suite === "cliNotFound"
        ? {
            PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin",
            // On Windows the extension also reads the `Path` stored in the registry, which holds a real CLI.
            INSPECTOR_TEST_NO_STORED_PATH: "1",
          }
        : {}),
    },
    launchArgs: [
      folder,
      `--user-data-dir=${userData}`,
      "--disable-extensions",
      // Keeps test runs out of PostHog.
      "--disable-telemetry",
      // Otherwise VS Code reads the PATH back from the login shell.
      ...(suite === "cliNotFound" ? ["--force-disable-user-env"] : []),
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
