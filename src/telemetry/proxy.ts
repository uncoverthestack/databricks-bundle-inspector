// Request handler for the telemetry proxy (deployed from telemetry-proxy/).
// It holds the PostHog key, and forwards only events that match the schema.
import { validateWireEvent, type WireEvent } from "./schema.js";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ProxyEnv {
  POSTHOG_API_KEY: string;
  POSTHOG_HOST: string;
  RATE_LIMITER?: RateLimiter;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 50;

const empty = (status: number) => new Response(null, { status });

export function toPostHogBatch(apiKey: string, events: WireEvent[]) {
  return {
    api_key: apiKey,
    batch: events.map((e) => ({
      ...e,
      properties: {
        ...e.properties,
        // distinct_id again, as a plain property PostHog filters (such as
        // "Filter out internal and test users") can match on personless events.
        install_id: e.distinct_id,
        // No person profiles, no IP-based geolocation.
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: null,
      },
    })),
  };
}

/** The body as text, or undefined, having stopped reading, once it passes `limit` bytes. */
async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * Status codes follow the extension's retry contract (see transport.ts):
 * 2xx delivered, 429/5xx retry later, other 4xx drop.
 */
export async function handleTelemetryRequest(
  request: Request,
  env: ProxyEnv,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Response> {
  if (new URL(request.url).pathname !== "/e") return empty(404);
  if (request.method !== "POST") return empty(405);
  if (!env.POSTHOG_API_KEY) return empty(503);

  if (env.RATE_LIMITER) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) return empty(429);
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return empty(413);
  // Counted in bytes as it arrives, so a body with no Content-Length is never read past the
  // limit (#324).
  const body = await readLimited(request, MAX_BODY_BYTES);
  if (body === undefined) return empty(413);

  let batch: unknown;
  try {
    batch = (JSON.parse(body) as { batch?: unknown }).batch;
  } catch {
    return empty(400);
  }
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_BATCH) return empty(400);

  const events = batch
    .map((raw) => validateWireEvent(raw, now))
    .filter((e): e is WireEvent => e !== undefined);
  if (events.length === 0) return empty(204);

  try {
    const response = await fetchImpl(`${env.POSTHOG_HOST}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toPostHogBatch(env.POSTHOG_API_KEY, events)),
    });
    if (response.ok) return empty(204);
    return empty(response.status === 429 || response.status >= 500 ? 502 : 400);
  } catch {
    return empty(502);
  }
}
