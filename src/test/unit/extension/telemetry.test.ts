import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "path";
import { describe, expect, it, jest, beforeEach, afterEach } from "@jest/globals";
import {
  countBucket,
  fileKind,
  parseWebviewTelemetryMessage,
  taskKinds,
} from "../../../telemetry/events.js";
import {
  postBatch,
  toWireBatch,
  type FetchLike,
  type QueuedEvent,
  type SendResult,
} from "../../../telemetry/transport.js";
import { EVENT_SCHEMA, validateWireEvent } from "../../../telemetry/schema.js";
import { handleTelemetryRequest, type ProxyEnv } from "../../../telemetry/proxy.js";
import { TelemetryQueue, type QueueStorage } from "../../../telemetry/queue.js";
import { UNINSTALL_STATE_FILE } from "../../../telemetry/config.js";
import {
  parseUninstallState,
  runUninstallHook,
  writeUninstallState,
} from "../../../telemetry/uninstallState.js";

type Send = (events: QueuedEvent[]) => Promise<SendResult>;

const NOW = Date.parse("2026-09-22T12:00:00Z");

function makeEvent(event: string, timestamp = new Date(NOW).toISOString()): QueuedEvent {
  return { event, distinctId: "install-1", timestamp, properties: {} };
}

function memoryStorage(initial?: QueuedEvent[]): QueueStorage & { saved: QueuedEvent[] | undefined } {
  const storage = {
    saved: initial,
    get: () => storage.saved,
    set: (events: QueuedEvent[]) => {
      storage.saved = events;
    },
  };
  return storage;
}

describe("TelemetryQueue", () => {
  it("keeps events while offline and delivers them once the network is back", async () => {
    const storage = memoryStorage();
    let online = false;
    const delivered: string[] = [];
    const queue = new TelemetryQueue(
      storage,
      async (batch: QueuedEvent[]) => {
        if (!online) return "retry";
        delivered.push(...batch.map((e) => e.event));
        return "sent";
      },
      { now: () => NOW },
    );

    queue.enqueue(makeEvent("a"));
    queue.enqueue(makeEvent("b"));
    await queue.flush();
    expect(queue.size).toBe(2);
    expect(storage.saved?.map((e) => e.event)).toEqual(["a", "b"]);

    online = true;
    await queue.flush();
    expect(delivered).toEqual(["a", "b"]);
    expect(queue.size).toBe(0);
    expect(storage.saved).toEqual([]);
  });

  it("restores persisted events from a previous session", async () => {
    const send = jest.fn<Send>(async () => "sent");
    const queue = new TelemetryQueue(memoryStorage([makeEvent("old")]), send, { now: () => NOW });
    expect(queue.size).toBe(1);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops events older than maxAge and caps queue length", () => {
    const stale = makeEvent("stale", new Date(NOW - 15 * 24 * 60 * 60 * 1000).toISOString());
    const queue = new TelemetryQueue(memoryStorage([stale]), async () => "sent", {
      now: () => NOW,
      maxEvents: 2,
    });
    expect(queue.size).toBe(0);

    queue.enqueue(makeEvent("1"));
    queue.enqueue(makeEvent("2"));
    queue.enqueue(makeEvent("3"));
    expect(queue.size).toBe(2);
  });

  it("sends in batches and discards batches PostHog rejects", async () => {
    const batches: string[][] = [];
    const queue = new TelemetryQueue(
      memoryStorage(),
      async (batch: QueuedEvent[]) => {
        batches.push(batch.map((e) => e.event));
        return batches.length === 1 ? "drop" : "sent";
      },
      { now: () => NOW, batchSize: 2 },
    );
    for (const name of ["a", "b", "c"]) queue.enqueue(makeEvent(name));
    await queue.flush();
    expect(batches).toEqual([["a", "b"], ["c"]]);
    expect(queue.size).toBe(0);
  });

  it("keeps events enqueued while a flush is in flight", async () => {
    let release: () => void = () => {};
    const queue = new TelemetryQueue(
      memoryStorage(),
      (batch: QueuedEvent[]) =>
        batch[0]?.event === "first"
          ? new Promise<SendResult>((resolve) => {
              release = () => resolve("sent");
            })
          : Promise.resolve("retry"),
      { now: () => NOW },
    );
    queue.enqueue(makeEvent("first"));
    const flushing = queue.flush();
    queue.enqueue(makeEvent("second"));
    release();
    await flushing;
    expect(queue.size).toBe(1);
  });

  it("clear empties memory and storage", () => {
    const storage = memoryStorage();
    const queue = new TelemetryQueue(storage, async () => "sent", { now: () => NOW });
    queue.enqueue(makeEvent("a"));
    queue.clear();
    expect(queue.size).toBe(0);
    expect(storage.saved).toEqual([]);
  });
});

describe("postBatch", () => {
  const options = { endpoint: "https://proxy.test/e" };

  it.each([
    [200, "sent"],
    [400, "drop"],
    [429, "retry"],
    [503, "retry"],
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    const fetchImpl = jest.fn<FetchLike>(async () => ({ status }));
    await expect(postBatch([makeEvent("a")], { ...options, fetchImpl })).resolves.toBe(expected);
    expect(fetchImpl).toHaveBeenCalledWith("https://proxy.test/e", expect.anything());
  });

  it("treats network failures as retryable", async () => {
    const fetchImpl = jest.fn<FetchLike>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(postBatch([makeEvent("a")], { ...options, fetchImpl })).resolves.toBe("retry");
  });

  it("never calls the network without an endpoint", async () => {
    const fetchImpl = jest.fn<FetchLike>(async () => ({ status: 200 }));
    await expect(postBatch([makeEvent("a")], { endpoint: "", fetchImpl })).resolves.toBe("drop");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the wire format with no credentials", () => {
    const body = JSON.stringify(toWireBatch([makeEvent("a")]));
    expect(JSON.parse(body)).toEqual({
      batch: [{ event: "a", distinct_id: "install-1", timestamp: new Date(NOW).toISOString(), properties: {} }],
    });
    expect(body).not.toMatch(/api_key|phc_/);
  });
});

describe("event helpers", () => {
  it("accepts only allow-listed webview events and properties", () => {
    expect(
      parseWebviewTelemetryMessage({
        type: "telemetry",
        event: "graph_mode_changed",
        properties: { mode: "issues", path: "/Users/me/secret" },
      }),
    ).toEqual({ event: "graph_mode_changed", properties: { mode: "issues" } });
    expect(parseWebviewTelemetryMessage({ event: "made_up" })).toBeUndefined();
    expect(parseWebviewTelemetryMessage({ event: "toString" })).toBeUndefined();
  });

  it("rejects webview property values outside the schema", () => {
    expect(
      parseWebviewTelemetryMessage({ event: "graph_mode_changed", properties: { mode: "/Users/me/x.py" } }),
    ).toEqual({ event: "graph_mode_changed", properties: {} });
  });

  it("buckets counts", () => {
    expect([0, 1, 3, 20, 21, 99].map(countBucket)).toEqual(["0", "1", "2-5", "6-20", "21-50", "51+"]);
  });

  it("reduces file paths to a coarse kind", () => {
    expect(fileKind("/w/src/job.PY")).toBe("py");
    expect(fileKind("/w/databricks.yaml")).toBe("yml");
    expect(fileKind("/w/secret-customer-name.txt")).toBe("other");
  });

  it("collects distinct Databricks task type keys", () => {
    expect(
      taskKinds([
        { nodeType: "task", data: { task_key: "load_customers", notebook_task: {} } },
        { nodeType: "task", data: { task_key: "b", sql_task: {}, depends_on: [] } },
        { nodeType: "task", data: { task_key: "c", notebook_task: {} } },
        { nodeType: "job", data: { name: "nightly" } },
      ]),
    ).toBe("notebook_task,sql_task");
  });
});

describe("uninstall hook", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dbi-telemetry-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const state = {
    enabled: true,
    distinctId: "install-1",
    extensionVersion: "0.1.3",
    appName: "Visual Studio Code",
  };

  it("sends one uninstall event when telemetry was enabled", async () => {
    await writeUninstallState(dir, state);
    const send = jest.fn<Send>(async () => "sent");
    await expect(runUninstallHook(dir, send, () => new Date(NOW))).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith([
      {
        event: "extension_uninstalled",
        distinctId: "install-1",
        timestamp: new Date(NOW).toISOString(),
        properties: { "common.extversion": "0.1.3", "common.appname": "Visual Studio Code" },
      },
    ]);
  });

  it("sends nothing when the user had telemetry off", async () => {
    await writeUninstallState(dir, { ...state, enabled: false });
    const send = jest.fn<Send>(async () => "sent");
    await expect(runUninstallHook(dir, send)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing when no consent file exists or it is corrupt", async () => {
    const send = jest.fn<Send>(async () => "sent");
    await expect(runUninstallHook(dir, send)).resolves.toBe(false);
    await writeFile(path.join(dir, UNINSTALL_STATE_FILE), "{not json");
    await expect(runUninstallHook(dir, send)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("round-trips the consent file", async () => {
    await writeUninstallState(dir, state);
    const raw = await readFile(path.join(dir, UNINSTALL_STATE_FILE), "utf8");
    expect(parseUninstallState(raw)).toEqual(state);
  });

  it("ignores write failures", async () => {
    await expect(writeUninstallState(path.join(dir, "missing", "deeper"), state)).resolves.toBeUndefined();
  });
});

const ID = "3f9c1a7e2b8d4c6f0a1e5d9b7c2f4a8e";

function wireEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: "inspect_bundle",
    distinct_id: ID,
    timestamp: new Date(NOW).toISOString(),
    properties: { outcome: "ok", task_count: "6-20", duration_ms: 1200, "common.extversion": "0.1.3" },
    ...overrides,
  };
}

describe("schema", () => {
  it("keeps valid properties and drops everything else", () => {
    const event = validateWireEvent(
      wireEvent({
        properties: {
          outcome: "ok",
          task_count: "7",
          duration_ms: -1,
          job_name: "nightly_customers",
          "common.appname": "Visual Studio Code",
          "common.vscodemachineid": "abc",
          "common.os": "<script>",
        },
      }),
      NOW,
    );
    expect(event?.properties).toEqual({ outcome: "ok", "common.appname": "Visual Studio Code" });
  });

  it.each([
    ["unknown event", { event: "made_up" }],
    ["prototype key as event", { event: "constructor" }],
    ["malformed distinct_id", { distinct_id: "someone@example.com" }],
    ["timestamp too old", { timestamp: new Date(NOW - 16 * 24 * 60 * 60 * 1000).toISOString() }],
    ["timestamp in the future", { timestamp: new Date(NOW + 2 * 24 * 60 * 60 * 1000).toISOString() }],
    ["unparseable timestamp", { timestamp: "yesterday" }],
  ])("rejects %s", (_name, overrides) => {
    expect(validateWireEvent(wireEvent(overrides), NOW)).toBeUndefined();
  });

  it("matches telemetry.json exactly", async () => {
    const documented = JSON.parse(
      await readFile(path.join(__dirname, "../../../../telemetry.json"), "utf8"),
    ) as { events: Record<string, { properties?: Record<string, string> }> };
    const documentedShape = Object.fromEntries(
      Object.entries(documented.events).map(([name, e]) => [name, Object.keys(e.properties ?? {}).sort()]),
    );
    const schemaShape = Object.fromEntries(
      Object.entries(EVENT_SCHEMA).map(([name, rules]) => [name, Object.keys(rules).sort()]),
    );
    expect(documentedShape).toEqual(schemaShape);
  });
});

describe("telemetry proxy", () => {
  const env: ProxyEnv = { POSTHOG_API_KEY: "phc_secret", POSTHOG_HOST: "https://posthog.test" };

  function post(body: unknown, init: { path?: string; method?: string; headers?: Record<string, string> } = {}) {
    return new Request(`https://proxy.test${init.path ?? "/e"}`, {
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      ...(init.method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  }

  function okFetch() {
    return jest.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  }

  it("forwards valid events to PostHog with the secret key and anonymity flags", async () => {
    const fetchImpl = okFetch();
    const response = await handleTelemetryRequest(post({ batch: [wireEvent()] }), env, fetchImpl, NOW);
    expect(response.status).toBe(204);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://posthog.test/batch/");
    const sent = JSON.parse(String(init?.body));
    expect(sent.api_key).toBe("phc_secret");
    expect(sent.batch).toHaveLength(1);
    expect(sent.batch[0].properties).toMatchObject({
      outcome: "ok",
      $process_person_profile: false,
      $geoip_disable: true,
      $ip: null,
    });
  });

  it("forwards only the valid events of a mixed batch", async () => {
    const fetchImpl = okFetch();
    await handleTelemetryRequest(post({ batch: [wireEvent(), wireEvent({ event: "spam" })] }), env, fetchImpl, NOW);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).batch).toHaveLength(1);
  });

  it("accepts but does not forward a batch with no valid events", async () => {
    const fetchImpl = okFetch();
    const response = await handleTelemetryRequest(post({ batch: [wireEvent({ event: "spam" })] }), env, fetchImpl, NOW);
    expect(response.status).toBe(204);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong path", post({ batch: [] }, { path: "/batch" }), 404],
    ["wrong method", post(null, { method: "GET" }), 405],
    ["invalid JSON", post("{nope"), 400],
    ["empty batch", post({ batch: [] }), 400],
    ["oversized batch", post({ batch: Array.from({ length: 51 }, () => wireEvent()) }), 400],
    ["oversized body", post({ batch: [wireEvent({ pad: "x".repeat(70_000) })] }), 413],
  ])("rejects %s", async (_name, request, status) => {
    const fetchImpl = okFetch();
    expect((await handleTelemetryRequest(request, env, fetchImpl, NOW)).status).toBe(status);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rate limits per client IP", async () => {
    const limit = jest.fn(async (_options: { key: string }) => ({ success: false }));
    const fetchImpl = okFetch();
    const response = await handleTelemetryRequest(
      post({ batch: [wireEvent()] }, { headers: { "cf-connecting-ip": "203.0.113.9" } }),
      { ...env, RATE_LIMITER: { limit } },
      fetchImpl,
      NOW,
    );
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks the extension to retry when PostHog is unavailable or the key is missing", async () => {
    const down = jest.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    expect((await handleTelemetryRequest(post({ batch: [wireEvent()] }), env, down, NOW)).status).toBe(502);
    const offline = jest.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await handleTelemetryRequest(post({ batch: [wireEvent()] }), env, offline, NOW)).status).toBe(502);
    expect(
      (await handleTelemetryRequest(post({ batch: [wireEvent()] }), { ...env, POSTHOG_API_KEY: "" }, okFetch(), NOW)).status,
    ).toBe(503);
  });
});
