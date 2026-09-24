/**
 * The `cap run` outcome-envelope channel (#811).
 *
 * `ai-dossier cap run <id>` reports its four-way outcome as a JSON envelope.
 * Machine consumers (the batch suite runner, the per-member gate runner) used
 * to read only stdout's LAST line — which silently failed when that line was
 * not the envelope:
 *
 *   - `cap run` re-emits the capability's captured output and then exited
 *     with `process.exit()` while a large stdout write was still queued on the
 *     pipe; the tail (envelope included) was discarded. A green 33-minute
 *     `gate.batch` came back as exit 0 + no envelope → `suite-unreadable`.
 *   - anything that inherited the same stdout and wrote after `cap run`
 *     printed its envelope pushed the envelope off the last line.
 *
 * The fix is a dedicated channel: the consumer hands `cap run` a private file
 * path via {@link CAP_ENVELOPE_FILE_ENV} (or `--envelope-file`), `cap run`
 * writes the envelope there before exiting, and the consumer reads the file.
 * Stdout keeps the envelope for humans and older consumers; when the file is
 * absent (an older `ai-dossier` on PATH that ignores the env var) the stdout
 * is scanned bottom-up for a line carrying the {@link CAP_ENVELOPE_MARKER}
 * key, then the legacy last line.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Environment variable naming the file `cap run` writes its envelope to. */
export const CAP_ENVELOPE_FILE_ENV = 'DOSSIER_CAP_ENVELOPE_FILE';

/** Marker key present (value `1`) on every envelope `cap run` emits. */
export const CAP_ENVELOPE_MARKER = 'cap_envelope';

/**
 * Consumer-side stdout buffer for `cap run`. The capability layer itself
 * captures up to 64 MiB of its command's output and re-emits it before the
 * envelope, so a consumer buffer smaller than that turns a chatty-but-green
 * run into ENOBUFS.
 */
export const CAP_RUN_MAX_BUFFER_BYTES = 80 * 1024 * 1024;

/** The fields consumers read off the envelope; everything is optional/unknown until checked. */
export interface CapEnvelope {
  capability?: unknown;
  outcome?: unknown;
  exit_code?: unknown;
  reason?: unknown;
  duration_ms?: unknown;
  output_tail?: unknown;
  [key: string]: unknown;
}

function parseObject(text: string): CapEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as CapEnvelope;
  } catch {
    return null;
  }
}

function isMarked(envelope: CapEnvelope | null): envelope is CapEnvelope {
  return envelope !== null && envelope[CAP_ENVELOPE_MARKER] === 1;
}

/**
 * Find the envelope in `cap run`'s stdout: the LAST line (scanning
 * bottom-up) that parses as a JSON object carrying the marker key; failing
 * that, the legacy contract — the last non-empty line, parsed as-is (an
 * older `cap run` that predates the marker). `null` when neither parses.
 */
export function parseCapEnvelope(stdout: string): CapEnvelope | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    const candidate = parseObject(line);
    if (isMarked(candidate)) return candidate;
  }
  const lastLine = stdout.trim().split('\n').pop() ?? '';
  return parseObject(lastLine.trim());
}

/** Read an envelope file written by `cap run`; `null` when absent, unreadable, or not a marked envelope. */
export function readCapEnvelopeFile(file: string): CapEnvelope | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const envelope = parseObject(text.trim());
  return isMarked(envelope) ? envelope : null;
}

/**
 * Write `json` (one envelope) to `file` atomically — a reader never sees a
 * half-written envelope. Throws on I/O failure; the caller decides whether
 * that is fatal.
 */
export function writeCapEnvelopeFile(file: string, json: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${json}\n`);
  fs.renameSync(tmp, file);
}

/** A fresh, unguessable envelope path in the OS temp dir (the file itself is created by `cap run`). */
function newEnvelopePath(): string {
  return path.join(os.tmpdir(), `ai-dossier-cap-envelope-${process.pid}-${randomUUID()}.json`);
}

export interface CapRunSpawn {
  spawned: SpawnSyncReturns<string>;
  /** The envelope from the dedicated file, else from stdout (see {@link parseCapEnvelope}); `null` when neither yields one. */
  envelope: CapEnvelope | null;
  /** Where the envelope came from — for diagnostics. */
  envelopeSource: 'file' | 'stdout' | 'none';
}

/**
 * Spawn `ai-dossier cap run <capabilityId>` in `cwd` with a dedicated
 * envelope file, and return the spawn result plus the envelope. The file is
 * always cleaned up. `env` defaults to the inherited environment.
 */
export function spawnCapRun(
  capabilityId: string,
  cwd: string,
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): CapRunSpawn {
  const envelopeFile = newEnvelopePath();
  try {
    const spawned = spawnSync('ai-dossier', ['cap', 'run', capabilityId], {
      cwd,
      encoding: 'utf-8',
      timeout: opts.timeoutMs,
      maxBuffer: CAP_RUN_MAX_BUFFER_BYTES,
      env: { ...(opts.env ?? process.env), [CAP_ENVELOPE_FILE_ENV]: envelopeFile },
    });
    const fromFile = readCapEnvelopeFile(envelopeFile);
    if (fromFile !== null) return { spawned, envelope: fromFile, envelopeSource: 'file' };
    const fromStdout = spawned.stdout ? parseCapEnvelope(spawned.stdout) : null;
    return {
      spawned,
      envelope: fromStdout,
      envelopeSource: fromStdout !== null ? 'stdout' : 'none',
    };
  } finally {
    try {
      fs.rmSync(envelopeFile, { force: true });
    } catch {
      // Best effort — a leftover temp file is harmless.
    }
  }
}
