import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { createTelemetry } from "../../../telemetry/telemetry.js";

// The promise in docs/telemetry.md: nothing is sent until the user has closed or
// answered the notice, and nothing from the start of VS Code in which they did.

type Choice = "Learn More" | "Disable" | undefined;

const mock = vscode as unknown as {
  window: { showInformationMessage: (...args: unknown[]) => Promise<Choice> };
  workspace: {
    getConfiguration: () => unknown;
    onDidChangeConfiguration: (listener: (event: unknown) => void) => { dispose(): void };
  };
  env: { sessionId: string; createTelemetryLogger: (sender: vscode.TelemetrySender) => unknown };
};

let settings: Map<string, unknown>;
let configListeners: ((event: unknown) => void)[];
let notices: { answer: (choice: Choice) => Promise<void> }[];
let sentBodies: { batch: { event: string }[] }[];

beforeEach(() => {
  settings = new Map();
  configListeners = [];
  notices = [];
  sentBodies = [];
  mock.workspace.getConfiguration = () => ({
    get: (key: string, fallback?: unknown) => (settings.has(key) ? settings.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      settings.set(key, value);
      for (const listener of configListeners) {
        listener({ affectsConfiguration: (name: string) => name === `databricksBundleInspector.${key}` });
      }
    },
  });
  mock.workspace.onDidChangeConfiguration = (listener) => {
    configListeners.push(listener);
    return { dispose: () => {} };
  };
  mock.window.showInformationMessage = () =>
    new Promise<Choice>((resolve) => {
      notices.push({
        answer: async (choice) => {
          resolve(choice);
          // Let the notice handler save its answer.
          await new Promise((done) => setTimeout(done, 0));
        },
      });
    });
  mock.env.createTelemetryLogger = (sender) => ({
    isUsageEnabled: true,
    logUsage: (event: string, data?: Record<string, unknown>) =>
      sender.sendEventData(`publisher.extension/${event}`, data),
    onDidChangeEnableStates: () => ({ dispose: () => {} }),
    dispose: () => {},
  });
  jest.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** One install's stored state, shared by every start of VS Code. */
async function install(state = new Map<string, unknown>()) {
  const extensionPath = await mkdtemp(path.join(os.tmpdir(), "telemetry-consent-"));
  let sessions = 0;
  const activate = () =>
    createTelemetry({
      extensionMode: vscode.ExtensionMode.Production,
      extensionPath,
      extension: { packageJSON: { version: "test" } },
      globalState: {
        get: (key: string) => state.get(key),
        update: async (key: string, value: unknown) => void state.set(key, value),
      },
    } as unknown as vscode.ExtensionContext);
  return {
    state,
    /** A new VS Code session: a new window, or VS Code opened again. */
    start: () => {
      mock.env.sessionId = `session-${++sessions}`;
      return activate();
    },
    /** The window reloads: the extension starts again in the same session. */
    reload: () => activate(),
  };
}

const sentEvents = () => sentBodies.flatMap((body) => body.batch.map((e) => e.event));

describe("telemetry consent", () => {
  it("deletes events queued by an earlier start when telemetry was turned off while VS Code was closed", async () => {
    const { start, state } = await install();
    const first = start();
    first.logUsage("extension_activated");
    await notices[0]!.answer(undefined);
    first.logUsage("inspect_bundle");
    // VS Code closes before the next start could send them.
    expect(state.get("telemetry.queue")).toHaveLength(2);

    // Turned off in settings.json while VS Code was closed, then on again later.
    settings.set("telemetry.enabled", false);
    const off = start();
    await off.shutdown();
    settings.set("telemetry.enabled", true);
    const on = start();
    await on.shutdown();

    expect(sentEvents()).toEqual([]);
  });

  it("sends nothing while the notice is unanswered, even when VS Code closes", async () => {
    const { start } = await install();
    const telemetry = start();

    telemetry.logUsage("extension_activated");
    await telemetry.shutdown();

    expect(notices).toHaveLength(1);
    expect(sentEvents()).toEqual([]);
  });

  it("sends nothing from the start in which the notice was closed", async () => {
    const { start } = await install();
    const telemetry = start();

    telemetry.logUsage("extension_activated");
    await notices[0]!.answer(undefined);
    telemetry.logUsage("inspect_bundle");
    await telemetry.shutdown();

    expect(sentEvents()).toEqual([]);
  });

  it("sends the waiting events from the next start, without showing the notice again", async () => {
    const { start } = await install();
    const first = start();
    first.logUsage("extension_activated");
    await notices[0]!.answer(undefined);
    await first.shutdown();

    const second = start();
    second.logUsage("inspect_bundle");
    await second.shutdown();

    expect(notices).toHaveLength(1);
    expect(sentEvents()).toEqual(["extension_activated", "inspect_bundle"]);
  });

  it("sends nothing after a window reload in the session where the notice was closed", async () => {
    const { start, reload } = await install();
    const first = start();
    first.logUsage("extension_activated");
    await notices[0]!.answer(undefined);
    await first.shutdown();

    const reloaded = reload();
    reloaded.logUsage("extension_activated");
    await reloaded.shutdown();

    expect(notices).toHaveLength(1);
    expect(sentEvents()).toEqual([]);
  });

  it("counts Learn More as an answer", async () => {
    const { start } = await install();
    const first = start();
    first.logUsage("extension_activated");
    await notices[0]!.answer("Learn More");
    await first.shutdown();

    await start().shutdown();

    expect(sentEvents()).toEqual(["extension_activated"]);
  });

  it("shows the notice again in the next start when it was never answered, and sends nothing", async () => {
    const { start } = await install();
    const first = start();
    first.logUsage("extension_activated");
    await first.shutdown();

    const second = start();
    second.logUsage("extension_activated");
    await second.shutdown();

    expect(notices).toHaveLength(2);
    expect(sentEvents()).toEqual([]);
  });

  it("Disable deletes the waiting events, and later starts send nothing", async () => {
    const { start, state } = await install();
    const first = start();
    first.logUsage("extension_activated");
    await notices[0]!.answer("Disable");
    await first.shutdown();

    const second = start();
    second.logUsage("inspect_bundle");
    await second.shutdown();

    expect(settings.get("telemetry.enabled")).toBe(false);
    expect(state.get("telemetry.queue")).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(sentEvents()).toEqual([]);
  });

  it("keeps sending for installs that got the notice from a release up to 0.2.2", async () => {
    const { start } = await install(new Map([["telemetry.noticeShown", true]]));
    const telemetry = start();

    telemetry.logUsage("extension_activated");
    await telemetry.shutdown();

    expect(notices).toHaveLength(0);
    expect(sentEvents()).toEqual(["extension_activated"]);
  });
});
