import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBuffer } from '../src/events.js';
import { OutputWriter } from '../src/output.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a QR data URL is attached as an image', async () => {
  const writer = new OutputWriter(mkdtempSync(join(tmpdir(), 'kalagh-mcp-test-')));
  const [text, image] = await writer.render({ channelId: 'c', qrCode: `data:image/png;base64,${PNG_1PX}` });
  assert.equal(image?.type, 'image');
  assert.equal(image?.type === 'image' && image.mimeType, 'image/png');
  assert.match(text?.type === 'text' ? text.text : '', /image\/png attached as image #1/);
});

test('bytes are written to a file and replaced by its path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kalagh-mcp-test-'));
  const writer = new OutputWriter(dir);
  const [text] = await writer.render({ mediaData: Buffer.from('hello'), mimeType: 'text/plain', filename: 'a.txt' });
  const body = JSON.parse(text?.type === 'text' ? text.text : '{}');
  assert.equal(body.mediaData.bytes, 5);
  assert.equal(readFileSync(body.mediaData.savedTo, 'utf8'), 'hello');
});

test('a Readable serialised into JSON is explained, not dumped', async () => {
  const writer = new OutputWriter(mkdtempSync(join(tmpdir(), 'kalagh-mcp-test-')));
  const [text] = await writer.render({ stream: { _readableState: {}, _events: {} }, mimeType: 'image/jpeg' });
  assert.match(text?.type === 'text' ? text.text : '', /storage_get/);
});

test('events filter by channel and name prefix, and resume after a seq', async () => {
  const buffer = new EventBuffer(3);
  buffer.push({ eventName: 'message.received', channelId: 'a', data: 1, timestamp: 1 });
  buffer.push({ eventName: 'chat.updated', channelId: 'a', data: 2, timestamp: 2 });
  buffer.push({ eventName: 'message.status', channelId: 'b', data: 3, timestamp: 3 });
  buffer.push({ eventName: 'message.received', channelId: 'a', data: 4, timestamp: 4 });
  assert.equal(buffer.size, 3, 'capacity is kept');
  assert.deepEqual((await buffer.query({ eventName: 'message.*' })).map((e) => e.data), [3, 4]);
  assert.deepEqual((await buffer.query({ channelId: 'a', afterSeq: 2 })).map((e) => e.data), [4]);
});

test('waitSeconds resolves on the next matching event', async () => {
  const buffer = new EventBuffer();
  const waiting = buffer.query({ eventName: 'channel.connected', waitSeconds: 5 });
  setTimeout(() => buffer.push({ eventName: 'channel.connected', channelId: 'a', data: {}, timestamp: 1 }), 20);
  const started = Date.now();
  const found = await waiting;
  assert.equal(found.length, 1);
  assert.ok(Date.now() - started < 2000);
});

test('a file descriptor (or an old stream answer) naming its storagePath gets the stored file', async () => {
  const { withStoredBytes } = await import('../src/server.js');
  const requested: string[] = [];
  const http = {
    download: async (path: string) => {
      requested.push(path);
      return { kind: 'download' as const, bytes: Buffer.from('jpeg'), mimeType: 'image/jpeg', filename: 'p.jpg' };
    },
  } as unknown as import('../src/transports/http.js').HttpTransport;

  const fetched = (await withStoredBytes({ stream: { _readableState: {} }, mimeType: 'image/jpeg', filename: 'Holiday.jpg', storagePath: 'media/c/x/p.jpg' }, http)) as Record<string, unknown>;
  assert.deepEqual(requested, ['media/c/x/p.jpg']);
  assert.equal('stream' in fetched, false, 'the serialised stream is dropped');
  assert.equal((fetched.file as { bytes: Buffer }).bytes.toString(), 'jpeg');
  assert.equal((fetched.file as { filename: string }).filename, 'Holiday.jpg', 'the descriptor names the file');

  const inBand = { mediaData: Buffer.from('x'), storagePath: 'media/c/x/p.jpg' };
  assert.equal(await withStoredBytes(inBand, http), inBand, 'bytes already in the answer are not fetched again');
});
