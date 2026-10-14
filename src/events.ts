import type { ProviderEvent } from './transports/transport.js';

export interface BufferedEvent extends ProviderEvent {
  /** Monotonic sequence number; pass the last one seen as `afterSeq` to read only newer events. */
  seq: number;
}

export interface EventQuery {
  afterSeq?: number;
  channelId?: string;
  /** Exact name, or a prefix ending in `*` (e.g. `message.*`). */
  eventName?: string;
  limit?: number;
  /** When nothing matches yet, wait up to this long for a match. */
  waitSeconds?: number;
}

/**
 * The provider's event stream, kept in memory. An MCP tool cannot be pushed
 * to, so the events the subscription delivers are held here (newest
 * `capacity`) and read on demand — optionally waiting for the next match,
 * which is what pairing a channel needs: create it, then wait for its
 * connection event.
 */
export class EventBuffer {
  private readonly events: BufferedEvent[] = [];
  private seq = 0;
  private waiters = new Set<() => void>();

  constructor(private readonly capacity = 1000) {}

  push(event: ProviderEvent): void {
    this.events.push({ ...event, seq: ++this.seq });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const wake of this.waiters) wake();
  }

  get lastSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.events.length;
  }

  private match(query: EventQuery): BufferedEvent[] {
    const name = query.eventName?.trim();
    const prefix = name?.endsWith('*') ? name.slice(0, -1) : undefined;
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const matched = this.events.filter(
      (event) =>
        event.seq > (query.afterSeq ?? 0) &&
        (!query.channelId || event.channelId === query.channelId) &&
        (!name || (prefix !== undefined ? event.eventName.startsWith(prefix) : event.eventName === name)),
    );
    return matched.slice(-limit);
  }

  async query(query: EventQuery): Promise<BufferedEvent[]> {
    const found = this.match(query);
    const wait = Math.max(0, Math.min(query.waitSeconds ?? 0, 120));
    if (found.length || wait === 0) return found;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(this.match(query));
      };
      const check = () => {
        if (this.match(query).length) done();
      };
      const timer = setTimeout(done, wait * 1000);
      this.waiters.add(check);
    });
  }
}
