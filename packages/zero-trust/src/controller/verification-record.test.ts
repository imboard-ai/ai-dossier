import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateInput, harness, RUN_ID, removeTemps } from '../__tests__/verifier-fixture';
import { sha256 } from '../canonical/export';
import { canonicalJson } from '../receipt/schema';
import {
  assertShippableVerification,
  beginVerification,
  loadVerification,
  publishVerification,
  VERIFICATION_DIRECTORY,
  type VerificationRecord,
  VerificationRecordError,
  verificationState,
} from './verification-record';
import { verifyCandidate } from './verifier';

beforeEach(() => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [
      { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTemps();
});

/** A real record from a passing verification, and where it lives. */
async function persisted() {
  const h = harness();
  const input = candidateInput();
  const outcome = await verifyCandidate(h.deps(), input);
  if (outcome.kind !== 'verified') throw new Error('not verified');
  const file = path.join(h.artifactsDir, VERIFICATION_DIRECTORY, `${input.candidateSha}.json`);
  return { dir: h.artifactsDir, sha: input.candidateSha, record: outcome.record, file };
}

/** Replaces the file with `bytes`, keeping it private and single-linked. */
function rewrite(file: string, bytes: Buffer | string): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}

function canonical(value: unknown): string {
  return `${canonicalJson(value, 1024 * 1024)}\n`;
}

/** A schema-valid edit with the record digest recomputed. */
function redigested(record: VerificationRecord, change: Partial<VerificationRecord>) {
  const { recordDigest: _, ...body } = { ...record, ...change };
  return { ...body, recordDigest: sha256(canonicalJson(body, 1024 * 1024)) };
}

function refused(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationRecordError);
    expect((error as VerificationRecordError).code).toBe(code);
    return;
  }
  throw new Error('expected a refusal');
}

describe('loadVerification: strict, fail-closed reads (AC5)', () => {
  it('round-trips a persisted record, frozen, with the expected digest', async () => {
    const { dir, sha, record } = await persisted();
    const loaded = loadVerification(dir, sha, {
      runId: RUN_ID,
      expectedDigest: record.recordDigest,
    });
    expect(loaded).toEqual(record);
    expect(Object.isFrozen(loaded.commands[0])).toBe(true);
    expect(verificationState(dir, sha)).toBe('recorded');
  });

  it('refuses an unknown field even with a recomputed digest', async () => {
    const { dir, sha, record, file } = await persisted();
    rewrite(file, canonical(redigested(record, { extra: 1 } as never)));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
  });

  it.each([
    ['logsDigests', (r: Record<string, unknown>) => delete r.logsDigests],
    [
      'a command log digest',
      (r: Record<string, unknown>) =>
        delete (r.commands as Record<string, unknown>[])[0]?.sanitizedLogDigest,
    ],
    [
      'the boundary input digest',
      (r: Record<string, unknown>) => delete (r.boundaryInputRef as Record<string, unknown>).digest,
    ],
    ['the record digest', (r: Record<string, unknown>) => delete r.recordDigest],
  ])('refuses a record missing %s', async (_, drop) => {
    const { dir, sha, record, file } = await persisted();
    const copy = JSON.parse(JSON.stringify(record));
    drop(copy);
    rewrite(file, canonical(copy));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
  });

  it('refuses a mutated record (digest no longer matches)', async () => {
    const { dir, sha, record, file } = await persisted();
    rewrite(file, canonical({ ...record, verdict: 'failed' }));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
  });

  it('refuses a consistently re-digested mutation the controller did not write', async () => {
    const { dir, sha, record, file } = await persisted();
    rewrite(file, canonical(redigested(record, { verdict: 'failed' })));
    refused(
      () => loadVerification(dir, sha, { runId: RUN_ID, expectedDigest: record.recordDigest }),
      'evidence_mismatch'
    );
  });

  it.each([
    ['a whitespace edit', (text: string) => text.replace('{', '{ ')],
    ['a duplicate key', (text: string) => text.replace('{', '{"verdict":"failed",')],
    ['a missing final newline', (text: string) => text.trimEnd()],
  ])('refuses %s (not the canonical bytes)', async (_, edit) => {
    const { dir, sha, file } = await persisted();
    rewrite(file, edit(fs.readFileSync(file, 'utf8')));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
  });

  it('refuses invalid UTF-8 and non-JSON bytes', async () => {
    const { dir, sha, file } = await persisted();
    const bytes = fs.readFileSync(file);
    rewrite(file, Buffer.concat([bytes.subarray(0, 10), Buffer.from([0xff]), bytes.subarray(10)]));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
    rewrite(file, '{');
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
  });

  it('refuses a passed verdict without proof, even when consistently digested', async () => {
    const { dir, sha, record, file } = await persisted();
    rewrite(file, canonical(redigested(record, { regression: 'not_reproduced' })));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
  });

  it('refuses another run, another candidate path and a malformed SHA', async () => {
    const { dir, sha, file } = await persisted();
    refused(() => loadVerification(dir, sha, { runId: 'run-other' }), 'evidence_mismatch');
    const other = 'c'.repeat(40);
    fs.copyFileSync(file, path.join(path.dirname(file), `${other}.json`));
    fs.chmodSync(path.join(path.dirname(file), `${other}.json`), 0o600);
    refused(() => loadVerification(dir, other, { runId: RUN_ID }), 'evidence_mismatch');
    refused(() => loadVerification(dir, '../x', { runId: RUN_ID }), 'invalid_record');
  });

  it('refuses a missing, group-readable or linked record as unavailable', async () => {
    const { dir, sha, file } = await persisted();
    fs.chmodSync(file, 0o640);
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'unavailable');
    fs.chmodSync(file, 0o600);
    fs.linkSync(file, `${file}.link`);
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'unavailable');
    fs.rmSync(`${file}.link`);
    fs.rmSync(file);
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'unavailable');
    expect(verificationState(dir, sha)).toBe('attempted');
  });

  it('refuses when the boundary artifact changed, vanished or contradicts the record', async () => {
    const { dir, sha, record } = await persisted();
    const artifact = path.join(dir, record.boundaryInputRef.artifact);
    const original = fs.readFileSync(artifact);
    rewrite(artifact, Buffer.concat([original, Buffer.from(' ')]));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
    fs.rmSync(artifact);
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
    rewrite(artifact, original);
    expect(loadVerification(dir, sha, { runId: RUN_ID }).boundaryHeld).toBe(true);
  });

  it('refuses a held claim the recomputed boundary verdict does not support', async () => {
    const { dir, sha, record, file } = await persisted();
    const artifact = path.join(dir, record.boundaryInputRef.artifact);
    const input = JSON.parse(fs.readFileSync(artifact, 'utf8'));
    const failed = Buffer.from(`${JSON.stringify({ ...input, listenerConnections: 1 })}\n`);
    rewrite(artifact, failed);
    rewrite(
      file,
      canonical(
        redigested(record, {
          boundaryInputRef: { ...record.boundaryInputRef, digest: sha256(failed) },
        })
      )
    );
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
    rewrite(artifact, '{');
    rewrite(
      file,
      canonical(
        redigested(record, {
          boundaryInputRef: { ...record.boundaryInputRef, digest: sha256('{') },
        })
      )
    );
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
  });

  it('refuses when a referenced log artifact is missing or names another digest', async () => {
    const { dir, sha, record } = await persisted();
    const digest = record.logsDigests[0] as string;
    const log = path.join(dir, `${digest}.complete.log.json`);
    const original = fs.readFileSync(log);
    rewrite(log, JSON.stringify({ digest: 'f'.repeat(64) }));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
    rewrite(log, '{');
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
    fs.rmSync(log);
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
    // A truncated log artifact is evidence too, when its content says so.
    const truncated = path.join(dir, `${digest}.truncated.log.json`);
    rewrite(truncated, original);
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'evidence_mismatch');
    rewrite(
      truncated,
      JSON.stringify({ ...JSON.parse(original.toString()), outputTruncated: true })
    );
    expect(loadVerification(dir, sha, { runId: RUN_ID }).recordDigest).toBe(record.recordDigest);
  });
  it('refuses a record read through a symlinked directory', async () => {
    const { dir, sha, record } = await persisted();
    const link = `${dir}-link`;
    fs.symlinkSync(dir, link);
    try {
      refused(() => loadVerification(link, sha, { runId: RUN_ID }), 'unavailable');
    } finally {
      fs.rmSync(link);
    }
    expect(loadVerification(dir, sha, { runId: RUN_ID })).toEqual(record);
  });

  it('refuses a regression claim no passed regression command backs', async () => {
    const { dir, sha, record, file } = await persisted();
    const commands = record.commands.map((c) =>
      c.id.endsWith('-regression') ? { ...c, id: 'renamed' } : c
    );
    rewrite(file, canonical(redigested(record, { verdict: 'failed', commands })));
    refused(() => loadVerification(dir, sha, { runId: RUN_ID }), 'invalid_record');
  });
});

describe('beginVerification and assertShippableVerification', () => {
  it('claims a candidate exactly once', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zt-claim-')), 'artifacts');
    try {
      const sha = 'e'.repeat(40);
      expect(verificationState(dir, sha)).toBe('none');
      beginVerification(dir, sha);
      expect(verificationState(dir, sha)).toBe('attempted');
      refused(() => beginVerification(dir, sha), 'record_exists');
      refused(() => beginVerification(dir, 'not-a-sha'), 'invalid_record');
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it('ships only a passed record whose boundary held', async () => {
    const { record } = await persisted();
    expect(() => assertShippableVerification(record)).not.toThrow();
    refused(() => assertShippableVerification({ ...record, boundaryHeld: false }), 'not_shippable');
    refused(
      () => assertShippableVerification({ ...record, verdict: 'inconclusive' }),
      'not_shippable'
    );
    refused(
      () => assertShippableVerification({ ...record, regression: 'inconclusive' }),
      'not_shippable'
    );
  });
});

describe('publishVerification', () => {
  it('writes once: a second record for the same candidate is refused', async () => {
    const { dir, record } = await persisted();
    const { schemaVersion: _, recordDigest: __, ...input } = record;
    refused(() => publishVerification(dir, input), 'record_exists');
  });

  it('refuses an inconsistent or secret-bearing record before writing', async () => {
    const { record } = await persisted();
    const { schemaVersion: _, recordDigest: __, ...input } = record;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-record-'));
    try {
      refused(
        () => publishVerification(dir, { ...input, regression: 'still_failing' }),
        'invalid_record'
      );
      refused(
        () =>
          publishVerification(dir, {
            ...input,
            profile: { ...input.profile, name: `ghp_${'a'.repeat(36)}` },
          }),
        'invalid_record'
      );
      refused(
        () => publishVerification(dir, { ...input, parentSha: 'd'.repeat(40) }),
        'invalid_record'
      );
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unusable storage as unavailable', async () => {
    const { record } = await persisted();
    const { schemaVersion: _, recordDigest: __, ...input } = record;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-record-'));
    try {
      const blocked = path.join(dir, 'artifacts');
      fs.writeFileSync(blocked, 'not a directory');
      refused(() => publishVerification(blocked, input), 'unavailable');
      refused(() => verificationState(path.join(blocked, 'x'), record.candidateSha), 'unavailable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
