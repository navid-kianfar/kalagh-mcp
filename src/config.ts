import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TransportKind = 'http' | 'ws' | 'grpc';

export interface Config {
  /** Which transport carries the operations. */
  transport: TransportKind;
  /** REST base, e.g. https://kalagh.smg.tr — always required (OpenAPI, /storage, HTTP-only routes). */
  apiUrl: string;
  /** Socket.IO URL, e.g. https://kalagh-ws.smg.tr — required for `ws`, optional otherwise. */
  wsUrl?: string;
  /** gRPC target host:port, e.g. kalagh-grpc.smg.tr:443 — required for `grpc`, optional otherwise. */
  grpcUrl?: string;
  /** TLS on the gRPC channel: on unless asked off (`grpc://`, KALAGH_GRPC_TLS=false) or the host is loopback. */
  grpcTls: boolean;
  apiKey: string;
  /** Expose only the tools that change nothing. */
  readOnly: boolean;
  /**
   * Origins storage_get may download from besides the provider's own: the
   * object store a presigned attachment URL points at. Nothing else is fetched.
   */
  storageOrigins: string[];
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

/**
 * TLS is the default: the key travels in the call metadata, so a plaintext
 * channel would carry it in the clear. Plaintext only when asked for — the
 * `grpc://` scheme or KALAGH_GRPC_TLS=false — or for a loopback host (a provider
 * started from source listens in plaintext on localhost:4002). `grpcs://` and
 * KALAGH_GRPC_TLS=true force it on.
 */
export function grpcTlsFor(target: string | undefined, scheme: string | undefined, setting: string | undefined): boolean {
  if (setting !== undefined) return truthy(setting);
  if (scheme === 'grpcs') return true;
  if (scheme === 'grpc') return false;
  const address = target ?? '';
  // [::1]:4002 → ::1; ::1 (a bare IPv6 address) stays whole; host:port → host.
  const host = address.startsWith('[')
    ? address.slice(1, address.indexOf(']'))
    : address.split(':').length > 2 ? address : address.replace(/:\d+$/, '');
  return !/^(localhost|127(\.\d+){3}|::1)$/i.test(host);
}

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
  const grpcSetting = env('KALAGH_GRPC_URL');
  const grpcScheme = /^(grpcs?):\/\//i.exec(grpcSetting ?? '')?.[1]?.toLowerCase();
  const grpcUrl = grpcSetting?.replace(/^grpcs?:\/\//i, '').replace(/\/+$/, '');
  if (transport === 'ws' && !wsUrl) throw new Error('KALAGH_TRANSPORT=ws needs KALAGH_WS_URL');
  if (transport === 'grpc' && !grpcUrl) throw new Error('KALAGH_TRANSPORT=grpc needs KALAGH_GRPC_URL');

  const tlsSetting = env('KALAGH_GRPC_TLS');
  const storageOrigins = (env('KALAGH_STORAGE_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        throw new Error(`KALAGH_STORAGE_ORIGINS: "${origin}" is not an origin such as https://files.example.com`);
      }
    });
  const timeout = Number(env('KALAGH_TIMEOUT_MS') ?? 60_000);

  return {
    transport,
    apiUrl: apiUrl!.replace(/\/+$/, ''),
    wsUrl: wsUrl?.replace(/\/+$/, ''),
    grpcUrl,
    grpcTls: grpcTlsFor(grpcUrl, grpcScheme, tlsSetting),
    storageOrigins,
    apiKey: apiKey!,
    readOnly: truthy(env('KALAGH_READ_ONLY')),
    downloadDir: env('KALAGH_DOWNLOAD_DIR') ?? join(tmpdir(), 'kalagh-mcp'),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
  };
}
