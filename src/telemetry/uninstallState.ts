import { readFile, writeFile } from "node:fs/promises";
import path from "path";
import { UNINSTALL_STATE_FILE } from "./config.js";
import type { QueuedEvent, SendResult } from "./transport.js";

export interface UninstallState {
  enabled: boolean;
  distinctId: string;
  extensionVersion: string;
  appName: string;
}

export async function writeUninstallState(
  extensionDir: string,
  state: UninstallState,
): Promise<void> {
  try {
    await writeFile(path.join(extensionDir, UNINSTALL_STATE_FILE), JSON.stringify(state));
  } catch {
    // Read-only install folders simply mean no uninstall event is ever sent.
  }
}

export function parseUninstallState(raw: string): UninstallState | undefined {
  try {
    const value = JSON.parse(raw) as Partial<UninstallState>;
    if (
      typeof value.enabled !== "boolean" ||
      typeof value.distinctId !== "string" ||
      value.distinctId.length === 0
    ) {
      return undefined;
    }
    return {
      enabled: value.enabled,
      distinctId: value.distinctId,
      extensionVersion: typeof value.extensionVersion === "string" ? value.extensionVersion : "unknown",
      appName: typeof value.appName === "string" ? value.appName : "unknown",
    };
  } catch {
    return undefined;
  }
}

/**
 * Sends a single `extension_uninstalled` event, but only when the extension
 * last recorded that the user's VS Code telemetry setting allowed it.
 */
export async function runUninstallHook(
  extensionDir: string,
  send: (events: QueuedEvent[]) => Promise<SendResult>,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path.join(extensionDir, UNINSTALL_STATE_FILE), "utf8");
  } catch {
    return false;
  }
  const state = parseUninstallState(raw);
  if (!state?.enabled) return false;

  const result = await send([
    {
      event: "extension_uninstalled",
      distinctId: state.distinctId,
      timestamp: now().toISOString(),
      properties: {
        "common.extversion": state.extensionVersion,
        "common.appname": state.appName,
      },
    },
  ]);
  return result === "sent";
}
