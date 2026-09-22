import type { QueuedEvent, SendResult } from "./transport.js";

export interface QueueStorage {
  get(): QueuedEvent[] | undefined;
  set(events: QueuedEvent[]): PromiseLike<void> | void;
}

export interface QueueOptions {
  maxEvents?: number;
  maxAgeMs?: number;
  batchSize?: number;
  now?: () => number;
}

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;

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
  private readonly now: () => number;

  constructor(
    private readonly storage: QueueStorage,
    private readonly send: (events: QueuedEvent[]) => Promise<SendResult>,
    options: QueueOptions = {},
  ) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
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
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.events.length > 0) {
      const batch = this.events.slice(0, this.batchSize);
      const result = await this.send(batch);
      if (result === "retry") return;
      this.events = this.events.filter((e) => !batch.includes(e));
      this.persist();
    }
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
