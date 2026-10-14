import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { Operation } from './catalog.js';
import type { EventBuffer } from './events.js';
import type { LoadedCatalog } from './document.js';
import { OutputWriter, type Content } from './output.js';
import type { HttpTransport } from './transports/http.js';
import { KalaghError, type EventSource, type Transport } from './transports/transport.js';
import { ArgumentValidator, closeObjects } from './validate.js';

export const SERVER_NAME = 'kalagh';
export const SERVER_VERSION = '1.0.0';

const INSTRUCTIONS = `Tools for one Kalagh provider — a gateway to one messaging platform (WhatsApp, Telegram, Instagram, email, …) holding channels, contacts, chats and messages.

How the API works:
- A channel is one connected account. Almost every call needs its channelId: start with channels_list.
- Ids are the provider's own row ids (e.g. 20261011-0931-0c28-7f3a-000000000045). Single-record getters (channels_get, contacts_get, chats_get, messages_get) also accept channelId + platformId (a WhatsApp JID). Never invent an id; look it up.
- A send names its recipient with EXACTLY ONE of chatId, contactId, phoneNumber (international, e.g. +989121234567) or username.
- Lists: channels/contacts/chats/logs page with page+limit; messages_list, messages_attachments and messages_history are cursor-paged, newest first — pass the nextCursor you were given.
- Unknown fields are rejected, never ignored.
- Sending, replying, forwarding, reacting, editing, deleting, marking as read (the other side sees read receipts), blocking or unblocking, creating, renaming or changing a group, and repointing a channel's webhook or credentials all reach REAL people or redirect their data: state exactly what will happen and get the user's confirmation first.
- messages_send_media uploads files from paths on the machine running this server.
- Pairing a channel: channels_create (or channels_request_qr) returns a QR image to scan; events_recent with waitSeconds waits for it to connect.`;

export interface ServerDeps {
  config: Config;
  catalog: LoadedCatalog;
  transport: Transport;
  /** REST, for what only it serves — here, the stored bytes a media answer points at. */
  http: HttpTransport;
  events?: { source: EventSource; buffer: EventBuffer };
}

const EVENTS_TOOL: Tool = {
  name: 'events_recent',
  description:
    'The provider events this server has received since it started (message.received, message.status, channel.*, chat.*, contact.*, …), oldest first. ' +
    'Pass the last `seq` you saw as afterSeq to read only newer ones, and waitSeconds to wait for the next match (e.g. a channel connecting after its QR is scanned).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      afterSeq: { type: 'integer', minimum: 0, description: 'Only events after this sequence number.' },
      channelId: { type: 'string', description: 'Only this channel’s events.' },
      eventName: { type: 'string', description: 'Exact event name, or a prefix ending in * (e.g. "message.*").' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Newest N matches (default 50).' },
      waitSeconds: { type: 'number', minimum: 0, maximum: 120, description: 'Wait up to this long when nothing matches yet.' },
    },
  },
  annotations: { title: 'Recent provider events', readOnlyHint: true, openWorldHint: false },
};

const STATUS_TOOL: Tool = {
  name: 'status',
  description:
    'How this MCP server is connected: transport, endpoints, where the tool schemas came from, the event subscription, and the provider’s own health and info.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  annotations: { title: 'Connection status', readOnlyHint: true, openWorldHint: false },
};

export function createServer(deps: ServerDeps): Server {
  const { config, catalog, transport, events } = deps;
  const operations = catalog.operations.filter((op) => !config.readOnly || op.readOnly);
  const byName = new Map(operations.map((op) => [op.name, op]));
  const schemas = new Map(operations.map((op) => [op.name, closeObjects(op.inputSchema) as Record<string, unknown>]));
  const validator = new ArgumentValidator();
  const output = new OutputWriter(config.downloadDir);

  const tools: Tool[] = operations.map((op) => ({
    name: op.name,
    description: op.summary,
    inputSchema: schemas.get(op.name) as Tool['inputSchema'],
    annotations: {
      title: op.path,
      readOnlyHint: op.readOnly,
      destructiveHint: op.destructive,
      openWorldHint: true,
    },
  }));
  tools.push(STATUS_TOOL);
  if (events) tools.push(EVENTS_TOOL);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === STATUS_TOOL.name) return { content: await status(deps, operations, byName) };
      if (name === EVENTS_TOOL.name && events) {
        const invalid = validator.check(name, EVENTS_TOOL.inputSchema as Record<string, unknown>, args);
        if (invalid) throw new KalaghError(invalid, 400);
        const found = await events.buffer.query(args);
        return {
          content: [{ type: 'text', text: JSON.stringify({ lastSeq: events.buffer.lastSeq, events: found }, null, 2) }],
        };
      }
      const op = byName.get(name);
      if (!op) throw new KalaghError(`Unknown tool: ${name}`);
      const invalid = validator.check(name, schemas.get(name)!, args);
      if (invalid) throw new KalaghError(invalid, 400);
      const result = await transport.call(op, args);
      return { content: await output.render(op.bytes ? await withStoredBytes(result, deps.http) : result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof KalaghError && error.code !== undefined ? ` [${error.code}]` : '';
      return { isError: true, content: [{ type: 'text', text: `${message}${code}` }] };
    }
  });

  return server;
}

const hasBytes = (value: Record<string, unknown>): boolean =>
  Object.values(value).some((item) => item instanceof Uint8Array && item.length > 0);

/**
 * A file answer that names where its bytes are stored but does not carry them
 * — the REST/Socket.IO descriptor `{ mimeType, filename?, storagePath, url }`,
 * or an older provider's `{ stream, storagePath }` — gets them fetched from
 * `GET /storage/{storagePath}`, so the caller ends up with a file on every
 * transport.
 */
export async function withStoredBytes(result: unknown, http: HttpTransport): Promise<unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const storagePath = typeof record.storagePath === 'string' ? record.storagePath : undefined;
  if (!storagePath || hasBytes(record)) return result;
  const { stream: _stream, ...rest } = record;
  try {
    const file = await http.download(storagePath);
    // The descriptor's own name beats the storage key's last segment.
    if (typeof record.filename === 'string' && record.filename) file.filename = record.filename;
    return { ...rest, file };
  } catch (error) {
    return { ...rest, fileError: error instanceof Error ? error.message : String(error) };
  }
}

async function status(deps: ServerDeps, operations: Operation[], byName: Map<string, Operation>): Promise<Content[]> {
  const { config, catalog, transport, events } = deps;
  const probe = async (path: 'health' | 'info') => {
    const op = byName.get(path);
    if (!op) return 'not in this provider’s document';
    try {
      return await transport.call(op, {});
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const report = {
    transport: transport.kind,
    endpoints: {
      rest: config.apiUrl,
      socket: config.wsUrl ?? null,
      grpc: config.grpcUrl ? `${config.grpcUrl}${config.grpcTls ? ' (TLS)' : ' (plaintext)'}` : null,
    },
    readOnly: config.readOnly,
    storageOrigins: [new URL(config.apiUrl).origin, ...config.storageOrigins],
    tools: operations.length,
    schemaSource: catalog.source,
    ...(catalog.liveError ? { liveDocumentError: catalog.liveError } : {}),
    events: events
      ? {
          via: events.source.kind,
          buffered: events.buffer.size,
          lastSeq: events.buffer.lastSeq,
          ...(events.source.error ? { error: events.source.error } : {}),
        }
      : 'off — set KALAGH_WS_URL (or KALAGH_GRPC_URL)',
    downloadDir: config.downloadDir,
    provider: { health: await probe('health'), info: await probe('info') },
  };
  return [{ type: 'text', text: JSON.stringify(report, null, 2) }];
}
