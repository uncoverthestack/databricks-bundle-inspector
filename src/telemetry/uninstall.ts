// Entry point for the `vscode:uninstall` hook. VS Code runs this with plain
// Node (no vscode API) after the extension is uninstalled and VS Code restarts.
import path from "path";
import { fileURLToPath } from "node:url";
import { TELEMETRY_ENDPOINT } from "./config.js";
import { postBatch } from "./transport.js";
import { runUninstallHook } from "./uninstallState.js";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await runUninstallHook(extensionDir, (events) =>
  postBatch(events, { endpoint: TELEMETRY_ENDPOINT }),
).catch(() => false);
