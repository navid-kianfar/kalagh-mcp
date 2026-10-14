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
    // The route answers 200 with { error } when no file part arrived.
    if (result && typeof result === 'object' && 'error' in result && !('message' in result)) {
      throw new KalaghError(String((result as { error: unknown }).error), 400);
    }
    return result;
  }

  /**
   * GET /storage/<path> — public, so the key is never sent. A full URL is
   * accepted as found in an attachment; one on another host (a presigned
   * object-store link) is fetched as it is.
   */
  async download(pathOrUrl: string): Promise<Download> {
    const trimmed = pathOrUrl.trim();
    if (!trimmed) throw new KalaghError('path is required', 400);
    const url = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `${this.config.apiUrl}/storage/${trimmed.replace(/^\/+/, '').replace(/^storage\//, '')}`;

    const response = await this.fetch(url, { method: 'GET' });
    if (!response.ok) throw new KalaghError(`GET ${url} answered ${response.status}`, response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    const disposition = response.headers.get('content-disposition') ?? '';
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    const filename = decodeURIComponent(named ?? basename(new URL(url).pathname)) || 'download';
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
