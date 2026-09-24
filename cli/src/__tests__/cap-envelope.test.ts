import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBatchSuiteRunner } from '../batch-suite-runner';
import {
  CAP_ENVELOPE_FILE_ENV,
  parseCapEnvelope,
  readCapEnvelopeFile,
  spawnCapRun,
  writeCapEnvelopeFile,
} from '../cap-envelope';
import { createBatchCapabilityRunner } from '../commands/sched';

const cliPath = path.resolve(__dirname, '../../src/cli.ts');
const tsxBin = path.resolve(__dirname, '../../../node_modules/.bin/tsx');

const marked = (outcome: string): string =>
  JSON.stringify({ cap_envelope: 1, capability: 'x', outcome, exit_code: 0 });

describe('parseCapEnvelope (#811)', () => {
  it('finds the marked envelope even when other output lands after it', () => {
    const stdout = `building...\n${marked('ok')}\nlate descendant line\n{"not":"an envelope"}\n`;
    expect(parseCapEnvelope(stdout)?.outcome).toBe('ok');
  });

  it('prefers the bottom-most marked line', () => {
    const stdout = `${marked('task-failed')}\n${marked('ok')}\ntrailing`;
    expect(parseCapEnvelope(stdout)?.outcome).toBe('ok');
  });

  it('falls back to the legacy unmarked last line (an older cap run)', () => {
    const stdout = 'noise\n{"capability":"x","outcome":"task-failed","exit_code":1}\n';
    expect(parseCapEnvelope(stdout)?.outcome).toBe('task-failed');
  });

  it('returns null when nothing parses', () => {
    expect(parseCapEnvelope('just text\nmore text')).toBeNull();
    expect(parseCapEnvelope('')).toBeNull();
    expect(parseCapEnvelope('[1,2,3]')).toBeNull();
  });
});

describe('envelope file (#811)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-envelope-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a marked envelope', () => {
    const file = path.join(dir, 'env.json');
    writeCapEnvelopeFile(file, marked('ok'));
    expect(readCapEnvelopeFile(file)?.outcome).toBe('ok');
    expect(fs.readdirSync(dir)).toEqual(['env.json']); // no temp leftovers
  });

  it('rejects a missing file and an unmarked JSON object', () => {
    expect(readCapEnvelopeFile(path.join(dir, 'missing.json'))).toBeNull();
    const file = path.join(dir, 'pkg.json');
    fs.writeFileSync(file, JSON.stringify({ outcome: 'ok' }));
    expect(readCapEnvelopeFile(file)).toBeNull();
  });
});

/**
 * End-to-end through the real `cap run` (src via tsx). A fake `ai-dossier`
 * on PATH runs the real CLI but first forks a background grandchild that
 * writes to the SAME inherited stdout after `cap run` has exited — the
 * envelope is no longer stdout's last line (the #811 shape).
 */
describe('cap run envelope channel, end-to-end (#811)', () => {
  let worktree: string;
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-envelope-wt-'));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-envelope-bin-'));
    fs.mkdirSync(path.join(worktree, '.dossier', 'automation'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.dossier', 'automation', 'manifest.yaml'),
      [
        'version: 1',
        'capabilities:',
        '  gate.batch:',
        '    command: node -e "console.log(\'gate green\')"',
        '    lifecycle: active',
        '  test.focused:',
        '    command: node -e "console.log(\'focused green\')"',
        '    lifecycle: active',
        '  big.output:',
        `    command: node -e "process.stdout.write(('x'.repeat(99) + '\\\\n').repeat(60000))"`,
        '    lifecycle: active',
        '',
      ].join('\n')
    );
    const fake = path.join(binDir, 'ai-dossier');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        // Grandchild: inherits our stdout, waits for `cap run` (exec keeps
        // this PID) to exit, then writes to the same stdout.
        '( while kill -0 $$ 2>/dev/null; do sleep 0.05; done; echo "late grandchild output"; echo "{\\"outcome\\":\\"not-the-envelope\\"}" ) &',
        `exec "${tsxBin}" "${cliPath}" "$@"`,
        '',
      ].join('\n')
    );
    fs.chmodSync(fake, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it(
    'a background grandchild writing after cap run exits still yields ok (suite runner)',
    {
      timeout: 60_000,
    },
    () => {
      const result = createBatchSuiteRunner({ max_slots: 1, dispatch: {} }, { timeoutMs: 45_000 })(
        worktree,
        { batchId: 'b-811', baseRef: 'origin/main' }
      );
      expect(result.detail).toContain('cap run gate.batch: outcome=ok');
      expect(result).toMatchObject({ ok: true, readable: true });
    }
  );

  it(
    'the envelope file is the channel: stdout last line is the grandchild, file still ok',
    {
      timeout: 60_000,
    },
    () => {
      const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 45_000 });
      expect(run.spawned.status).toBe(0);
      expect((run.spawned.stdout ?? '').trim().split('\n').pop()).toContain('not-the-envelope');
      expect(run.envelopeSource).toBe('file');
      expect(run.envelope?.outcome).toBe('ok');
    }
  );

  it('the per-member gate runner reads the same channel', { timeout: 60_000 }, () => {
    const gate = createBatchCapabilityRunner({ timeoutMs: 45_000 })(worktree, 'test.focused');
    expect(gate.outcome).toBe('ok');
  });

  it(
    'cap run flushes a large captured output before exiting — the stdout envelope is never truncated away',
    {
      timeout: 60_000,
    },
    () => {
      // Direct `cap run` into a pipe (no fake wrapper, no envelope file): the
      // stdout envelope must survive ~6 MB of re-emitted output.
      const res = spawnSync(tsxBin, [cliPath, 'cap', 'run', 'big.output'], {
        cwd: worktree,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 45_000,
        env: { ...process.env, [CAP_ENVELOPE_FILE_ENV]: '' },
      });
      expect(res.status).toBe(0);
      expect((res.stdout ?? '').length).toBeGreaterThan(6_000_000);
      const envelope = parseCapEnvelope(res.stdout ?? '');
      expect(envelope).toMatchObject({ cap_envelope: 1, outcome: 'ok' });
    }
  );
});
