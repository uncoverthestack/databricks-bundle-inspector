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
import {
  COMMON_KEYS,
  EVENT_SCHEMA,
  outgoingProperties,
  validateProperties,
  validateWireEvent,
} from "../../../telemetry/schema.js";
import { handleTelemetryRequest, type ProxyEnv } from "../../../telemetry/proxy.js";
import { MAX_BATCH_BYTES, TelemetryQueue, type QueueStorage } from "../../../telemetry/queue.js";
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
  // #322: by size as well as count, so a genuine batch never reaches the proxy's 64 KB limit.
  it("sends a big queue in requests of at most 32 KB, every event whole and in order", async () => {
    const sent: QueuedEvent[][] = [];
    const queue = new TelemetryQueue(memoryStorage(), async (batch) => {
      sent.push(batch);
      return "sent";
    }, { now: () => NOW });
    // 120 events of about 1.3 KB: fewer than 50 fit in 32 KB.
    for (let i = 0; i < 120; i++) queue.enqueue({ ...makeEvent(`e${i}`), properties: { task_kinds: "x".repeat(1200) } });
    await queue.flush();
    expect(sent.length).toBeGreaterThan(3);
    for (const batch of sent) {
      expect(Buffer.byteLength(JSON.stringify(toWireBatch(batch)))).toBeLessThanOrEqual(MAX_BATCH_BYTES + 1024);
    }
    expect(sent.flat().map((e) => e.event)).toEqual(Array.from({ length: 120 }, (_, i) => `e${i}`));
    expect(sent.flat().every((e) => e.properties.task_kinds === "x".repeat(1200))).toBe(true);
    expect(queue.size).toBe(0);
  });

  it("still sends at most 50 small events per request", async () => {
    const sizes: number[] = [];
    const queue = new TelemetryQueue(memoryStorage(), async (batch) => {
      sizes.push(batch.length);
      return "sent";
    }, { now: () => NOW });
    for (let i = 0; i < 120; i++) queue.enqueue(makeEvent(`e${i}`));
    await queue.flush();
    expect(sizes).toEqual([50, 50, 20]);
  });

  it("sends an event bigger than the budget on its own, never holding up the rest", async () => {
    const sent: string[][] = [];
    const queue = new TelemetryQueue(memoryStorage(), async (batch) => {
      sent.push(batch.map((e) => e.event));
      return "sent";
    }, { now: () => NOW, maxBatchBytes: 1000 });
    queue.enqueue(makeEvent("a"));
    queue.enqueue({ ...makeEvent("huge"), properties: { blob: "x".repeat(5000) } });
    queue.enqueue(makeEvent("b"));
    await queue.flush();
    expect(sent).toEqual([["a"], ["huge"], ["b"]]);
  });

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

  it("drops events past the age limit when sending, in a window open for weeks", async () => {
    let now = NOW;
    const delivered: string[] = [];
    const queue = new TelemetryQueue(
      memoryStorage(),
      async (batch: QueuedEvent[]) => {
        delivered.push(...batch.map((e) => e.event));
        return "sent";
      },
      { now: () => now },
    );
    queue.enqueue(makeEvent("old", new Date(NOW).toISOString()));
    // 14 days and an hour later, without the queue loading or growing in between.
    now = NOW + 14 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
    await queue.flush();
    expect(delivered).toEqual([]);
    expect(queue.size).toBe(0);
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

  it("sends events enqueued while a flush of an empty queue is finishing", async () => {
    const sent: string[] = [];
    const queue = new TelemetryQueue(
      memoryStorage(),
      async (batch: QueuedEvent[]) => {
        sent.push(...batch.map((e) => e.event));
        return "sent";
      },
      { now: () => NOW },
    );
    void queue.flush();
    queue.enqueue(makeEvent("late"));
    await queue.flush();
    expect(sent).toEqual(["late"]);
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
          "common.sqmid": "{6f2b8c1e-0000-4000-8000-000000000000}",
          "common.devDeviceId": "abc",
          "common.somethingnew": "x",
          "common.os": "<script>",
        },
      }),
      NOW,
    );
    expect(event?.properties).toEqual({ outcome: "ok", "common.appname": "Visual Studio Code" });
  });

  it("keeps the start event's coarse facts and nothing that could name a project", () => {
    const event = validateWireEvent(
      wireEvent({
        event: "extension_activated",
        properties: {
          bundle_count: "2-5",
          bundle_at_root: true,
          cli_found: false,
          issue_count: "6-20",
          bundle_root: "/Users/someone/work/sales_etl",
        },
      }),
      NOW,
    );
    expect(event?.properties).toEqual({
      bundle_count: "2-5",
      bundle_at_root: true,
      cli_found: false,
      issue_count: "6-20",
    });
    expect(validateProperties("extension_activated", { bundle_count: "7", issue_count: 7 })).toEqual({});
  });

  it("keeps the CLI version only as major.minor", () => {
    for (const event of ["inspect_bundle", "extension_activated"]) {
      expect(validateProperties(event, { cli_version: "1.21" })).toEqual({ cli_version: "1.21" });
      for (const value of ["1.21.0", "v1.21", "1.21-dev", "/Users/someone/databricks", "1"]) {
        expect(validateProperties(event, { cli_version: value })).toEqual({});
      }
    }
  });

  it("keeps the sidebar events' fixed values and nothing else", () => {
    expect(validateProperties("sidebar_opened", { at_start: true, bundle: "sales" })).toEqual({ at_start: true });
    expect(validateProperties("sidebar_action", { action: "open_graph" })).toEqual({ action: "open_graph" });
    expect(validateProperties("sidebar_action", { action: "rm -rf" })).toEqual({});
    expect(validateProperties("inspect_bundle", { trigger: "sidebar" })).toEqual({ trigger: "sidebar" });
    expect(validateProperties("quick_fix_applied", { kind: "missing_file" })).toEqual({ kind: "missing_file" });
  });

  // #322: every property has a longest possible value, so the largest event is known.
  it("can never build an event bigger than the batch budget", () => {
    const longest = (rule: (typeof EVENT_SCHEMA)[string][string]): string | number | boolean => {
      switch (rule.type) {
        case "enum":
          return rule.values.reduce((a, b) => (b.length > a.length ? b : a));
        case "integer":
          return rule.max;
        case "boolean":
          return false;
        case "pattern":
          return "x".repeat(rule.maxLength);
      }
    };
    let largest = { event: "", bytes: 0 };
    for (const [event, rules] of Object.entries(EVENT_SCHEMA)) {
      const properties: Record<string, string | number | boolean> = {};
      for (const [key, rule] of Object.entries(rules)) properties[key] = longest(rule);
      // VS Code's common.* values are at most 100 characters (COMMON_VALUE).
      for (const key of COMMON_KEYS) properties[key] = "x".repeat(100);
      const wire = toWireBatch([{ event, distinctId: "0".repeat(32), timestamp: new Date(NOW).toISOString(), properties }]);
      const bytes = Buffer.byteLength(JSON.stringify(wire));
      if (bytes > largest.bytes) largest = { event, bytes };
    }
    // About 2.4 KB on 2026-10-29 (inspect_bundle). A failure means a new property allows
    // values long enough to fill a request alone: lower its maxLength or the batch budget.
    expect(largest.bytes).toBeLessThan(MAX_BATCH_BYTES / 4);
  });

  it("states each pattern's longest value correctly, and refuses anything longer", () => {
    const longestTaskKinds = Array.from({ length: 31 }, () => `${"a".repeat(40)}_task`).join(",");
    const rule = EVENT_SCHEMA.inspect_bundle!.task_kinds!;
    expect(rule.type === "pattern" && rule.maxLength).toBe(longestTaskKinds.length);
    expect(validateProperties("inspect_bundle", { task_kinds: longestTaskKinds })).toEqual({ task_kinds: longestTaskKinds });
    expect(validateProperties("inspect_bundle", { task_kinds: `${longestTaskKinds},b_task` })).toEqual({});
    expect(validateProperties("extension_activated", { cli_version: "999.9999" })).toEqual({ cli_version: "999.9999" });
  });

  it("never sends the VS Code session ID, which would link one window's events beyond the install ID", () => {
    expect(outgoingProperties("inspect_bundle", { "common.vscodesessionid": "abc", "common.os": "darwin" })).toEqual({ "common.os": "darwin" });
  });

  it("drops machine and device IDs before sending", () => {
    expect(
      outgoingProperties("inspect_bundle", {
        outcome: "cli_not_found",
        cli_problem: "not_installed",
        "common.os": "win32",
        "common.vscodeversion": "1.125.1",
        "common.vscodemachineid": "abc",
        "common.sqmid": "{6f2b8c1e-0000-4000-8000-000000000000}",
        "common.devDeviceId": "abc",
        nested: { a: 1 },
      }),
    ).toEqual({
      outcome: "cli_not_found",
      cli_problem: "not_installed",
      "common.os": "win32",
      "common.vscodeversion": "1.125.1",
    });
  });

  // The same check as the proxy, on this machine: nothing the schema doesn't allow is sent (#320).
  it("sends only an event's declared properties with allowed values", () => {
    expect(
      outgoingProperties("inspect_bundle", {
        outcome: "cli_not_found",
        path: "/Users/someone/secret-project/databricks.yml",
        bundle_name: "sales",
        cli_problem: "rm -rf",
        "common.os": "darwin",
      }),
    ).toEqual({ outcome: "cli_not_found", "common.os": "darwin" });
  });

  it("sends nothing for an event the schema doesn't know", () => {
    expect(outgoingProperties("made_up", { outcome: "cli_not_found" })).toBeUndefined();
    expect(outgoingProperties("constructor", {})).toBeUndefined();
  });

  it("keeps a common value only when it looks like one", () => {
    expect(outgoingProperties("extension_uninstalled", { "common.appname": "Visual Studio Code", "common.extversion": "0.6.1" }))
      .toEqual({ "common.appname": "Visual Studio Code", "common.extversion": "0.6.1" });
    expect(outgoingProperties("extension_uninstalled", { "common.appname": "a\nmultiline;value" })).toEqual({});
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
      install_id: ID,
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

  // #324: counted in bytes as the body arrives, and never read past the limit.
  it("stops reading a body with no Content-Length once it passes 64 KB", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x78);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 1024 * 1024) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://proxy.test/e", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const fetchImpl = okFetch();
    expect((await handleTelemetryRequest(request, env, fetchImpl, NOW)).status).toBe(413);
    // 1 MiB on offer; reading stopped just past 64 KB.
    expect(pulled).toBeLessThan(128 * 1024);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("counts bytes, not characters", async () => {
    // 40,000 two-byte characters: 80 KB, though under 64 K characters.
    const request = post(`{"batch":[],"pad":"${"é".repeat(40_000)}"}`);
    request.headers.delete("content-length");
    expect((await handleTelemetryRequest(request, env, okFetch(), NOW)).status).toBe(413);
  });

  it("still forwards a full 32 KB batch from the extension", async () => {
    const fetchImpl = okFetch();
    // task_kinds at its longest: about 1.6 KB per event, 20 of them about 32 KB.
    const taskKinds = Array.from({ length: 31 }, () => `${"a".repeat(40)}_task`).join(",");
    const batch = Array.from({ length: 20 }, () =>
      wireEvent({ properties: { outcome: "ok", task_kinds: taskKinds, "common.extversion": "0.1.3" } }),
    );
    const bytes = Buffer.byteLength(JSON.stringify({ batch }));
    expect(bytes).toBeGreaterThan(30 * 1024);
    expect(bytes).toBeLessThan(64 * 1024);
    expect((await handleTelemetryRequest(post({ batch }), env, fetchImpl, NOW)).status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
