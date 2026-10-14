import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Download } from './transports/http.js';

export type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** Images larger than this are saved to disk but not attached inline. */
const INLINE_IMAGE_LIMIT = 4 * 1024 * 1024;

const STREAM_NOTE =
  '[a byte stream an older provider serialised into JSON — download the answer’s storagePath with storage_get, or use KALAGH_TRANSPORT=grpc]';

const isDownload = (value: unknown): value is Download =>
  !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'download' && Buffer.isBuffer((value as Download).bytes);

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

/** A Node Readable that a REST route serialised into JSON. */
const isSerialisedStream = (value: unknown): boolean =>
  !!value && typeof value === 'object' && ('_readableState' in value || '_events' in value);

const safeName = (name: string): string => basename(name).replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'download';

/**
 * Turns a provider answer into MCP content:
 *  - bytes (a gRPC avatar or media answer, a `/storage` download) are written
 *    to the download directory and replaced by the file's path;
 *  - an inline `data:image/...;base64,` string (a pairing QR code) is attached
 *    as an image, so the client can show it to be scanned;
 *  - everything else is the provider's JSON, unchanged.
 */
export class OutputWriter {
  constructor(private readonly downloadDir: string) {}

  async render(value: unknown): Promise<Content[]> {
    const images: Content[] = [];
    const body = isDownload(value)
      ? await this.saveDownload(value, images)
      : await this.walk(value, images, undefined);
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    return [{ type: 'text', text: text ?? 'null' }, ...images];
  }

  private async saveDownload(download: Download, images: Content[]): Promise<unknown> {
    const savedTo = await this.save(download.bytes, download.filename);
    this.attachImage(download.bytes, download.mimeType, images);
    return { savedTo, bytes: download.bytes.length, mimeType: download.mimeType, filename: download.filename };
  }

  private async walk(value: unknown, images: Content[], siblings: Record<string, unknown> | undefined): Promise<unknown> {
    if (isDownload(value)) return this.saveDownload(value, images);
    if (isBytes(value)) {
      if (value.length === 0) return null;
      const mimeType = typeof siblings?.mimeType === 'string' ? siblings.mimeType : 'application/octet-stream';
      const filename = typeof siblings?.filename === 'string' ? siblings.filename : 'download';
      const bytes = Buffer.from(value);
      this.attachImage(bytes, mimeType, images);
      return { savedTo: await this.save(bytes, filename), bytes: bytes.length };
    }
    if (typeof value === 'string') {
      const image = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(value);
      if (image && image[2]!.length <= (INLINE_IMAGE_LIMIT * 4) / 3) {
        images.push({ type: 'image', mimeType: image[1]!, data: image[2]! });
        return `[${image[1]} attached as image #${images.length}]`;
      }
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.walk(item, images, undefined)));
    if (value && typeof value === 'object') {
      if (isSerialisedStream(value)) return STREAM_NOTE;
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(record)) out[key] = await this.walk(item, images, record);
      return out;
    }
    return value;
  }

  private attachImage(bytes: Buffer, mimeType: string, images: Content[]): void {
    if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml' && bytes.length <= INLINE_IMAGE_LIMIT) {
      images.push({ type: 'image', mimeType, data: bytes.toString('base64') });
    }
  }

  private async save(bytes: Buffer, filename: string): Promise<string> {
    await mkdir(this.downloadDir, { recursive: true });
    const path = join(this.downloadDir, `${Date.now()}-${safeName(filename)}`);
    await writeFile(path, bytes);
    return path;
  }
}
