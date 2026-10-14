import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { buildCatalog, hasSchemas, summariesOf, type Operation } from './catalog.js';

/** The snapshots this package ships, synced from the kalagh repo by `pnpm sync-schema`. */
export const SNAPSHOT_OPENAPI = fileURLToPath(new URL('../schema/openapi.json', import.meta.url));
export const SNAPSHOT_PROTO = fileURLToPath(new URL('../schema/kalagh.proto', import.meta.url));

export interface LoadedCatalog {
  operations: Operation[];
  /** Where the tool schemas came from. */
  source: 'live' | 'snapshot';
  /** Why the live document was not used, when it was not. */
  liveError?: string;
}

/**
 * The tools come from the RUNNING provider's own document whenever it can be
 * read, so they describe exactly the API that will answer — a newer or older
 * provider, or another platform's. The bundled snapshot is the fallback when
 * the provider is unreachable at startup; the tools still list, and a call
 * reports the connection error.
 */
export async function loadCatalog(config: Config): Promise<LoadedCatalog> {
  let liveError: string;
  try {
    const response = await fetch(`${config.apiUrl}/api/docs-json`, {
      headers: { 'x-api-key': config.apiKey },
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10_000)),
    });
    if (!response.ok) throw new Error(`GET /api/docs-json answered ${response.status}`);
    const live = await response.json();
    if (!hasSchemas(live)) throw new Error('the live document carries no schemas');
    // An older provider's document has no summaries; the snapshot's fill them
    // in when it can be read — it is never needed for the tools themselves.
    let summaries = new Map<string, string>();
    try {
      summaries = summariesOf(readSnapshot());
    } catch (error) {
      console.error(`[kalagh-mcp] bundled snapshot unreadable, summaries come from the live document only: ${reason(error)}`);
    }
    return { operations: buildCatalog(live, summaries), source: 'live' };
  } catch (error) {
    liveError = reason(error);
  }
  // Only the fallback needs the snapshot, so only the fallback reads it.
  try {
    return { operations: buildCatalog(readSnapshot()), source: 'snapshot', liveError };
  } catch (error) {
    throw new Error(`No tool schemas: the live document failed (${liveError}) and the bundled snapshot failed (${reason(error)})`);
  }
}

const readSnapshot = () => JSON.parse(readFileSync(SNAPSHOT_OPENAPI, 'utf8'));

const reason = (error: unknown): string =>
  error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
