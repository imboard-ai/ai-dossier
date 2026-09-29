#!/usr/bin/env node
// Build a standalone ai-dossier executable for the HOST platform using Node's
// Single Executable Applications (SEA): esbuild bundles cli/dist/cli.js (with the
// @ai-dossier/* workspace deps and package.json inlined) into one CJS file, Node
// writes a SEA blob from it, and postject injects the blob into a copy of the node
// binary. Requires `make build-all` first and Node >= 22.
//
//   node scripts/build-sea.mjs [--out <dir>]      default: dist-binaries/
//
// Prints the path of the produced binary on the last stdout line.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assetName } from './sea-platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const outDir = path.resolve(
  outIdx > 0 ? process.argv[outIdx + 1] : path.join(root, 'dist-binaries')
);
const work = path.join(outDir, '.work');
mkdirSync(work, { recursive: true });

if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error(`SEA build needs Node >= 22 (running ${process.versions.node})`);
}

const entry = path.join(root, 'cli/dist/cli.js');
try {
  statSync(entry);
} catch {
  throw new Error('cli/dist/cli.js missing — run `make build-all` first');
}

const bundle = path.join(work, 'cli.cjs');
await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'warning',
  legalComments: 'none',
});

const blob = path.join(work, 'sea-prep.blob');
const config = path.join(work, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true })
);
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

const { platform, arch } = process;
const out = path.join(outDir, assetName(platform, arch));
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);

// The copied node binary ships signed on macOS/Windows; the signature must go before
// injection or the result is corrupt.
if (platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
}

const postject = path.join(root, 'node_modules/postject/dist/cli.js');
const args = [
  postject,
  out,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });

// Unsigned Mach-O binaries are killed on Apple Silicon; ad-hoc sign (no Developer ID).
if (platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });
}

const cliVersion = JSON.parse(readFileSync(path.join(root, 'cli/package.json'), 'utf8')).version;
console.error(
  `built ${path.basename(out)} (v${cliVersion}, ${(statSync(out).size / 1048576).toFixed(1)} MiB)`
);
console.log(out);
