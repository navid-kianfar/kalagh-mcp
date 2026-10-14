import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Config } from '../config.js';
import type { Operation } from '../catalog.js';
import { KalaghError, type Transport } from './transport.js';

/** What a byte-returning HTTP call resolves to; the output layer writes it to a file. */
export interface Download {
  kind: 'download';
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

export interface UploadFile {
  path: string;
  filename?: string;
  mimeType?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.3gp': 'video/3gpp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const guessMimeType = (path: string): string =>
  MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';

/**
 * REST: POST /api/kalagh/<path> with a JSON body, the key in `x-api-key`.
 *
 * This is also the carrier of last resort for the other two transports: the
 * health/info probes, `/storage/*` and the multipart upload exist only here.
 */
export class HttpTransport implements Transport {
  readonly kind = 'http' as const;

  constructor(private readonly config: Config) {}

  async call(op: Operation, args: Record<string, unknown>): Promise<unknown> {
    switch (op.kind) {
      case 'probe':
        return this.request('GET', `/api/kalagh/${op.path}`);
      case 'storage':
        return this.download(String(args.path ?? ''));
      case 'upload':
        return this.upload(args);
      default:
        return this.request('POST', `/api/kalagh/${op.path}`, args);
    }
  }

  async close(): Promise<void> {}

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        'x-api-key': this.config.apiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse(response);
  }

  /** messages/send-media: one multipart request, every file as a repeated `files` part. */
  private async upload(args: Record<string, unknown>): Promise<unknown> {
    const { files, metadata, ...fields } = args as { files?: UploadFile[]; metadata?: unknown } & Record<string, unknown>;
    if (!Array.isArray(files) || files.length === 0) throw new KalaghError('files: at least one file is required', 400);

    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    if (metadata !== undefined && metadata !== null) {
      form.append('metadata', typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    }
    for (const file of files) {
      const info = await stat(file.path).catch(() => undefined);
      if (!info?.isFile()) throw new KalaghError(`Not a readable file: ${file.path}`, 400);
      const bytes = await readFile(file.path);
      const type = file.mimeType || guessMimeType(file.path);
      form.append('files', new Blob([bytes], { type }), file.filename || basename(file.path));
    }

    const response = await this.fetch(`${this.config.apiUrl}/api/kalagh/messages/send-media`, {
      method: 'POST',
      headers: { 'x-api-key': this.config.apiKey },
      body: form,
    });
    const result = await this.parse(response);
    // A provider built before the route threw BadRequestException answered 200
    // with { error } when no file part arrived; still in service, so still caught.
    if (result && typeof result === 'object' && 'error' in result && !('message' in result)) {
      throw new KalaghError(String((result as { error: unknown }).error), 400);
    }
    return result;
  }

  /**
   * GET /storage/<path> — public, so the key is never sent. A full URL is
   * accepted as found in an attachment, but only on the provider's own origin
   * or one listed in KALAGH_STORAGE_ORIGINS (the object store a presigned link
   * points at): the path can come from a stranger's message, and this must
   * never become a way to make the host fetch arbitrary addresses.
   */
  async download(pathOrUrl: string): Promise<Download> {
    const url = resolveStorageUrl(pathOrUrl, this.config.apiUrl, this.config.storageOrigins);
    const response = await this.fetch(url, { method: 'GET', redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new KalaghError(`GET ${url} redirected to ${response.headers.get('location') ?? 'elsewhere'}; redirects are not followed`, response.status);
    }
    if (!response.ok) throw new KalaghError(`GET ${url} answered ${response.status}`, response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    const filename = filenameFrom(response.headers.get('content-disposition'), url);
    return { kind: 'download', bytes, mimeType: response.headers.get('content-type') ?? guessMimeType(filename), filename };
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new KalaghError(`Cannot reach ${new URL(url).origin}: ${reason}`);
    }
  }

  private async parse(response: Response): Promise<unknown> {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // not JSON — keep the text
    }
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : typeof body === 'string' && body
            ? body.slice(0, 500)
            : response.statusText;
      throw new KalaghError(message, response.status);
    }
    return body;
  }
}

/**
 * A storage path (`media/…`, `/storage/media/…`) or a full URL → the URL to
 * fetch. A full URL must be on the provider's origin or an allowed one.
 */
export function resolveStorageUrl(pathOrUrl: string, apiUrl: string, allowedOrigins: string[] = []): string {
  const trimmed = pathOrUrl.trim();
  if (!trimmed) throw new KalaghError('path is required', 400);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const key = trimmed.replace(/^\/+/, '').replace(/^storage\//, '');
    return `${apiUrl}/storage/${key}`;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new KalaghError(`Not a URL: ${trimmed}`, 400);
  }
  const allowed = new Set([new URL(apiUrl).origin, ...allowedOrigins]);
  if (!allowed.has(url.origin)) {
    throw new KalaghError(
      `${url.origin} is not the provider (${new URL(apiUrl).origin}); add it to KALAGH_STORAGE_ORIGINS if it is the provider's object store`,
      400,
    );
  }
  return url.toString();
}

/**
 * The name to save a download under: `filename*` (RFC 5987, percent-encoded)
 * when present, else `filename` taken literally, else the URL's last segment.
 * A malformed percent-escape keeps the raw text instead of failing a download
 * that already arrived ("Discount 50%.pdf").
 */
export function filenameFrom(disposition: string | null, url: string): string {
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const extended = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(disposition ?? '')?.[1];
  if (extended) return decode(extended.trim().replace(/^"|"$/g, '')) || 'download';
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(disposition ?? '');
  const named = plain?.[1] ?? plain?.[2]?.trim();
  if (named) return named;
  return decode(basename(new URL(url).pathname)) || 'download';
}
