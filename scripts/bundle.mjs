#!/usr/bin/env node
/**
 * Lays out bundle/ for `mcpb pack`: the server as ONE JavaScript file (no
 * node_modules to ship), the schema snapshots beside it, and the manifest.
 *
 *   bundle/
 *     manifest.json
 *     server/index.js      ← esbuild of src/index.ts
 *     schema/openapi.json  ← found at ../schema from server/, as from dist/
 *     schema/kalagh.proto
 *     LICENSE
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'bundle');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'server'), { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(out, 'server', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  legalComments: 'none',
  // grpc-js, proto-loader and socket.io-client are CommonJS and call require().
  banner: { js: "import { createRequire as __kalaghRequire } from 'node:module'; const require = __kalaghRequire(import.meta.url);" },
  logLevel: 'warning',
});

cpSync(join(root, 'schema'), join(out, 'schema'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

// The manifest's version follows package.json, so the two cannot drift.
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`bundle/ ready (v${pkg.version})`);
