/**
 * The tool catalog, built from the provider's OpenAPI document.
 *
 * The provider publishes ONE surface over three transports, and its own drift
 * test holds them to a single naming convention (providers/docs/PROVIDER-API.md
 * §10): the REST path IS the Socket.IO event name, and the controller method
 * name PascalCased IS the gRPC rpc. So one document is enough to describe every
 * tool on every transport — the request schema comes from the document, the
 * transport is only the carrier.
 */

export type JsonSchema = Record<string, unknown>;

export type OperationKind =
  /** POST /api/kalagh/<path> with a JSON body — the bulk of the surface. */
  | 'json'
  /** POST /api/kalagh/messages/send-media — files uploaded from local paths. */
  | 'upload'
  /** GET /api/kalagh/health and /info — public probes, HTTP only. */
  | 'probe'
  /** GET /storage/{path} — a stored object's bytes, HTTP only. */
  | 'storage';

export interface Operation {
  /** MCP tool name, e.g. `messages_send_poll`. */
  name: string;
  /** The path under /api/kalagh (`messages/send-poll`), or `storage`. */
  path: string;
  kind: OperationKind;
  /** The gRPC rpc, when the operation has one. */
  rpc?: string;
  /** The Socket.IO event, when the operation has one. */
  socketEvent?: string;
  /** Its answer carries bytes (an avatar, a message's media), which only gRPC delivers. */
  bytes: boolean;
  summary: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  destructive: boolean;
}

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
};
type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation | undefined>>;
  components?: { schemas?: Record<string, JsonSchema> };
};

const REST_PREFIX = '/api/kalagh/';

/** Aliases kept on the provider for old callers; each has a canonical twin in the catalog. */
const ALIASES = new Set(['messages/sync-chat', 'messages/download-media', 'messages/mark-messages-as-read']);

/** Routes whose answer is bytes. Over REST and Socket.IO the provider cannot return them. */
const BYTE_ROUTES = new Set(['contacts/get-avatar', 'chats/get-avatar', 'messages/get-media', 'messages/download-media']);

/** Routes with no socket event (the provider's gateway documents why). */
const NO_SOCKET_EVENT = new Set([...BYTE_ROUTES, 'messages/send-media']);

/**
 * What each route does, decided route by route — never guessed from its name.
 *
 *  - `read`        changes nothing anywhere. Listed in read-only mode.
 *  - `write`       changes the provider's own state, or the account's own view
 *                  of itself (archive, pin, mute, a history sync). Nobody else
 *                  sees it.
 *  - `destructive` deletes, logs out, redirects data, or reaches OTHER PEOPLE on
 *                  the platform: a send, a reaction, an edit, a read receipt
 *                  (blue ticks), a block or unblock, a group created, renamed or
 *                  changed, a webhook or credentials repointed.
 *
 * A route missing from this table — a provider newer than this server — is
 * treated as destructive and is never listed in read-only mode. The test
 * suite fails when the bundled document has a route this table does not
 * classify.
 */
export type Effect = 'read' | 'write' | 'destructive';

export const ROUTE_EFFECTS: Readonly<Record<string, Effect>> = {
  health: 'read',
  info: 'read',

  'channels/get': 'read',
  'channels/list': 'read',
  'channels/aliases': 'read',
  'channels/create': 'write',
  'channels/request-qr': 'write',
  'channels/restart': 'write',
  'channels/unload': 'write',
  // webhookUrl and credentials: one call can send every inbound message elsewhere.
  'channels/update': 'destructive',
  'channels/credentials/patch': 'destructive',
  'channels/terminate': 'destructive',
  'channels/delete': 'destructive',

  'contacts/get': 'read',
  'contacts/list': 'read',
  'contacts/search': 'read',
  'contacts/get-avatar': 'read',
  'contacts/create': 'write',
  'contacts/sync': 'write',
  'contacts/update-status': 'write',
  'contacts/delete': 'destructive',
  'contacts/block': 'destructive',
  'contacts/unblock': 'destructive',

  'chats/get': 'read',
  'chats/list': 'read',
  'chats/search': 'read',
  'chats/get-avatar': 'read',
  'chats/get-participants': 'read',
  'chats/sync': 'write',
  'chats/mute': 'write',
  'chats/unmute': 'write',
  'chats/archive': 'write',
  'chats/unarchive': 'write',
  'chats/pin': 'write',
  'chats/unpin': 'write',
  // A WhatsApp group is created on the platform with real participants in it.
  'chats/create': 'destructive',
  // Renames the group for every participant.
  'chats/update': 'destructive',
  'chats/delete': 'destructive',
  'chats/add-participant': 'destructive',
  'chats/remove-participant': 'destructive',
  // Read receipts: the other side sees blue ticks.
  'chats/mark-as-read': 'destructive',

  'messages/get': 'read',
  'messages/list': 'read',
  'messages/search': 'read',
  'messages/attachments': 'read',
  'messages/history': 'read',
  'messages/get-media': 'read',
  'messages/sync': 'write',
  'messages/send': 'destructive',
  'messages/send-media': 'destructive',
  'messages/send-location': 'destructive',
  'messages/send-contact': 'destructive',
  'messages/send-poll': 'destructive',
  'messages/send-event': 'destructive',
  'messages/send-interactive': 'destructive',
  'messages/reply': 'destructive',
  'messages/forward': 'destructive',
  'messages/react': 'destructive',
  'messages/remove-reaction': 'destructive',
  'messages/update': 'destructive',
  'messages/delete': 'destructive',
  'messages/mark-as-read': 'destructive',

  'logs/list': 'read',
  'logs/webhooks': 'read',
};

export const effectOf = (path: string): Effect => ROUTE_EFFECTS[path] ?? 'destructive';

export const toolName = (path: string): string => path.replace(/[/-]/g, '_');

/** `ApiController_requestQRCode` → `RequestQRCode`. */
export function rpcName(operationId: string | undefined): string | undefined {
  const method = operationId?.split('_').pop();
  return method ? method[0]!.toUpperCase() + method.slice(1) : undefined;
}

/**
 * Inline every `$ref` so each tool's schema stands alone, as MCP clients
 * expect. A schema that refers back to itself is cut at the repeat with a
 * plain object, never followed forever.
 */
export function dereference(schema: unknown, components: Record<string, JsonSchema>, seen: string[] = []): unknown {
  if (Array.isArray(schema)) return schema.map((item) => dereference(item, components, seen));
  if (!schema || typeof schema !== 'object') return schema;
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    if (seen.includes(name)) return { type: 'object', description: `${name} (recursive)` };
    const target = components[name];
    if (!target) throw new Error(`OpenAPI document refers to a missing schema: ${ref}`);
    return dereference(target, components, [...seen, name]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = dereference(value, components, seen);
  return out;
}

/**
 * send-media's own input. The document describes it as multipart with binary
 * parts, which an MCP client cannot produce — so the tool takes LOCAL FILE
 * PATHS and the server reads and uploads them. The recipient and caption
 * fields are the document's own.
 */
function uploadSchema(documentSchema: JsonSchema | undefined): JsonSchema {
  const properties = { ...((documentSchema?.properties as Record<string, JsonSchema> | undefined) ?? {}) };
  delete properties.file;
  delete properties.files;
  properties.metadata = {
    type: 'object',
    description: 'Per-platform side channel (`MessageContent.metadata`), e.g. {"email":{"to":["a@b.c"],"subject":"Hi"}}.',
  };
  properties.files = {
    type: 'array',
    minItems: 1,
    description: 'The attachments, ONE message carrying all of them. Each is a file on the machine running this MCP server.',
    items: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path of a local file.' },
        filename: { type: 'string', description: 'Name the recipient sees. Defaults to the file name.' },
        mimeType: { type: 'string', description: 'Defaults to a guess from the extension.' },
      },
    },
  };
  return { type: 'object', required: ['channelId', 'files'], properties };
}

function describe(op: Omit<Operation, 'summary' | 'inputSchema'>, summary: string): string {
  const carriers = [
    op.kind === 'storage' ? 'GET /storage/{path}' : `${op.kind === 'probe' ? 'GET' : 'POST'} /api/kalagh/${op.path}`,
    op.rpc && `gRPC ${op.rpc}`,
    op.socketEvent && `socket "${op.socketEvent}"`,
  ].filter(Boolean);
  const notes: string[] = [];
  if (op.destructive) notes.push('Reaches other people on the platform, deletes, or redirects data — say exactly what will happen and get the user’s confirmation first.');
  if (op.bytes) {
    notes.push('The file is saved locally and its path returned (images are also shown). gRPC answers the bytes in-band; on REST/socket media is fetched from the provider’s storage, and an avatar needs KALAGH_TRANSPORT=grpc.');
  }
  return [summary, ...notes, `(${carriers.join(' · ')})`].join('\n');
}

export function buildCatalog(document: OpenApiDocument, fallbackSummaries: Map<string, string> = new Map()): Operation[] {
  const components = document.components?.schemas ?? {};
  const operations: Operation[] = [];

  for (const [httpPath, item] of Object.entries(document.paths ?? {})) {
    if (httpPath.startsWith('/storage/')) {
      const op = { name: 'storage_get', path: 'storage', kind: 'storage' as const, bytes: true, readOnly: true, destructive: false };
      operations.push({
        ...op,
        summary: describe(op, 'Download a stored object (media, avatar) from the provider’s storage to a local file. ' +
          'Pass the path after /storage/, or a full /storage/... URL as found in a message attachment.'),
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string', description: 'e.g. assets/<channelId>/<chat>/<message>/photo.jpg' } },
        },
      });
      continue;
    }
    if (!httpPath.startsWith(REST_PREFIX)) continue;
    const path = httpPath.slice(REST_PREFIX.length);
    if (ALIASES.has(path)) continue;

    const get = item.get;
    const post = item.post;
    const operation = post ?? get;
    if (!operation) continue;
    if (/^alias of/i.test(operation.summary ?? '')) continue;

    const summary = operation.summary || fallbackSummaries.get(path) || path;
    if (get && !post) {
      const effect = effectOf(path);
      const op = { name: toolName(path), path, kind: 'probe' as const, bytes: false, readOnly: effect === 'read', destructive: effect === 'destructive' };
      operations.push({ ...op, summary: describe(op, summary), inputSchema: { type: 'object', properties: {} } });
      continue;
    }

    const content = operation.requestBody?.content ?? {};
    const bodySchema = (content['application/json'] ?? content['multipart/form-data'])?.schema;
    const resolved = bodySchema ? (dereference(bodySchema, components) as JsonSchema) : undefined;
    const effect = effectOf(path);
    const kind = path === 'messages/send-media' ? ('upload' as const) : ('json' as const);
    const op = {
      name: toolName(path),
      path,
      kind,
      rpc: rpcName(operation.operationId),
      socketEvent: NO_SOCKET_EVENT.has(path) ? undefined : path,
      bytes: BYTE_ROUTES.has(path),
      readOnly: effect === 'read',
      destructive: effect === 'destructive',
    };
    operations.push({
      ...op,
      summary: describe(op, summary),
      inputSchema:
        kind === 'upload'
          ? uploadSchema(resolved)
          : { ...(resolved ?? { type: 'object', properties: {} }), type: 'object' },
    });
  }
  return operations.sort((a, b) => a.name.localeCompare(b.name));
}

/** path → summary, taken from the bundled snapshot to fill in an older live document. */
export function summariesOf(document: OpenApiDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const [httpPath, item] of Object.entries(document.paths ?? {})) {
    const summary = (item.post ?? item.get)?.summary;
    if (summary && httpPath.startsWith(REST_PREFIX)) map.set(httpPath.slice(REST_PREFIX.length), summary);
  }
  return map;
}

export function hasSchemas(document: OpenApiDocument): boolean {
  return Object.keys(document.components?.schemas ?? {}).length > 0 && Object.keys(document.paths ?? {}).length > 0;
}
