import { io, type Socket } from 'socket.io-client';
import type { Config } from '../config.js';
import type { Operation } from '../catalog.js';
import { HttpTransport } from './http.js';
import { KalaghError, parseEventData, type EventSource, type ProviderEvent, type Transport } from './transport.js';

type Ack = { success: boolean; data?: unknown; error?: string };

/**
 * One Socket.IO connection, shared by the operations and the event stream.
 *
 * The key rides the `x-api-key` header of the WebSocket upgrade — never the
 * handshake query, which would write it into every proxy's access log on every
 * reconnect. The gateway's handleConnection reads either. A wrong key is
 * answered with an `error` event and a server-side disconnect, never an ack;
 * socket.io does not reconnect after a server disconnect, so a refusal is
 * final for this process and every later call reports it at once.
 */
export class SocketConnection {
  private socket?: Socket;
  /** Why the gateway refused this client (a wrong key), once it has. */
  refusal?: string;
  /** The last transport-level failure to connect (DNS, TLS, refused port). */
  private connectError?: string;

  constructor(private readonly config: Config) {}

  get(): Socket {
    if (this.socket) return this.socket;
    const socket = io(this.config.wsUrl!, {
      transports: ['websocket'],
      extraHeaders: { 'x-api-key': this.config.apiKey },
      reconnection: true,
      reconnectionDelayMax: 10_000,
    });
    socket.on('error', (error: { message?: string } | string) => {
      this.refusal = typeof error === 'string' ? error : (error?.message ?? 'refused');
      console.error(`[kalagh-mcp] socket refused: ${this.refusal}`);
    });
    socket.on('connect_error', (error: Error) => {
      this.connectError = error.message;
    });
    socket.on('connect', () => {
      this.refusal = undefined;
      this.connectError = undefined;
    });
    this.socket = socket;
    return socket;
  }

  /** Why the socket is not usable, when it is not. */
  why(): string | undefined {
    return this.refusal ?? this.connectError;
  }

  /** Resolves once connected, or rejects with why it is not. */
  async ready(timeoutMs: number): Promise<Socket> {
    const socket = this.get();
    if (socket.connected) return socket;
    if (this.refusal) throw this.refused();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new KalaghError(`Socket.IO ${this.config.wsUrl} is not connected${this.why() ? `: ${this.why()}` : ''}`, 503));
      }, Math.min(timeoutMs, 15_000));
      const onConnect = () => {
        cleanup();
        resolve(socket);
      };
      const onError = () => {
        cleanup();
        reject(this.refused());
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

  refused(): KalaghError {
    return new KalaghError(`Socket.IO ${this.config.wsUrl} refused this client: ${this.refusal ?? 'refused'} (check KALAGH_API_KEY)`, 401);
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
    const started = Date.now();
    try {
      ack = (await socket.timeout(this.config.timeoutMs).emitWithAck(op.socketEvent, args)) as Ack;
    } catch (error) {
      // The ack never came. Say why: a refusal the gateway sent meanwhile, a
      // dropped connection, or — only when the wait really ran out — a timeout.
      if (this.connection.refusal) throw this.connection.refused();
      const elapsed = Date.now() - started;
      const reason = error instanceof Error ? error.message : String(error);
      const failure = !socket.connected
        ? new KalaghError(`Socket.IO disconnected before answering "${op.socketEvent}"${this.connection.why() ? `: ${this.connection.why()}` : ''}`, 503)
        : elapsed >= this.config.timeoutMs
          ? new KalaghError(`No answer to "${op.socketEvent}" within ${this.config.timeoutMs} ms`, 504)
          : new KalaghError(`"${op.socketEvent}" failed after ${elapsed} ms: ${reason}`);
      failure.cause = error;
      throw failure;
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
    return this.connection.why();
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
