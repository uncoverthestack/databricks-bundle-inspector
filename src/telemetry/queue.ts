import type { QueuedEvent, SendResult } from "./transport.js";

export interface QueueStorage {
  get(): QueuedEvent[] | undefined;
  set(events: QueuedEvent[]): PromiseLike<void> | void;
}

export interface QueueOptions {
  maxEvents?: number;
  maxAgeMs?: number;
  batchSize?: number;
  maxBatchBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;
/**
 * Half the proxy's 64 KB limit: a bigger body is refused with a 413, which drops the whole
 * batch. Batches go by size as well as count, so genuine events never reach the limit (#322).
 */
export const MAX_BATCH_BYTES = 32 * 1024;

/**
 * Persistent, bounded event queue. Events survive offline periods and restarts
 * via `storage`, and are delivered in batches whenever a flush succeeds.
 */
export class TelemetryQueue {
  private events: QueuedEvent[];
  private flushing: Promise<void> | undefined;
  private readonly maxEvents: number;
  private readonly maxAgeMs: number;
  private readonly batchSize: number;
  private readonly maxBatchBytes: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: QueueStorage,
    private readonly send: (events: QueuedEvent[]) => Promise<SendResult>,
    options: QueueOptions = {},
  ) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxBatchBytes = options.maxBatchBytes ?? MAX_BATCH_BYTES;
    this.now = options.now ?? Date.now;
    this.events = this.withinLimits(storage.get() ?? []);
  }

  get size(): number {
    return this.events.length;
  }

  enqueue(event: QueuedEvent): void {
    this.events = this.withinLimits([...this.events, event]);
    this.persist();
  }

  clear(): void {
    this.events = [];
    this.persist();
  }

  flush(): Promise<void> {
    // A flush in flight may already have passed the events enqueued since it began,
    // so run again once it is done.
    if (this.flushing) return this.flushing.then(() => this.flush());
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    // The age limit holds when sending too, not only when the queue loads or grows: a
    // window open for weeks would otherwise send events older than 14 days.
    this.dropExpired();
    while (this.events.length > 0) {
      const batch = this.nextBatch();
      const result = await this.send(batch);
      if (result === "retry") return;
      this.events = this.events.filter((e) => !batch.includes(e));
      this.persist();
      this.dropExpired();
    }
  }

  /**
   * The oldest events that fit in one request: at most `batchSize` of them and at most
   * `maxBatchBytes` of JSON. Always at least one, so the queue can't get stuck; the rest go
   * in the next request. Events are sent whole, never cut.
   */
  private nextBatch(): QueuedEvent[] {
    const batch: QueuedEvent[] = [];
    let bytes = 0;
    for (const event of this.events) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (batch.length > 0 && (batch.length >= this.batchSize || bytes + size > this.maxBatchBytes)) break;
      batch.push(event);
      bytes += size;
    }
    return batch;
  }

  private dropExpired(): void {
    const kept = this.withinLimits(this.events);
    if (kept.length === this.events.length) return;
    this.events = kept;
    this.persist();
  }

  private withinLimits(events: QueuedEvent[]): QueuedEvent[] {
    const cutoff = this.now() - this.maxAgeMs;
    return events
      .filter((e) => Date.parse(e.timestamp) >= cutoff)
      .slice(-this.maxEvents);
  }

  private persist(): void {
    try {
      void Promise.resolve(this.storage.set([...this.events])).catch(() => {});
    } catch {
      // Storage failures must never affect the extension.
    }
  }
}
