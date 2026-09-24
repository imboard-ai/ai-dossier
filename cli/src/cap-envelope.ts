/**
 * The `cap run` outcome-envelope channel (#811).
 *
 * `ai-dossier cap run <id>` reports its four-way outcome as a JSON envelope.
 * Machine consumers (the batch suite runner, the per-member gate runner) used
 * to read only stdout's LAST line — which silently failed when that line was
 * not the envelope:
 *
 *   - `cap run` re-emitted the capability's captured output and then exited
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
 *
 * Whatever the source, an envelope is only trusted when `cap run`'s own exit
 * status agrees with its `outcome` — the exit code is the one signal the
 * capability's command cannot forge (#562 review).
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAP_ENVELOPE_FILE_ENV,
  CAPABILITY_EXIT_CODES,
  type CapabilityOutcome,
  MAX_CAPABILITY_OUTPUT_BYTES,
} from './capability';

export { CAP_ENVELOPE_FILE_ENV };

/** Marker key present (value `1`) on every envelope `cap run` emits. */
export const CAP_ENVELOPE_MARKER = 'cap_envelope';

/**
 * Consumer-side stdout buffer for `cap run`: the capability layer captures up
 * to {@link MAX_CAPABILITY_OUTPUT_BYTES} of its command's output and re-emits
 * it before the envelope, so a consumer buffer no larger than that turns a
 * chatty-but-green run into ENOBUFS. Derived, not restated, so the two cannot drift.
 */
export const CAP_RUN_MAX_BUFFER_BYTES = MAX_CAPABILITY_OUTPUT_BYTES + 16 * 1024 * 1024;

/** The raw envelope object; every field is `unknown` until narrowed by {@link envelopeFields}. */
export interface CapEnvelope {
  [key: string]: unknown;
}

/** The typed fields consumers read off an envelope — `null` when absent or of the wrong type. */
export interface CapEnvelopeFields {
  outcome: CapabilityOutcome | null;
  exitCode: number | null;
  reason: string | null;
  durationMs: number | null;
  outputTail: string | null;
}

/** `true` when `value` is one of the four `cap run` outcomes. */
export function isCapabilityOutcome(value: unknown): value is CapabilityOutcome {
  return typeof value === 'string' && Object.hasOwn(CAPABILITY_EXIT_CODES, value);
}

/** Narrow an envelope's fields by type — one place, so every consumer reads it identically. */
export function envelopeFields(envelope: CapEnvelope): CapEnvelopeFields {
  return {
    outcome: isCapabilityOutcome(envelope.outcome) ? envelope.outcome : null,
    exitCode: typeof envelope.exit_code === 'number' ? envelope.exit_code : null,
    reason: typeof envelope.reason === 'string' ? envelope.reason : null,
    durationMs: typeof envelope.duration_ms === 'number' ? envelope.duration_ms : null,
    outputTail: typeof envelope.output_tail === 'string' ? envelope.output_tail : null,
  };
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

/** What {@link readCapEnvelopeFile} found: nothing, something unusable, or a marked envelope. */
export type CapEnvelopeFileRead =
  | { state: 'absent' }
  | { state: 'invalid'; preview: string }
  | { state: 'ok'; envelope: CapEnvelope };

const INVALID_PREVIEW_CHARS = 200;

/**
 * Read an envelope file written by `cap run`. `invalid` (present but not a
 * marked envelope) is kept distinct from `absent` — it means version skew or
 * a writer bug, not "an older CLI that never wrote one".
 */
export function readCapEnvelopeFile(file: string): CapEnvelopeFileRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return { state: 'absent' };
  }
  const envelope = parseObject(String(text).trim());
  if (isMarked(envelope)) return { state: 'ok', envelope };
  return { state: 'invalid', preview: String(text).slice(0, INVALID_PREVIEW_CHARS) };
}

/**
 * Write `json` (one envelope) to `file` atomically — a reader never sees a
 * half-written envelope. The temp sibling has an unguessable name and is
 * opened exclusively (`wx`, mode 0600), so a pre-planted file or symlink in a
 * shared directory is refused rather than written through; it is removed if
 * the write or rename fails. Throws on I/O failure; the caller decides
 * whether that is fatal.
 */
export function writeCapEnvelopeFile(file: string, json: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${json}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Result of {@link spawnCapRun}: the raw spawn plus the verdict it produced, if any. */
export interface CapRunSpawn {
  spawned: SpawnSyncReturns<string>;
  /**
   * The envelope — from the dedicated file, else from stdout (see
   * {@link parseCapEnvelope}) — and only when `cap run`'s exit status agrees
   * with its `outcome`. `null` when no trustworthy envelope was recovered.
   */
  envelope: CapEnvelope | null;
  /** Where {@link envelope} came from; `'none'` when it is `null`. */
  envelopeSource: 'file' | 'stdout' | 'none';
  /**
   * `cap run` exited on its own with a trusted verdict. When this is `true`
   * a spawn error (ETIMEDOUT) is NOT the gate timing out: a descendant still
   * held the inherited stdout pipe, so `spawnSync` kept waiting past its
   * timeout after `cap run` had already recorded its exit status.
   */
  exitedWithVerdict: boolean;
  /** Human-readable account of how the envelope was (or was not) recovered — for `detail`/`reason`. */
  diagnostics: string;
}

/**
 * Spawn `ai-dossier cap run <capabilityId>` in `cwd` with a dedicated
 * envelope file in a fresh private (0700) temp directory, and return the
 * spawn result plus the verdict. Always sets {@link CAP_ENVELOPE_FILE_ENV}
 * (overriding any value in `env`, which otherwise defaults to the inherited
 * environment) and uses {@link CAP_RUN_MAX_BUFFER_BYTES} as `maxBuffer`. The
 * temp directory — and any stray temp file a killed `cap run` left in it — is
 * always removed.
 */
export function spawnCapRun(
  capabilityId: string,
  cwd: string,
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): CapRunSpawn {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dossier-cap-'));
  const envelopeFile = path.join(dir, 'envelope.json');
  try {
    const spawned = spawnSync('ai-dossier', ['cap', 'run', capabilityId], {
      cwd,
      encoding: 'utf-8',
      timeout: opts.timeoutMs,
      maxBuffer: CAP_RUN_MAX_BUFFER_BYTES,
      env: { ...(opts.env ?? process.env), [CAP_ENVELOPE_FILE_ENV]: envelopeFile },
    });
    return resolveVerdict(spawned, readCapEnvelopeFile(envelopeFile));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort — a leftover private temp dir is harmless.
    }
  }
}

function resolveVerdict(
  spawned: SpawnSyncReturns<string>,
  fileRead: CapEnvelopeFileRead
): CapRunSpawn {
  const notes: string[] = [];
  let candidate: CapEnvelope | null = null;
  let source: 'file' | 'stdout' = 'file';
  if (fileRead.state === 'ok') {
    candidate = fileRead.envelope;
  } else {
    notes.push(
      fileRead.state === 'invalid'
        ? `envelope file invalid: ${JSON.stringify(fileRead.preview)}`
        : 'envelope file not written (an `ai-dossier` on PATH older than #811?)'
    );
    candidate = spawned.stdout ? parseCapEnvelope(spawned.stdout) : null;
    source = 'stdout';
    if (candidate === null) notes.push('stdout scan found no envelope');
  }

  let envelope: CapEnvelope | null = null;
  if (candidate !== null) {
    const outcome = envelopeFields(candidate).outcome;
    if (outcome !== null && spawned.status === CAPABILITY_EXIT_CODES[outcome]) {
      envelope = candidate;
    } else {
      notes.push(
        `envelope from ${source} rejected: outcome=${String(candidate.outcome)} disagrees with cap run exit ${spawned.status ?? 'none'}`
      );
    }
  }

  const envelopeSource = envelope !== null ? source : 'none';
  const exitedWithVerdict = spawned.status !== null && envelope !== null;
  if (exitedWithVerdict && spawned.error) {
    notes.push(
      `verdict accepted although the spawn reported ${(spawned.error as NodeJS.ErrnoException).code ?? spawned.error.message} — a descendant held cap run's stdout after it exited`
    );
  }
  return {
    spawned,
    envelope,
    envelopeSource,
    exitedWithVerdict,
    diagnostics: [`envelope=${envelopeSource}`, ...notes].join('; '),
  };
}
