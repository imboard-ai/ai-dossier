#!/usr/bin/env node
// Smoke-test a built standalone binary: `--version` must print cli/package.json's
// version. Runs the binary with an empty PATH-less env so a Node install cannot mask
// a broken bundle.
//
//   node scripts/smoke-binary.mjs <binary> [expected-version]

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionMatches } from './sea-platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.resolve(process.argv[2] ?? '');
const expected =
  process.argv[3] ?? JSON.parse(readFileSync(path.join(root, 'cli/package.json'), 'utf8')).version;

const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
const out = execFileSync(binary, ['--version'], { env, encoding: 'utf8' });
if (!versionMatches(out, expected)) {
  console.error(`smoke FAILED: ${binary} printed ${JSON.stringify(out)}, expected ${expected}`);
  process.exit(1);
}
execFileSync(binary, ['--help'], { env, stdio: 'ignore' });
console.log(`smoke ok: ${path.basename(binary)} ${expected}`);
