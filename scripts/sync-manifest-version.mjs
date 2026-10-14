#!/usr/bin/env node
/**
 * npm's `version` lifecycle hook: `npm version <patch|minor|major>` bumps
 * package.json, runs this to give manifest.json the same version, stages it,
 * then commits both and tags vX.Y.Z — so the tag, package.json and the Claude
 * Desktop manifest can never disagree (the release workflow checks all three).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const path = join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(path, 'utf8'));
manifest.version = version;
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json → ${version}`);
