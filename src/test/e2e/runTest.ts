import { execFileSync } from "node:child_process";
/**
 * Runs the e2e suite inside a real VS Code with this extension loaded.
 * Build first with `npm run test:e2e`, which bundles this file to out/e2e.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { readOptions } from "./options.js";
import { runTests } from "@vscode/test-electron";
import { folderIgnoresCase, swapLetterCase } from "../../bundle/pathCase.js";


/** The `databricks` on this process's PATH, as `{ E2E_REAL_CLI }`, or nothing when there is none. */
function realDatabricksCli(): { E2E_REAL_CLI?: string } {
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["databricks"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    // `where` lists every match, including extensionless files; Windows runs the .exe.
    const cli = found.find((file) => /\.exe$/i.test(file)) ?? found[0];
    return cli ? { E2E_REAL_CLI: cli } : {};
  } catch {
    return {};
  }
}

async function main() {
  const options = readOptions(process.argv.slice(2), process.env);
  const root = path.resolve(__dirname, "../..");
  // Set in terminals inside VS Code; it would make the test VS Code start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // A fresh, short user data dir: macOS caps VS Code's socket path at 103 characters,
  // and a clean profile means no leftover cliPath setting.
  const userData = await mkdtemp(path.join(os.tmpdir(), "dbi-e2e-"));
  const suite = options.suite;
  // Only the suites that read the rendered graph need Chromium's loopback debugging interface.
  let debuggingPort: number | undefined;
  if (suite === "graphRefresh" || suite === "themes") {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    debuggingPort = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  let folder = path.join(root, options.fixture);
  // `--folder-case other` opens the folder under another letter case, as happens when
  // someone types a path by hand. That path only exists where the file system ignores case.
  if (options.folderCase === "other") {
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
    // Runner arguments pick the suite and fixture; legacy E2E_* variables also work.
    extensionTestsEnv: {
      E2E_PAUSE_MS: options.pauseMs,
      E2E_SUITE: suite,
      ...(debuggingPort ? { E2E_CDP_PORT: String(debuggingPort) } : {}),
      // A ~/.databrickscfg profile for the cases that need a login (see the targets fixture).
      ...(options.profile
        ? { INSPECTOR_TEST_PROFILE: options.profile }
        : {}),
      // The extension checks the open bundle as soon as VS Code starts. A real CLI found
      // then stays cached for the session, so this suite starts with none on the PATH.
      ...(suite === "cliNotFound"
        ? {
            // Real programs for the Windows cases, which can't run the suite's #!/bin/sh fakes:
            // the Databricks CLI found before the PATH below replaces it, and this Node.js.
            ...realDatabricksCli(),
            E2E_NODE: process.execPath,
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
      ...(debuggingPort ? [`--remote-debugging-port=${debuggingPort}`] : []),
      // Otherwise VS Code reads the PATH back from the login shell.
      ...(suite === "cliNotFound" ? ["--force-disable-user-env"] : []),
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
