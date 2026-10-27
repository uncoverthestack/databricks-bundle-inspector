import * as vscode from "vscode";
import { createHash } from "node:crypto";
import os from "node:os";
import { TELEMETRY_ENDPOINT } from "./config.js";
import { postBatch, type TelemetryProperties } from "./transport.js";
import { outgoingProperties } from "./schema.js";
import { TelemetryQueue } from "./queue.js";
import { writeUninstallState } from "./uninstallState.js";

export interface Telemetry {
  logUsage(event: string, properties?: TelemetryProperties): void;
  /** Whether usage data may be collected now: VS Code's setting and the extension's both allow it. */
  isEnabled(): boolean;
  /** Flushes pending events (bounded by the send timeout) and stops timers. */
  shutdown(): Promise<void>;
}

const QUEUE_STORAGE_KEY = "telemetry.queue";
// Set by releases up to 0.2.2 as the notice was requested, before it was on screen.
const LEGACY_NOTICE_SHOWN_KEY = "telemetry.noticeShown";
// The start of VS Code in which the user closed or answered the notice.
const NOTICE_ACKNOWLEDGED_KEY = "telemetry.noticeAcknowledgedIn";
const SETTING_SECTION = "databricksBundleInspector";
const SETTING_KEY = "telemetry.enabled";
const LEARN_MORE_URL =
  "https://github.com/uncoverthestack/databricks-bundle-inspector#telemetry";
const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_THRESHOLD = 20;

const noopTelemetry: Telemetry = {
  logUsage: () => {},
  isEnabled: () => false,
  shutdown: async () => {},
};

/**
 * Pseudonymous per-install ID: it names no one, but links one install's events.
 * Re-hashing VS Code's machineId keeps it stable for retention analysis while
 * making it unlinkable to other extensions' telemetry.
 */
function anonymousId(): string {
  return createHash("sha256")
    .update(`databricks-bundle-inspector:${vscode.env.machineId}`)
    .digest("hex")
    .slice(0, 32);
}

/** The extension's own opt-out. It can only restrict VS Code's setting, never override it. */
function extensionSettingEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(SETTING_SECTION)
    .get<boolean>(SETTING_KEY, true);
}

/**
 * The VS Code start in which the user closed or answered the notice, or undefined if
 * they have not yet. A notice from a release up to 0.2.2 counts as an earlier start.
 */
function noticeAcknowledgedIn(context: vscode.ExtensionContext): string | undefined {
  return (
    context.globalState.get<string>(NOTICE_ACKNOWLEDGED_KEY) ??
    (context.globalState.get<boolean>(LEGACY_NOTICE_SHOWN_KEY) === true ? "earlier" : undefined)
  );
}

/**
 * Tells the user about telemetry, with a one-click opt-out. It comes back on each start
 * of VS Code until the user closes or answers it, so a notice that never reached the
 * screen (VS Code closed, Do Not Disturb) is never taken as seen.
 */
async function showNotice(
  context: vscode.ExtensionContext,
  thisStart: string,
  onAcknowledged: () => void,
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Databricks Bundle Inspector collects usage data (features used, never paths, names or file contents) to guide development. Nothing is sent until VS Code is next opened, so you have time to turn it off.",
    "Learn More",
    "Disable",
  );
  if (choice === "Disable") {
    await vscode.workspace
      .getConfiguration(SETTING_SECTION)
      .update(SETTING_KEY, false, vscode.ConfigurationTarget.Global);
    return;
  }
  await context.globalState.update(NOTICE_ACKNOWLEDGED_KEY, thisStart);
  onAcknowledged();
  if (choice === "Learn More") {
    void vscode.env.openExternal(vscode.Uri.parse(LEARN_MORE_URL));
  }
}

/**
 * Usage telemetry built on VS Code's TelemetryLogger: nothing is sent unless
 * the user's `telemetry.telemetryLevel` allows usage data and
 * `databricksBundleInspector.telemetry.enabled` is on. VS Code strips paths
 * and other PII from property values before they reach the sender.
 */
export function createTelemetry(context: vscode.ExtensionContext): Telemetry {
  if (!TELEMETRY_ENDPOINT || context.extensionMode !== vscode.ExtensionMode.Production) {
    return noopTelemetry;
  }

  const distinctId = anonymousId();
  // This VS Code session: one per window, kept when the window reloads. Events are
  // only sent from a later one.
  const thisStart = vscode.env.sessionId;
  const queue = new TelemetryQueue(
    {
      get: () => context.globalState.get(QUEUE_STORAGE_KEY),
      set: (events) => context.globalState.update(QUEUE_STORAGE_KEY, events),
    },
    (events) => postBatch(events, { endpoint: TELEMETRY_ENDPOINT }),
  );

  const sender: vscode.TelemetrySender = {
    sendEventData(eventName, data) {
      const properties = outgoingProperties(data);
      queue.enqueue({
        // TelemetryLogger prefixes names with the extension ID.
        event: eventName.slice(eventName.lastIndexOf("/") + 1),
        distinctId,
        timestamp: new Date().toISOString(),
        properties,
      });
      if (queue.size >= FLUSH_THRESHOLD) void send();
    },
    sendErrorData() {
      // Error telemetry (stack traces) is deliberately not collected.
    },
    flush: () => send(),
  };

  const logger = vscode.env.createTelemetryLogger(sender, {
    ignoreUnhandledErrors: true,
    // VS Code does not give extensions the OS or CPU type, so add them. Never the hostname.
    additionalCommonProperties: {
      "common.appname": vscode.env.appName,
      "common.os": process.platform,
      "common.platformversion": os.release(),
      "common.arch": process.arch,
    },
  });

  const isEnabled = () => logger.isUsageEnabled && extensionSettingEnabled();
  // Turned off while VS Code was closed: what an earlier start queued is deleted now, as
  // turning it off while running does, so it is never sent if telemetry is turned on again.
  if (!isEnabled()) queue.clear();

  // Until then, events wait on this machine (bounded by the queue's size and age limits).
  function sendingAllowed(): boolean {
    const acknowledgedIn = noticeAcknowledgedIn(context);
    return isEnabled() && acknowledgedIn !== undefined && acknowledgedIn !== thisStart;
  }
  function send(): Promise<void> {
    return sendingAllowed() ? queue.flush() : Promise.resolve();
  }

  // The uninstall event stays off until the user has closed or answered the notice.
  const recordConsent = () =>
    writeUninstallState(context.extensionPath, {
      enabled: isEnabled() && noticeAcknowledgedIn(context) !== undefined,
      distinctId,
      extensionVersion: String(context.extension.packageJSON.version ?? "unknown"),
      appName: vscode.env.appName,
    });

  const onConsentChanged = () => {
    if (!isEnabled()) queue.clear();
    void recordConsent();
  };

  void recordConsent();
  const consentListeners = [
    logger.onDidChangeEnableStates(onConsentChanged),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTING_SECTION}.${SETTING_KEY}`)) onConsentChanged();
    }),
  ];

  // Deliver anything left over from an earlier start.
  void send();
  let noticeRequested = false;
  const timer = setInterval(() => {
    if (queue.size > 0) void send();
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    logUsage(event, properties) {
      if (!extensionSettingEnabled()) return;
      // Shown with the first event. Nothing is sent before it is closed or answered.
      if (logger.isUsageEnabled && !noticeRequested && noticeAcknowledgedIn(context) === undefined) {
        noticeRequested = true;
        void showNotice(context, thisStart, () => void recordConsent());
      }
      logger.logUsage(event, properties);
    },
    isEnabled,
    async shutdown() {
      clearInterval(timer);
      for (const listener of consentListeners) listener.dispose();
      await send();
      logger.dispose();
    },
  };
}
