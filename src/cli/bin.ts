/** The `databricks-bundle-inspector` command: runs the CLI on this process. */

import { runCli } from "./main.js";

// A reader that stops early, such as `| head`, closes the pipe: the rest of the report has
// nowhere to go. Stop quietly as other command-line tools do, rather than crash on EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

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
