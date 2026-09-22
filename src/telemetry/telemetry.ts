import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { TELEMETRY_ENDPOINT } from "./config.js";
import { postBatch, type TelemetryProperties } from "./transport.js";
import { TelemetryQueue } from "./queue.js";
import { writeUninstallState } from "./uninstallState.js";

export interface Telemetry {
  logUsage(event: string, properties?: TelemetryProperties): void;
  /** Flushes pending events (bounded by the send timeout) and stops timers. */
  shutdown(): Promise<void>;
}

const QUEUE_STORAGE_KEY = "telemetry.queue";
const NOTICE_SHOWN_KEY = "telemetry.noticeShown";
const SETTING_SECTION = "databricksBundleInspector";
const SETTING_KEY = "telemetry.enabled";
const LEARN_MORE_URL =
  "https://github.com/uncoverthestack/databricks-bundle-inspector#telemetry";
const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_THRESHOLD = 20;

const noopTelemetry: Telemetry = {
  logUsage: () => {},
  shutdown: async () => {},
};

/**
 * Anonymous per-install ID. Re-hashing VS Code's machineId keeps it stable for
 * retention analysis while making it unlinkable to other extensions' telemetry.
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

/** Tells the user once that telemetry is on, with a one-click opt-out. */
async function showNoticeOnce(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(NOTICE_SHOWN_KEY)) return;
  await context.globalState.update(NOTICE_SHOWN_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    "Databricks Bundle Inspector collects anonymous usage data (features used, never paths, names or file contents) to guide development. It follows your VS Code telemetry setting.",
    "Learn More",
    "Disable",
  );
  if (choice === "Learn More") {
    void vscode.env.openExternal(vscode.Uri.parse(LEARN_MORE_URL));
  } else if (choice === "Disable") {
    await vscode.workspace
      .getConfiguration(SETTING_SECTION)
      .update(SETTING_KEY, false, vscode.ConfigurationTarget.Global);
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
  const queue = new TelemetryQueue(
    {
      get: () => context.globalState.get(QUEUE_STORAGE_KEY),
      set: (events) => context.globalState.update(QUEUE_STORAGE_KEY, events),
    },
    (events) => postBatch(events, { endpoint: TELEMETRY_ENDPOINT }),
  );

  const sender: vscode.TelemetrySender = {
    sendEventData(eventName, data) {
      const properties: TelemetryProperties = {};
      for (const [key, value] of Object.entries(data ?? {})) {
        if (key === "common.vscodemachineid") continue; // replaced by distinctId
        if (["string", "number", "boolean"].includes(typeof value)) {
          properties[key] = value as string | number | boolean;
        }
      }
      queue.enqueue({
        // TelemetryLogger prefixes names with the extension ID.
        event: eventName.slice(eventName.lastIndexOf("/") + 1),
        distinctId,
        timestamp: new Date().toISOString(),
        properties,
      });
      if (queue.size >= FLUSH_THRESHOLD) void queue.flush();
    },
    sendErrorData() {
      // Error telemetry (stack traces) is deliberately not collected.
    },
    flush: () => queue.flush(),
  };

  const logger = vscode.env.createTelemetryLogger(sender, {
    ignoreUnhandledErrors: true,
    additionalCommonProperties: { "common.appname": vscode.env.appName },
  });

  const isEnabled = () => logger.isUsageEnabled && extensionSettingEnabled();

  const recordConsent = () =>
    writeUninstallState(context.extensionPath, {
      enabled: isEnabled(),
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

  if (isEnabled()) {
    void showNoticeOnce(context);
    // Deliver anything left over from an earlier offline session.
    void queue.flush();
  }
  const timer = setInterval(() => {
    if (queue.size > 0 && isEnabled()) void queue.flush();
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    logUsage(event, properties) {
      if (extensionSettingEnabled()) logger.logUsage(event, properties);
    },
    async shutdown() {
      clearInterval(timer);
      for (const listener of consentListeners) listener.dispose();
      if (isEnabled()) await queue.flush();
      logger.dispose();
    },
  };
}
