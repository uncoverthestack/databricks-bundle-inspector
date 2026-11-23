/** The `databricks-bundle-inspector` command: runs the CLI on this process. */

import { runCli } from "./main.js";

void runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  isTty: Boolean(process.stdout.isTTY),
}).then((code) => {
  // Not process.exit(): it can cut off output still being written to a pipe.
  process.exitCode = code;
});
