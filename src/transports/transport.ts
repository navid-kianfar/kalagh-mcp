import type { Operation } from '../catalog.js';

/** A failure the provider (or the transport) reported, with its HTTP-style code when there is one. */
export class KalaghError extends Error {
  constructor(message: string, readonly code?: number | string) {
    super(message);
    this.name = 'KalaghError';
  }
}

/** One provider event, as every event transport delivers it. */
export interface ProviderEvent {
  eventName: string;
  channelId: string;
  data: unknown;
  /** Epoch milliseconds. */
  timestamp: number;
}

export interface Transport {
  readonly kind: 'http' | 'ws' | 'grpc';
  /** Run one operation with REST-shaped arguments; resolve to the provider's answer. */
  call(op: Operation, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface EventSource {
  readonly kind: 'ws' | 'grpc';
  /** Why the subscription is not delivering, when it is not. */
  readonly error?: string;
  /** Start delivering events; returns once the subscription is requested, not once it is live. */
  subscribe(onEvent: (event: ProviderEvent) => void): void;
  close(): Promise<void>;
}

/** An event's `data` arrives as a JSON string on gRPC and as an object on the socket. */
export function parseEventData(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}
