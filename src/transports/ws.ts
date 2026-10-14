import { io, type Socket } from 'socket.io-client';
import type { Config } from '../config.js';
import type { Operation } from '../catalog.js';
import { HttpTransport } from './http.js';
import { KalaghError, parseEventData, type EventSource, type ProviderEvent, type Transport } from './transport.js';

type Ack = { success: boolean; data?: unknown; error?: string };

/**
 * One Socket.IO connection, shared by the operations and the event stream.
 * The key goes in the handshake query, where the gateway's handleConnection
 * reads it; a wrong key is answered with an `error` event and a disconnect,
 * never an ack — so a refused handshake is surfaced from that event.
 */
export class SocketConnection {
  private socket?: Socket;
  refusal?: string;

  constructor(private readonly config: Config) {}

  get(): Socket {
    if (this.socket) return this.socket;
    const socket = io(this.config.wsUrl!, {
      transports: ['websocket'],
      query: { apiKey: this.config.apiKey },
      reconnection: true,
      reconnectionDelayMax: 10_000,
    });
    socket.on('error', (error: { message?: string } | string) => {
      this.refusal = typeof error === 'string' ? error : (error?.message ?? 'refused');
      console.error(`[kalagh-mcp] socket refused: ${this.refusal}`);
    });
    socket.on('connect', () => {
      this.refusal = undefined;
    });
    this.socket = socket;
    return socket;
  }

  /** Resolves once connected, or rejects with why it is not. */
  async ready(timeoutMs: number): Promise<Socket> {
    const socket = this.get();
    if (socket.connected) return socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new KalaghError(`Socket.IO ${this.config.wsUrl} is not connected${this.refusal ? `: ${this.refusal}` : ''}`));
      }, Math.min(timeoutMs, 15_000));
      const onConnect = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (error: { message?: string } | string) => {
        cleanup();
        reject(new KalaghError(`Socket.IO refused the connection: ${typeof error === 'string' ? error : error?.message}`, 401));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      socket.on('connect', onConnect);
      socket.on('error', onError);
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }
}

/**
 * Socket.IO: each operation is an event named exactly like its REST path,
 * answered by an ack `{ success, data | error }`. The routes the gateway does
 * not carry — the probes, the byte answers, the multipart upload and
 * `/storage` — go over REST, as the provider's own guide prescribes.
 */
export class WsTransport implements Transport {
  readonly kind = 'ws' as const;

  constructor(
    private readonly config: Config,
    private readonly connection: SocketConnection,
    private readonly http: HttpTransport,
  ) {}

  async call(op: Operation, args: Record<string, unknown>): Promise<unknown> {
    if (!op.socketEvent) return this.http.call(op, args);
    const socket = await this.connection.ready(this.config.timeoutMs);
    let ack: Ack;
    try {
      ack = (await socket.timeout(this.config.timeoutMs).emitWithAck(op.socketEvent, args)) as Ack;
    } catch {
      throw new KalaghError(`No answer to "${op.socketEvent}" within ${this.config.timeoutMs} ms`);
    }
    if (!ack || typeof ack !== 'object') throw new KalaghError(`Malformed ack for "${op.socketEvent}"`);
    if (!ack.success) throw new KalaghError(ack.error ?? 'Unknown error');
    return ack.data ?? { success: true };
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}

/** The gateway broadcasts every provider signal to every client as `event`. */
export class WsEventSource implements EventSource {
  readonly kind = 'ws' as const;

  constructor(private readonly connection: SocketConnection) {}

  get error(): string | undefined {
    return this.connection.refusal;
  }

  subscribe(onEvent: (event: ProviderEvent) => void): void {
    this.connection.get().on('event', (payload: ProviderEvent) => {
      onEvent({
        eventName: payload.eventName,
        channelId: payload.channelId,
        data: parseEventData(payload.data),
        timestamp: Number(payload.timestamp) || Date.now(),
      });
    });
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}
