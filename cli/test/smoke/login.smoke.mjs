#!/usr/bin/env node
// Standalone smoke test: drives `ai-dossier login` end-to-end through a piped
// stdin, asserting the process exits cleanly within a short timeout. This is
// the regression guard for PR #386 (login hung after success because readline
// kept stdin referenced) and any future process-exit regressions in the
// success path.
//
// Usage: node login.smoke.mjs <path-to-ai-dossier-binary>
//
// Run from CI against an unpacked tarball, or locally against ./cli/bin/ai-dossier.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BIN = process.argv[2];
if (!BIN) {
  console.error('Usage: node login.smoke.mjs <path-to-ai-dossier-binary>');
  process.exit(2);
}

// Import the prompt constant from the same package the binary belongs to so
// the marker stays in sync with the production string. Use a package
// specifier rather than a relative path so it resolves regardless of whether
// the binary is a workspace file (`cli/bin/ai-dossier`) or an installed
// symlink (`node_modules/.bin/ai-dossier` → `@ai-dossier/cli/bin/...`).
const requireFromBin = createRequire(path.resolve(BIN));
const { LOGIN_CODE_PROMPT } = requireFromBin('@ai-dossier/cli/dist/oauth.js');
if (typeof LOGIN_CODE_PROMPT !== 'string') {
  console.error('FAIL: could not load LOGIN_CODE_PROMPT from CLI build');
  process.exit(2);
}

const TIMEOUT_MS = 8000;

// Hand-roll a fixture JWT. The CLI decodes but does NOT verify the signature,
// so any string in the signature segment works. Outer base64url wrap matches
// the wire format the registry hands to the user.
function makeFixtureCode() {
  const payload = {
    sub: 'smoke-test-user',
    orgs: ['smoke-org'],
    exp: Math.floor(Date.now() / 1000) + 86400, // +1 day
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `header.${encoded}.sig`;
  return Buffer.from(token).toString('base64url');
}

// Isolate $HOME so saveCredentials writes to a tempdir, not the runner's home.
const fakeHome = mkdtempSync(path.join(tmpdir(), 'ai-dossier-smoke-'));

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// Make sure the tempdir is reaped on any exit path — including SIGINT/SIGTERM
// (CI cancels) and uncaught exceptions. process.on('exit') runs synchronously.
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  cleanup();
  process.exit(1);
});

const child = spawn(process.execPath, [BIN, 'login'], {
  env: {
    ...process.env,
    HOME: fakeHome,
    // Bypass the non-interactive guard so the CLI accepts the piped stdin.
    DOSSIER_LOGIN_ALLOW_NONINTERACTIVE: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
let promptSeen = false;
let timedOut = false;

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`FAIL: timeout after ${TIMEOUT_MS}ms`);
  console.error(`  stderr so far: ${JSON.stringify(stderrBuf.slice(-200))}`);
  child.kill('SIGKILL');
  process.exit(1);
}, TIMEOUT_MS);

child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
  if (!promptSeen && stderrBuf.includes(LOGIN_CODE_PROMPT)) {
    promptSeen = true;
    child.stdin.write(`${makeFixtureCode()}\n`);
    child.stdin.end();
  }
});

child.stdout.on('data', () => {
  /* drain */
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) return; // already reported
  if (signal) {
    console.error(`FAIL: child killed by signal ${signal}`);
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`FAIL: exit code ${code}`);
    console.error(`  stderr: ${stderrBuf}`);
    process.exit(1);
  }
  if (!promptSeen) {
    console.error('FAIL: child exited 0 but the login prompt was never seen');
    process.exit(1);
  }
  console.log('PASS: ai-dossier login exited cleanly within timeout');
});
