import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grpcTlsFor, loadConfig } from '../src/config.js';
import { filenameFrom, resolveStorageUrl } from '../src/transports/http.js';

test('gRPC TLS is on unless asked off or the host is loopback', () => {
  assert.equal(grpcTlsFor('kalagh-grpc.smg.tr:443', undefined, undefined), true);
  assert.equal(grpcTlsFor('kalagh-grpc.smg.tr', undefined, undefined), true);
  assert.equal(grpcTlsFor('grpc.example.com:50051', undefined, undefined), true, 'TLS on a non-443 port too');
  assert.equal(grpcTlsFor('kalagh-grpc.smg.tr', 'grpcs', undefined), true);
  assert.equal(grpcTlsFor('grpc.example.com:50051', 'grpc', undefined), false, 'grpc:// asks for plaintext');
  assert.equal(grpcTlsFor('localhost:4002', undefined, undefined), false);
  assert.equal(grpcTlsFor('127.0.0.1:4002', undefined, undefined), false);
  assert.equal(grpcTlsFor('[::1]:4002', undefined, undefined), false);
  assert.equal(grpcTlsFor('::1', undefined, undefined), false);
  assert.equal(grpcTlsFor('localhost:4002', undefined, 'true'), true, 'KALAGH_GRPC_TLS wins');
  assert.equal(grpcTlsFor('kalagh-grpc.smg.tr:443', 'grpcs', 'false'), false, 'KALAGH_GRPC_TLS wins');
});

test('loadConfig honours the gRPC scheme instead of discarding it', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { KALAGH_API_URL: 'https://p.example', KALAGH_API_KEY: 'k', KALAGH_GRPC_URL: 'grpcs://g.example:8443' });
    delete process.env.KALAGH_GRPC_TLS;
    let config = loadConfig();
    assert.equal(config.grpcUrl, 'g.example:8443');
    assert.equal(config.grpcTls, true);
    process.env.KALAGH_GRPC_URL = 'grpc://g.example:8443';
    config = loadConfig();
    assert.equal(config.grpcTls, false);
    process.env.KALAGH_STORAGE_ORIGINS = 'https://files.example.com/some/path, https://cdn.example.com';
    assert.deepEqual(loadConfig().storageOrigins, ['https://files.example.com', 'https://cdn.example.com']);
  } finally {
    process.env = saved;
  }
});

test('storage_get only fetches from the provider or an allowed origin', () => {
  const api = 'https://kalagh.smg.tr';
  assert.equal(resolveStorageUrl('media/c/x/p.jpg', api), 'https://kalagh.smg.tr/storage/media/c/x/p.jpg');
  assert.equal(resolveStorageUrl('/storage/media/p.jpg', api), 'https://kalagh.smg.tr/storage/media/p.jpg');
  assert.equal(resolveStorageUrl('https://kalagh.smg.tr/storage/media/p.jpg', api), 'https://kalagh.smg.tr/storage/media/p.jpg');
  assert.equal(
    resolveStorageUrl('https://files.example.com/b/p.jpg?X-Amz-Signature=s', api, ['https://files.example.com']),
    'https://files.example.com/b/p.jpg?X-Amz-Signature=s',
  );
  for (const hostile of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:9200/_search',
    'https://kalagh.smg.tr.evil.example/storage/x',
    'http://kalagh.smg.tr/storage/x', // another scheme is another origin
    'file:///etc/passwd',
  ]) {
    assert.throws(() => resolveStorageUrl(hostile, api), /not the provider|Not a URL/, hostile);
  }
  assert.throws(() => resolveStorageUrl('   ', api), /path is required/);
});

test('a download keeps a name with a literal % instead of failing', () => {
  const url = 'https://kalagh.smg.tr/storage/media/x';
  assert.equal(filenameFrom('attachment; filename="Discount 50%.pdf"', url), 'Discount 50%.pdf');
  assert.equal(filenameFrom("attachment; filename*=UTF-8''Oferta%20100%25.pdf", url), 'Oferta 100%.pdf');
  assert.equal(filenameFrom("attachment; filename*=UTF-8''broken%zz.pdf", url), 'broken%zz.pdf');
  assert.equal(filenameFrom('attachment; filename=plain.pdf', url), 'plain.pdf');
  assert.equal(filenameFrom(null, 'https://kalagh.smg.tr/storage/media/photo%201.jpg'), 'photo 1.jpg');
  assert.equal(filenameFrom(null, 'https://kalagh.smg.tr/storage/media/50%.jpg'), '50%.jpg');
});
