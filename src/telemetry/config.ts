/**
 * URL of the telemetry proxy deployed from telemetry-proxy/, ending in `/e`.
 * The proxy holds the PostHog key; the extension never sees it. Telemetry is
 * a no-op while this is empty.
 */
export const TELEMETRY_ENDPOINT =
  "https://databricks-bundle-inspector-telemetry.bold-breeze-dc2a.workers.dev/e";

/**
 * Written into the extension's install folder so the `vscode:uninstall` hook,
 * which runs without the VS Code API, knows whether the user allowed telemetry.
 */
export const UNINSTALL_STATE_FILE = ".telemetry-state.json";
