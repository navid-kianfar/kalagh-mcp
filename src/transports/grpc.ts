import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Config } from '../config.js';
import type { Operation } from '../catalog.js';
import { HttpTransport } from './http.js';
import { KalaghError, parseEventData, type EventSource, type ProviderEvent, type Transport } from './transport.js';

type FieldDescriptor = {
  name: string;
  label: string;
  type: string;
  typeName: string;
};
type MessageDescriptor = {
  name: string;
  field: FieldDescriptor[];
  nestedType?: MessageDescriptor[];
  options?: { mapEntry?: boolean } | null;
};
type MethodDefinition = protoLoader.MethodDefinition<object, object> & {
  requestType: { type: MessageDescriptor };
};

const PACKAGE = 'kalagh';
const SERVICE = `${PACKAGE}.KalaghService`;
/** The provider allows 500 MB each way (bootstrap.ts); a client has to raise its own limits to match. */
const MAX_MESSAGE = 500 * 1024 * 1024;

export const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: Number,
  defaults: false,
  oneofs: true,
};

const INTEGER_TYPES = new Set(['TYPE_INT32', 'TYPE_INT64', 'TYPE_UINT32', 'TYPE_UINT64', 'TYPE_SINT32', 'TYPE_SINT64', 'TYPE_FIXED32', 'TYPE_FIXED64', 'TYPE_SFIXED32', 'TYPE_SFIXED64', 'TYPE_ENUM']);
const FLOAT_TYPES = new Set(['TYPE_DOUBLE', 'TYPE_FLOAT']);

/**
 * REST-shaped arguments → the rpc's request message.
 *
 * The tool schemas are the REST DTOs; the proto carries the same fields under
 * the same names (the provider's parity test holds them together), with two
 * kinds of difference this walk absorbs, driven by the proto itself rather
 * than a hand-kept table:
 *  - a free-form object the proto carries as a JSON STRING
 *    (`channels/credentials/patch.credentials`, every `metadata`) is
 *    stringified;
 *  - a `map<string,string>` value that is not a string is stringified.
 *
 * A field the proto does not declare is never dropped: silently losing it on
 * one transport would make the same call mean something else there. The
 * shaper raises a ProtoGapError, and the transport carries that call over
 * REST instead (the arguments were already validated against the REST schema).
 */
export class ProtoShaper {
  constructor(private readonly definition: protoLoader.PackageDefinition) {}

  method(rpc: string): MethodDefinition | undefined {
    const service = this.definition[SERVICE] as protoLoader.ServiceDefinition | undefined;
    return service?.[rpc] as MethodDefinition | undefined;
  }

  shape(rpc: string, args: Record<string, unknown>): Record<string, unknown> {
    const method = this.method(rpc);
    if (!method) throw new KalaghError(`The provider's proto has no rpc ${rpc}`);
    return this.message(method.requestType.type, args, rpc) as Record<string, unknown>;
  }

  private resolve(typeName: string, parent: MessageDescriptor): MessageDescriptor | undefined {
    const name = typeName.replace(/^\./, '');
    const nested = parent.nestedType?.find((type) => type.name === name.split('.').pop());
    if (nested) return nested;
    const qualified = name.includes('.') ? name : `${PACKAGE}.${name}`;
    return (this.definition[qualified] as { type?: MessageDescriptor } | undefined)?.type;
  }

  private message(type: MessageDescriptor, value: unknown, path: string): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new KalaghError(`${path}: expected an object`, 400);
    }
    const fields = new Map(type.field.map((field) => [field.name, field]));
    const unknown = Object.keys(value).filter((key) => !fields.has(key) && (value as Record<string, unknown>)[key] !== undefined);
    if (unknown.length) {
      throw new ProtoGapError(
        `${path}: ${unknown.map((key) => `property ${key} has no counterpart in gRPC ${type.name}`).join(', ')}`,
        unknown.map((key) => `${path}.${key}`),
      );
    }
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (raw === undefined || raw === null) continue;
      out[key] = this.field(fields.get(key)!, raw, type, `${path}.${key}`);
    }
    return out;
  }

  private field(field: FieldDescriptor, value: unknown, parent: MessageDescriptor, path: string): unknown {
    if (field.type === 'TYPE_MESSAGE') {
      const target = this.resolve(field.typeName, parent);
      if (!target) throw new KalaghError(`${path}: unknown proto type ${field.typeName}`);
      if (target.options?.mapEntry) {
        if (typeof value !== 'object' || Array.isArray(value)) throw new KalaghError(`${path}: expected an object`, 400);
        const valueField = target.field.find((f) => f.name === 'value')!;
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, this.field(valueField, v, target, `${path}.${k}`)]),
        );
      }
      if (field.label === 'LABEL_REPEATED') {
        if (!Array.isArray(value)) throw new KalaghError(`${path}: expected an array`, 400);
        return value.map((item, index) => this.message(target, item, `${path}[${index}]`));
      }
      return this.message(target, value, path);
    }
    if (field.label === 'LABEL_REPEATED') {
      if (!Array.isArray(value)) throw new KalaghError(`${path}: expected an array`, 400);
      return value.map((item, index) => this.scalar(field, item, `${path}[${index}]`));
    }
    return this.scalar(field, value, path);
  }

  private scalar(field: FieldDescriptor, value: unknown, path: string): unknown {
    if (field.type === 'TYPE_STRING') {
      if (typeof value === 'string') return value;
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    if (INTEGER_TYPES.has(field.type) || FLOAT_TYPES.has(field.type)) {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) throw new KalaghError(`${path}: expected a number`, 400);
      return number;
    }
    if (field.type === 'TYPE_BOOL') return value === true || value === 'true';
    if (field.type === 'TYPE_BYTES') return typeof value === 'string' ? Buffer.from(value, 'base64') : value;
    return value;
  }
}

/** Arguments use a field the rpc's request message does not declare. */
export class ProtoGapError extends KalaghError {
  constructor(message: string, readonly fields: string[]) {
    super(message, 400);
    this.name = 'ProtoGapError';
  }
}

type GrpcClient = grpc.Client & Record<string, (...args: unknown[]) => unknown>;

/** One gRPC client, shared by the operations and the event stream. */
export class GrpcConnection {
  private client?: GrpcClient;
  private readonly definition: protoLoader.PackageDefinition;
  readonly shaper: ProtoShaper;

  constructor(private readonly config: Config, protoPath: string) {
    this.definition = protoLoader.loadSync(protoPath, LOADER_OPTIONS);
    this.shaper = new ProtoShaper(this.definition);
  }

  get(): GrpcClient {
    if (this.client) return this.client;
    const loaded = grpc.loadPackageDefinition(this.definition) as unknown as Record<string, Record<string, grpc.ServiceClientConstructor>>;
    const Service = loaded[PACKAGE]!.KalaghService!;
    const credentials = this.config.grpcTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.client = new Service(this.config.grpcUrl!, credentials, {
      'grpc.max_receive_message_length': MAX_MESSAGE,
      'grpc.max_send_message_length': MAX_MESSAGE,
    }) as unknown as GrpcClient;
    return this.client;
  }

  metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.set('x-api-key', this.config.apiKey);
    return metadata;
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
  }
}

const STATUS_TO_HTTP: Partial<Record<grpc.status, number>> = {
  [grpc.status.INVALID_ARGUMENT]: 400,
  [grpc.status.UNAUTHENTICATED]: 401,
  [grpc.status.PERMISSION_DENIED]: 403,
  [grpc.status.NOT_FOUND]: 404,
  [grpc.status.UNIMPLEMENTED]: 501,
  [grpc.status.UNAVAILABLE]: 503,
  [grpc.status.DEADLINE_EXCEEDED]: 504,
};

/**
 * gRPC: the operation's rpc on `kalagh.KalaghService`, the key in the
 * `x-api-key` metadata entry. The probes, `/storage` and the multipart upload
 * have no rpc a client can use, so they go over REST.
 */
export class GrpcTransport implements Transport {
  readonly kind = 'grpc' as const;

  constructor(
    private readonly config: Config,
    private readonly connection: GrpcConnection,
    private readonly http: HttpTransport,
  ) {}

  /**
   * Whether this operation runs over gRPC. `messages/send-media` stays on
   * REST multipart: it streams the file instead of holding it in one message,
   * and gRPC SendMedia only maps its files since kalagh 73aa17fe0, so an older
   * provider still in service cannot take an upload over gRPC.
   */
  carries(op: Operation): boolean {
    return op.kind === 'json' && !!op.rpc && !!this.connection.shaper.method(op.rpc);
  }

  async call(op: Operation, args: Record<string, unknown>): Promise<unknown> {
    if (!this.carries(op)) return this.http.call(op, args);
    let request: Record<string, unknown>;
    try {
      request = this.connection.shaper.shape(op.rpc!, args);
    } catch (error) {
      // A field REST takes and the proto does not (e.g. channels/update.metadata):
      // the call still has to mean what it says, so it goes where it can.
      if (error instanceof ProtoGapError) return this.http.call(op, args);
      throw error;
    }
    const client = this.connection.get();
    const fn = client[op.rpc!];
    if (typeof fn !== 'function') throw new KalaghError(`gRPC client has no method ${op.rpc}`);
    return new Promise((resolve, reject) => {
      fn.call(
        client,
        request,
        this.connection.metadata(),
        { deadline: Date.now() + this.config.timeoutMs },
        (error: grpc.ServiceError | null, response: unknown) => {
          if (error) reject(new KalaghError(error.details || error.message, STATUS_TO_HTTP[error.code] ?? `grpc:${grpc.status[error.code]}`));
          else resolve(response);
        },
      );
    });
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}

/**
 * `StreamEvents`: one server stream carrying every signal, reopened with
 * backoff when it drops. UNIMPLEMENTED is final, not retried: a provider whose
 * handler is registered as a client-streaming method (`@GrpcStreamMethod` on a
 * server-streaming rpc) answers that on every attempt. `error` says why.
 */
export class GrpcEventSource implements EventSource {
  readonly kind = 'grpc' as const;
  private stream?: grpc.ClientReadableStream<unknown>;
  private closed = false;
  private retry?: NodeJS.Timeout;
  error?: string;

  constructor(private readonly connection: GrpcConnection) {}

  subscribe(onEvent: (event: ProviderEvent) => void, attempt = 0): void {
    if (this.closed) return;
    const client = this.connection.get();
    const stream = (client.StreamEvents as (req: object, md: grpc.Metadata) => grpc.ClientReadableStream<unknown>).call(
      client,
      {},
      this.connection.metadata(),
    );
    this.stream = stream;
    let received = false;
    stream.on('data', (message: { eventName?: string; channelId?: string; data?: string; timestamp?: string | number }) => {
      received = true;
      this.error = undefined;
      onEvent({
        eventName: message.eventName ?? '',
        channelId: message.channelId ?? '',
        data: parseEventData(message.data),
        timestamp: Number(message.timestamp) || Date.now(),
      });
    });
    const reopen = (reason: string, final = false) => {
      if (this.closed || this.stream !== stream) return;
      this.stream = undefined;
      this.error = reason;
      if (final) {
        console.error(`[kalagh-mcp] gRPC event stream unavailable: ${reason}`);
        return;
      }
      const next = received ? 0 : attempt + 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(next, 5));
      console.error(`[kalagh-mcp] gRPC event stream ended (${reason}); reopening in ${delay} ms`);
      this.retry = setTimeout(() => this.subscribe(onEvent, next), delay);
    };
    stream.on('error', (error: grpc.ServiceError) =>
      reopen(error.details || error.message, error.code === grpc.status.UNIMPLEMENTED || error.code === grpc.status.UNAUTHENTICATED),
    );
    stream.on('end', () => reopen('the server ended the stream'));
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    this.stream?.cancel();
    this.connection.close();
  }
}
