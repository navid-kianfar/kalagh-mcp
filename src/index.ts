#!/usr/bin/env node
/**
 * kalagh-mcp — an MCP server over one Kalagh provider.
 *
 * Configuration is environment only (see README.md):
 *   KALAGH_API_URL     REST base, e.g. https://kalagh.smg.tr                (required)
 *   KALAGH_API_KEY     the provider's API_KEY                               (required)
 *   KALAGH_TRANSPORT   http | ws | grpc                                    (default http)
 *   KALAGH_WS_URL      Socket.IO URL, e.g. https://kalagh-ws.sng.tr         (ws; enables events)
 *   KALAGH_GRPC_URL    host:port, e.g. kalagh-grpc.sng.tr:443               (grpc; enables events)
 *   KALAGH_GRPC_TLS    true | false                                        (default: true on :443)
 *   KALAGH_READ_ONLY   true exposes only the tools that change nothing
 *   KALAGH_DOWNLOAD_DIR where avatars, media and storage downloads are written
 *   KALAGH_TIMEOUT_MS  per-call timeout                                    (default 60000)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type Config } from './config.js';
import { loadCatalog, SNAPSHOT_PROTO } from './document.js';
import { EventBuffer } from './events.js';
import { createServer } from './server.js';
import { HttpTransport } from './transports/http.js';
import { GrpcConnection, GrpcEventSource, GrpcTransport } from './transports/grpc.js';
import { SocketConnection, WsEventSource, WsTransport } from './transports/ws.js';
import type { EventSource, Transport } from './transports/transport.js';

function wire(config: Config): { transport: Transport; http: HttpTransport; eventSource?: EventSource } {
  const http = new HttpTransport(config);
  const socket = config.wsUrl ? new SocketConnection(config) : undefined;
  const grpc = config.grpcUrl ? new GrpcConnection(config, SNAPSHOT_PROTO) : undefined;

  const transport =
    config.transport === 'ws' ? new WsTransport(config, socket!, http)
    : config.transport === 'grpc' ? new GrpcTransport(config, grpc!, http)
    : http;

  // Events come from the socket whenever one is configured (the gateway
  // broadcasts every signal), else from gRPC StreamEvents. Plain REST has no
  // stream, so with neither URL there are no events.
  const eventSource = socket ? new WsEventSource(socket) : grpc ? new GrpcEventSource(grpc) : undefined;

  return { transport, http, eventSource };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const catalog = await loadCatalog(config);
  const { transport, http, eventSource } = wire(config);

  const buffer = new EventBuffer();
  eventSource?.subscribe((event) => buffer.push(event));

  const server = createServer({
    config,
    catalog,
    transport,
    http,
    events: eventSource ? { source: eventSource, buffer } : undefined,
  });

  console.error(
    `[kalagh-mcp] ${config.apiUrl} over ${config.transport}; ${catalog.operations.length} operations from the ${catalog.source} document` +
      (catalog.liveError ? ` (live document unavailable: ${catalog.liveError})` : '') +
      (eventSource ? `; events via ${eventSource.kind}` : ''),
  );

  const shutdown = async () => {
    await Promise.allSettled([transport.close(), eventSource?.close()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`[kalagh-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
