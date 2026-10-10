/** Stop-only second-process requests. Never takes or steals the controller guard. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publishPrivate, readPrivate, syncDirectory } from '../durable-fs';
import { lockDescriptor } from '../lock';
import { assertSecretFree } from '../redaction';
import { isRecord, type RunRecord, TERMINAL_STATES } from '../state';
import { strictUtf8 } from '../strict-utf8';
import type { RunStore } from './run-store';

export type ControlKind = 'pause' | 'cancel';
export type ControlResult = 'applied' | 'nothing_to_pause' | 'cleanup_required' | 'terminal';
export class ControlError extends Error {
  constructor(readonly code: 'invalid_control' | Exclude<ControlResult, 'applied'>) {
    super(`Control refused (${code})`);
  }
}
export interface ControlRequest {
  readonly v: 1;
  readonly id: string;
  readonly runId: string;
  readonly kind: ControlKind;
  readonly reason: string;
  readonly at: string;
  readonly digest: string;
}
export interface ControlState {
  readonly pending: readonly ControlRequest[];
  readonly refused: readonly Exclude<ControlResult, 'applied'>[];
  readonly invalid: boolean;
}
const ID = /^[a-f0-9-]{36}$/u;
export function controlRefusal(
  run: RunRecord,
  kind: ControlKind
): Exclude<ControlResult, 'applied'> | null {
  if (run.state === 'blocked_cleanup') return 'cleanup_required';
  if (TERMINAL_STATES.includes(run.state)) return 'terminal';
  if (
    kind === 'pause' &&
    !['gating', 'planning', 'implementing', 'verifying', 'shipping', 'revising'].includes(run.state)
  )
    return 'nothing_to_pause';
  return null;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function request(raw: unknown, runId: string, id: string): ControlRequest {
  if (!isRecord(raw)) throw new ControlError('invalid_control');
  const { digest: proof, ...body } = raw;
  assertSecretFree(body);
  if (
    Object.keys(raw).sort().join(',') !== 'at,digest,id,kind,reason,runId,v' ||
    raw.v !== 1 ||
    raw.id !== id ||
    !ID.test(id) ||
    raw.runId !== runId ||
    !['pause', 'cancel'].includes(String(raw.kind)) ||
    typeof raw.reason !== 'string' ||
    !raw.reason.trim() ||
    raw.reason.length > 500 ||
    typeof raw.at !== 'string' ||
    new Date(raw.at).toISOString() !== raw.at ||
    proof !== digest(body)
  )
    throw new ControlError('invalid_control');
  return raw as unknown as ControlRequest;
}
function read(file: string): unknown {
  const text = strictUtf8(
    readPrivate(file, (s) => {
      if (s.size > 8192) throw new ControlError('invalid_control');
    })
  );
  const value: unknown = JSON.parse(text);
  if (JSON.stringify(value) !== text) throw new ControlError('invalid_control');
  return value;
}
function directory(store: RunStore, create: boolean, work: (dir: string) => void): void {
  store.withStoreDirectory('control', (parent) => {
    const dir = path.join(parent, 'requests');
    if (create) {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      syncDirectory(parent);
    }
    work(dir);
  });
}
/** A short publisher-only guard, independent of the controller lifetime guard.
 * Readers never lock: rename exposes one fully fsynced single-link inode. */
function publish(store: RunStore, file: string, bytes: Buffer): void {
  store.withStoreDirectory('control', (parent) => {
    const fd = fs.openSync(
      path.join(parent, '.requests.guard'),
      fs.constants.O_CREAT |
        fs.constants.O_RDWR |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600
    );
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new ControlError('invalid_control');
      lockDescriptor(fd, 1000);
      fs.fsyncSync(fd);
      syncDirectory(parent);
      // Under this separate kernel guard, reuse only byte-identical evidence;
      // no legitimate publisher can replace another publisher's immutable row.
      publishPrivate(file, bytes);
    } finally {
      fs.closeSync(fd);
    }
  });
}
/** Returns only after file contents and directory entry are fsynced. */
export function requestControl(
  store: RunStore,
  input: { kind: ControlKind; reason: string },
  now: Date
): ControlRequest {
  assertSecretFree(input);
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(',') !== 'kind,reason' ||
    !['pause', 'cancel'].includes(input.kind) ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 500
  )
    throw new ControlError('invalid_control');
  const refusal = controlRefusal(store.run, input.kind);
  if (refusal) throw new ControlError(refusal);
  const body = {
    v: 1 as const,
    id: randomUUID(),
    runId: store.runId,
    kind: input.kind,
    reason: input.reason,
    at: now.toISOString(),
  };
  const row = { ...body, digest: digest(body) };
  directory(store, true, (dir) =>
    publish(store, path.join(dir, `${row.id}.json`), Buffer.from(JSON.stringify(row)))
  );
  return row;
}
/** Strict observational reader; no repairs, deletion, raw error text or reason echo. */
export function readControlRequests(store: RunStore): ControlState {
  const pending: ControlRequest[] = [];
  const refused: Exclude<ControlResult, 'applied'>[] = [];
  let invalid = false;
  try {
    directory(store, false, (dir) => {
      let handle: fs.Dir;
      try {
        handle = fs.opendirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const names = new Set<string>();
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          // Atomic publication staging files are never requests; a crashed writer
          // cannot publish half a request. They remain local for inspection.
          if (/^\.zt-write-[a-f0-9-]{36}$/u.test(entry.name)) continue;
          if (
            names.size >= 4096 ||
            !entry.isFile() ||
            !/^[a-f0-9-]{36}\.(?:json|result)$/u.test(entry.name)
          )
            throw new ControlError('invalid_control');
          names.add(entry.name);
        }
      } finally {
        handle.closeSync();
      }
      for (const name of names) {
        if (name.endsWith('.result')) {
          if (!names.has(name.replace(/\.result$/u, '.json')))
            throw new ControlError('invalid_control');
          continue;
        }
        const row = request(read(path.join(dir, name)), store.runId, name.slice(0, -5));
        let result: unknown;
        // A result can land after enumeration; read its actual presence instead.
        try {
          result = read(path.join(dir, `${row.id}.result`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (result === undefined) pending.push(row);
        else {
          if (
            !isRecord(result) ||
            Object.keys(result).sort().join(',') !== 'digest,result,v' ||
            result.v !== 1 ||
            result.digest !== row.digest ||
            !['applied', 'nothing_to_pause', 'cleanup_required', 'terminal'].includes(
              String(result.result)
            )
          )
            throw new ControlError('invalid_control');
          if (result.result !== 'applied')
            refused.push(result.result as Exclude<ControlResult, 'applied'>);
        }
      }
    });
  } catch {
    invalid = true;
  }
  pending.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { pending, refused, invalid };
}
/** Controller owner only, after its lifecycle snapshot (or refusal) is durable. */
export function acknowledgeControl(
  store: RunStore,
  row: ControlRequest,
  result: ControlResult
): void {
  directory(store, false, (dir) => {
    const held = request(read(path.join(dir, `${row.id}.json`)), store.runId, row.id);
    if (held.digest !== row.digest) throw new ControlError('invalid_control');
    publish(
      store,
      path.join(dir, `${row.id}.result`),
      Buffer.from(JSON.stringify({ v: 1, digest: row.digest, result }))
    );
  });
}
