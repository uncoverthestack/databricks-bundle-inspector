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
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out/e2e/suite/index.cjs"),
    // `npm run test:e2e:watch` sets this so each popup stays on screen long enough to read.
    extensionTestsEnv: { E2E_PAUSE_MS: process.env.E2E_PAUSE_MS ?? "0" },
    launchArgs: [
      path.join(root, "src/test/e2e/fixtures/bundle"),
      `--user-data-dir=${userData}`,
      "--disable-extensions",
      // Keeps test runs out of PostHog.
      "--disable-telemetry",
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
