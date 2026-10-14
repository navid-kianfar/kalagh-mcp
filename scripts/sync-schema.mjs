#!/usr/bin/env node
/**
 * Copies the provider's OpenAPI document and proto from a kalagh checkout into
 * schema/ — the snapshot the server falls back to when the running provider's
 * /api/docs-json cannot be read, and the proto the gRPC transport speaks.
 *
 *   pnpm sync-schema                      from ../kalagh
 *   pnpm sync-schema /path/to/kalagh      from another checkout
 *   pnpm sync-schema --check              exit 1 when schema/ is behind
 *
 * In kalagh, regenerate the document first when the controllers or DTOs
 * changed: `pnpm --filter @kalagh/core postman:generate`.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const repo = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(here, '..', '..', 'kalagh'));

const files = [
  [join(repo, 'providers', 'docs', 'openapi.json'), join(here, '..', 'schema', 'openapi.json')],
  [join(repo, 'providers', 'packages', 'core', 'proto', 'kalagh.proto'), join(here, '..', 'schema', 'kalagh.proto')],
];

const stale = [];
for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.error(`Not found: ${from} — is ${repo} a kalagh checkout?`);
    process.exit(1);
  }
  const changed = !existsSync(to) || readFileSync(from, 'utf8') !== readFileSync(to, 'utf8');
  if (!changed) continue;
  if (check) stale.push(to);
  else {
    copyFileSync(from, to);
    console.log(`updated ${to}`);
  }
}
if (check && stale.length) {
  console.error(`schema/ is behind ${repo}:\n  ${stale.join('\n  ')}\nRun \`pnpm sync-schema\`.`);
  process.exit(1);
}
console.log(check ? 'schema/ is up to date.' : 'done.');
