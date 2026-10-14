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

/** The last path segments that only read. */
const READ_VERBS = new Set([
  'get', 'list', 'search', 'aliases', 'attachments', 'history',
  'get-avatar', 'get-participants', 'get-media', 'download-media', 'webhooks',
]);

/**
 * Writes that are reversible or local to the provider. Every other write is
 * marked destructive: it deletes, logs out, or reaches people on the platform
 * (a send, a reaction, an edit, a block, a group membership change).
 */
const NON_DESTRUCTIVE_WRITES = new Set([
  'channels/create', 'channels/update', 'channels/credentials/patch', 'channels/restart',
  'channels/unload', 'channels/request-qr',
  'contacts/create', 'contacts/sync', 'contacts/unblock', 'contacts/update-status',
  'chats/create', 'chats/update', 'chats/sync', 'chats/mute', 'chats/unmute',
  'chats/archive', 'chats/unarchive', 'chats/pin', 'chats/unpin', 'chats/mark-as-read',
  'messages/sync', 'messages/mark-as-read',
]);

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
  if (op.destructive) notes.push('Acts on the real platform account and cannot be undone — confirm with the user first.');
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
      const op = { name: toolName(path), path, kind: 'probe' as const, bytes: false, readOnly: true, destructive: false };
      operations.push({ ...op, summary: describe(op, summary), inputSchema: { type: 'object', properties: {} } });
      continue;
    }

    const content = operation.requestBody?.content ?? {};
    const bodySchema = (content['application/json'] ?? content['multipart/form-data'])?.schema;
    const resolved = bodySchema ? (dereference(bodySchema, components) as JsonSchema) : undefined;
    const verb = path.split('/').pop()!;
    const readOnly = READ_VERBS.has(verb);
    const kind = path === 'messages/send-media' ? ('upload' as const) : ('json' as const);
    const op = {
      name: toolName(path),
      path,
      kind,
      rpc: rpcName(operation.operationId),
      socketEvent: NO_SOCKET_EVENT.has(path) ? undefined : path,
      bytes: BYTE_ROUTES.has(path),
      readOnly,
      destructive: !readOnly && !NON_DESTRUCTIVE_WRITES.has(path),
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
