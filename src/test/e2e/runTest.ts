/**
 * Runs the e2e suite inside a real VS Code with this extension loaded.
 * Build first with `npm run test:e2e`, which bundles this file to out/e2e.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main() {
  const root = path.resolve(__dirname, "../..");
  // Set in terminals inside VS Code; it would make the test VS Code start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // A fresh, short user data dir: macOS caps VS Code's socket path at 103 characters,
  // and a clean profile means no leftover cliPath setting.
  const userData = await mkdtemp(path.join(os.tmpdir(), "dbi-e2e-"));
  const suite = process.env.E2E_SUITE ?? "cliNotFound";
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out/e2e/suite/index.cjs"),
    // `npm run test:e2e:watch` sets this so each popup stays on screen long enough to read.
    // `E2E_SUITE` and `E2E_FIXTURE` pick another suite and the folder it opens; see `npm run test:e2e:include`.
    extensionTestsEnv: {
      E2E_PAUSE_MS: process.env.E2E_PAUSE_MS ?? "0",
      E2E_SUITE: suite,
      // The extension checks the open bundle as soon as VS Code starts. A real CLI found
      // then stays cached for the session, so this suite starts with none on the PATH.
      ...(suite === "cliNotFound"
        ? { PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin" }
        : {}),
    },
    launchArgs: [
      path.join(root, process.env.E2E_FIXTURE ?? "src/test/e2e/fixtures/bundle"),
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
