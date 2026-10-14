import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as protoLoader from '@grpc/proto-loader';
import { buildCatalog, type JsonSchema } from '../src/catalog.js';
import { SNAPSHOT_OPENAPI, SNAPSHOT_PROTO } from '../src/document.js';
import { LOADER_OPTIONS, ProtoGapError, ProtoShaper } from '../src/transports/grpc.js';
import { ArgumentValidator, closeObjects } from '../src/validate.js';

const document = JSON.parse(readFileSync(SNAPSHOT_OPENAPI, 'utf8'));
const operations = buildCatalog(document);
const byName = new Map(operations.map((op) => [op.name, op]));
const shaper = new ProtoShaper(protoLoader.loadSync(SNAPSHOT_PROTO, LOADER_OPTIONS));

/** A body made of the document's own `example`s — what the provider's Postman generator sends. */
function exampleOf(schema: JsonSchema): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.type === 'array' && schema.items) return [exampleOf(schema.items as JsonSchema)];
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (!properties) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(properties)) {
    const value = exampleOf(property);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

test('every REST operation becomes a tool, aliases excluded', () => {
  const restPaths = Object.keys(document.paths).filter((p) => p.startsWith('/api/kalagh/'));
  const aliases = ['messages/sync-chat', 'messages/download-media', 'messages/mark-messages-as-read'];
  const expected = restPaths.map((p) => p.slice('/api/kalagh/'.length)).filter((p) => !aliases.includes(p));
  assert.deepEqual(
    operations.filter((op) => op.kind !== 'storage').map((op) => op.path).sort(),
    expected.sort(),
  );
  assert.ok(byName.has('storage_get'), '/storage/{path} is a tool');
  for (const op of operations) assert.match(op.name, /^[a-z0-9_]{1,64}$/, `${op.name} is a valid MCP tool name`);
});

test('each operation names its rpc and its socket event the provider way', () => {
  assert.equal(byName.get('channels_list')?.rpc, 'GetChannels');
  assert.equal(byName.get('channels_request_qr')?.rpc, 'RequestQRCode');
  assert.equal(byName.get('messages_send_poll')?.socketEvent, 'messages/send-poll');
  assert.equal(byName.get('messages_send_media')?.socketEvent, undefined, 'send-media has no socket event');
  assert.equal(byName.get('contacts_get_avatar')?.socketEvent, undefined, 'byte answers have no socket event');
  for (const op of operations.filter((o) => o.kind === 'json')) {
    assert.ok(shaper.method(op.rpc!), `${op.path}: rpc ${op.rpc} exists in the proto`);
  }
});

test('read-only and destructive classification', () => {
  for (const name of ['channels_list', 'messages_list', 'messages_search', 'logs_webhooks', 'health', 'storage_get']) {
    assert.equal(byName.get(name)?.readOnly, true, `${name} is read-only`);
  }
  for (const name of ['messages_send', 'messages_send_media', 'messages_delete', 'channels_delete', 'channels_terminate', 'contacts_block', 'messages_react']) {
    const op = byName.get(name)!;
    assert.equal(op.readOnly, false, `${name} writes`);
    assert.equal(op.destructive, true, `${name} is destructive`);
  }
  for (const name of ['channels_create', 'chats_archive', 'messages_mark_as_read', 'contacts_sync']) {
    assert.equal(byName.get(name)?.destructive, false, `${name} is not destructive`);
  }
});

test('schemas are self-contained — no $ref survives', () => {
  for (const op of operations) assert.doesNotMatch(JSON.stringify(op.inputSchema), /\$ref/, op.name);
});

test('every documented example passes the tool schema', () => {
  const validator = new ArgumentValidator();
  for (const op of operations.filter((o) => o.kind === 'json')) {
    const example = exampleOf(op.inputSchema) ?? {};
    const error = validator.check(op.name, closeObjects(op.inputSchema) as JsonSchema, example);
    assert.equal(error, undefined, `${op.name}: ${error}`);
  }
});

test('unknown fields are refused, as REST refuses them', () => {
  const validator = new ArgumentValidator();
  const op = byName.get('channels_list')!;
  const error = validator.check(op.name, closeObjects(op.inputSchema) as JsonSchema, { page: 1, channelID: 'x' });
  assert.match(error ?? '', /channelID should not exist/);
});

/**
 * Fields REST accepts that the provider's proto cannot carry. A call using one
 * goes over REST even on the gRPC transport. The list is exact, so a NEW gap
 * in the provider fails here instead of quietly changing transports.
 */
const KNOWN_PROTO_GAPS: string[] = [];

test('every documented example shapes into its gRPC request, bar the known gaps', () => {
  const failures: string[] = [];
  for (const op of operations.filter((o) => o.kind === 'json')) {
    const example = (exampleOf(op.inputSchema) ?? {}) as Record<string, unknown>;
    try {
      shaper.shape(op.rpc!, example);
    } catch (error) {
      if (error instanceof ProtoGapError) failures.push(...error.fields.map((field) => `${op.path}: ${field}`));
      else failures.push(`${op.path}: ${(error as Error).message}`);
    }
  }
  assert.deepEqual(failures, KNOWN_PROTO_GAPS);
});

test('free-form objects travel as JSON strings on gRPC', () => {
  const credentials = { proxy: { host: 'h', port: 1 } };
  const shaped = shaper.shape('PatchChannelCredentials', { id: 'c', credentials });
  assert.equal(shaped.credentials, JSON.stringify(credentials));

  const message = shaper.shape('SendMessage', {
    channelId: 'c',
    chatId: 'x',
    content: { type: 1, message: 'hi', metadata: { email: { subject: 's' } } },
  });
  assert.equal((message.content as Record<string, unknown>).metadata, '{"email":{"subject":"s"}}');
});

test('a field the proto does not carry is refused, not dropped', () => {
  assert.throws(() => shaper.shape('GetChannels', { page: 1, nope: true }), /property nope has no counterpart in gRPC GetChannelsRequest/);
});
