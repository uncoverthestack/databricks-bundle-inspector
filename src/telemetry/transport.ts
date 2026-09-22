import type { TelemetryProperties, WireEvent } from "./schema.js";

export type { TelemetryProperties };

export interface QueuedEvent {
  event: string;
  distinctId: string;
  timestamp: string;
  properties: TelemetryProperties;
}

/**
 * - `sent`: delivered, drop from the queue.
 * - `drop`: the proxy rejected the payload; retrying would fail forever.
 * - `retry`: offline, timed out, rate limited or server-side failure; keep for later.
 */
export type SendResult = "sent" | "drop" | "retry";

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number }>;

export interface TransportOptions {
  endpoint: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function toWireBatch(events: QueuedEvent[]): { batch: WireEvent[] } {
  return {
    batch: events.map((e) => ({
      event: e.event,
      distinct_id: e.distinctId,
      timestamp: e.timestamp,
      properties: e.properties,
    })),
  };
}

/** Posts a batch to the telemetry proxy. No credentials are sent or needed. */
export async function postBatch(
  events: QueuedEvent[],
  options: TransportOptions,
): Promise<SendResult> {
  if (events.length === 0) return "sent";
  if (!options.endpoint) return "drop";

  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const response = await fetchImpl(options.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toWireBatch(events)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (response.status >= 200 && response.status < 300) return "sent";
    if (response.status === 429 || response.status >= 500) return "retry";
    return "drop";
  } catch {
    return "retry";
  }
}
