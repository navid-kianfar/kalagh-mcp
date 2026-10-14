import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TransportKind = 'http' | 'ws' | 'grpc';

export interface Config {
  /** Which transport carries the operations. */
  transport: TransportKind;
  /** REST base, e.g. https://kalagh.smg.tr — always required (OpenAPI, /storage, HTTP-only routes). */
  apiUrl: string;
  /** Socket.IO URL, e.g. https://kalagh-ws.sng.tr — required for `ws`, optional otherwise. */
  wsUrl?: string;
  /** gRPC target host:port, e.g. kalagh-grpc.sng.tr:443 — required for `grpc`, optional otherwise. */
  grpcUrl?: string;
  /** TLS on the gRPC channel. Defaults to on for port 443. */
  grpcTls: boolean;
  apiKey: string;
  /** Expose only the tools that change nothing. */
  readOnly: boolean;
  /** Where downloaded bytes (avatars, media, storage objects) are written. */
  downloadDir: string;
  /** Per-call timeout. */
  timeoutMs: number;
}

const truthy = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? '').trim());

/**
 * An env var, or undefined when it is unset, blank, or an unfilled Claude
 * Desktop placeholder (`${user_config.ws_url}` for an optional field the user
 * left empty).
 */
const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value && !/^\$\{user_config\.\w+\}$/.test(value) ? value : undefined;
};

export function loadConfig(): Config {
  const apiUrl = env('KALAGH_API_URL');
  const apiKey = env('KALAGH_API_KEY');
  const missing = [!apiUrl && 'KALAGH_API_URL', !apiKey && 'KALAGH_API_KEY'].filter(Boolean);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);

  const transport = (env('KALAGH_TRANSPORT') ?? 'http').toLowerCase();
  if (transport !== 'http' && transport !== 'ws' && transport !== 'grpc') {
    throw new Error(`KALAGH_TRANSPORT must be http, ws or grpc (got "${transport}")`);
  }
  const wsUrl = env('KALAGH_WS_URL');
  const grpcUrl = env('KALAGH_GRPC_URL')?.replace(/^grpcs?:\/\//, '');
  if (transport === 'ws' && !wsUrl) throw new Error('KALAGH_TRANSPORT=ws needs KALAGH_WS_URL');
  if (transport === 'grpc' && !grpcUrl) throw new Error('KALAGH_TRANSPORT=grpc needs KALAGH_GRPC_URL');

  const tlsSetting = env('KALAGH_GRPC_TLS');
  const timeout = Number(env('KALAGH_TIMEOUT_MS') ?? 60_000);

  return {
    transport,
    apiUrl: apiUrl!.replace(/\/+$/, ''),
    wsUrl: wsUrl?.replace(/\/+$/, ''),
    grpcUrl,
    grpcTls: tlsSetting !== undefined ? truthy(tlsSetting) : /:443$/.test(grpcUrl ?? ''),
    apiKey: apiKey!,
    readOnly: truthy(env('KALAGH_READ_ONLY')),
    downloadDir: env('KALAGH_DOWNLOAD_DIR') ?? join(tmpdir(), 'kalagh-mcp'),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
  };
}
