import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IN_FLIGHT_RUN_FILES,
  inFlightAlive,
  listInFlight,
  readInFlight,
  writeInFlight,
} from '@ai-dossier/sched';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnCapRun } from '../cap-envelope';
import { launchTrackedCapRun } from '../cap-run-tracked';

/**
 * #1233: the engine's tracked `cap run` launcher, against a fake `ai-dossier`
 * on PATH — a shell script standing in for `cap run`: it counts its launches,
 * records what it can see of the in-flight registry and its own process group,
 * sleeps `$GATE_SLEEP`, then writes an `ok` envelope and exits 0.
 */
describe.skipIf(process.platform === 'win32')('tracked cap run (#1233)', () => {
  let root: string;
  let worktree: string;
  let inFlight: string;
  let binDir: string;
  let launches: string;
  let observe: string;
  let originalPath: string | undefined;
  let originalSleep: string | undefined;

  const launchCount = () =>
    fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').length : 0;
  const head = () =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-tracked-'));
    worktree = path.join(root, 'wt');
    inFlight = path.join(root, 'state', 'in-flight');
    binDir = path.join(root, 'bin');
    launches = path.join(root, 'launches');
    observe = path.join(root, 'observe');
    fs.mkdirSync(worktree);
    fs.mkdirSync(binDir);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'],
      { cwd: worktree }
    );
    const fake = path.join(binDir, 'ai-dossier');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `echo launched >> "${launches}"`,
        `{ ls "${inFlight}"/*.json; ps -o pgid= -p $$; } > "${observe}" 2>/dev/null`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a JS template
        'sleep "${GATE_SLEEP:-0}"',
        `env_line='{"cap_envelope":1,"capability":"'"$3"'","outcome":"ok","exit_code":0}'`,
        'printf "%s\\n" "$env_line" > "$DOSSIER_CAP_ENVELOPE_FILE"',
        'echo "gate green"',
        'printf "%s\\n" "$env_line"',
        'exit 0',
        '',
      ].join('\n')
    );
    fs.chmodSync(fake, 0o755);
    originalPath = process.env.PATH;
    originalSleep = process.env.GATE_SLEEP;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalSleep === undefined) delete process.env.GATE_SLEEP;
    else process.env.GATE_SLEEP = originalSleep;
    for (const entry of listInFlight(inFlight)) {
      try {
        process.kill(-entry.record.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records the run BEFORE waiting, in its own process group, and releases it after the verdict', () => {
    const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 30_000, inFlightDir: inFlight });
    expect(run.envelope).toMatchObject({ outcome: 'ok' });
    expect(run.exitedWithVerdict).toBe(true);
    expect(run.spawned.status).toBe(0);
    expect(run.spawned.stdout).toContain('gate green');
    const seen = fs.readFileSync(observe, 'utf8').trim().split('\n');
    // The fake `cap run` saw its own in-flight record while it was running…
    expect(seen[0]).toMatch(/gate\.batch-[0-9a-f]{16}\.json$/);
    // …and ran in a process group of its own, not the test runner's.
    const pgid = Number(seen[1].trim());
    expect(pgid).not.toBe(
      Number(
        execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
      )
    );
    expect(pgid).toBe(run.spawned.pid);
    // Consumed: record and run directory are gone.
    expect(listInFlight(inFlight)).toEqual([]);
    expect(fs.readdirSync(inFlight)).toEqual([]);
  });

  it('adopts a LIVE gate a dead engine left behind instead of launching a duplicate', () => {
    process.env.GATE_SLEEP = '2';
    const launched = launchTrackedCapRun('gate.batch', path.resolve(worktree), {
      timeoutMs: 30_000,
      inFlightDir: inFlight,
      head: head(),
    });
    if ('error' in launched) throw launched.error;
    expect(inFlightAlive(launched.record)).toBe(true);
    // A new engine (here: this call) finds it and waits for its verdict.
    const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 30_000, inFlightDir: inFlight });
    expect(launchCount()).toBe(1);
    expect(run.envelope).toMatchObject({ outcome: 'ok' });
    expect(run.exitedWithVerdict).toBe(true);
    expect(run.diagnostics).toContain(`adopted in-flight gate.batch pid ${launched.record.pid}`);
    expect(listInFlight(inFlight)).toEqual([]);
  });

  it('adopts a FINISHED, unconsumed verdict for the same HEAD without re-running', () => {
    const launched = launchTrackedCapRun('gate.batch', path.resolve(worktree), {
      timeoutMs: 30_000,
      inFlightDir: inFlight,
      head: head(),
    });
    if ('error' in launched) throw launched.error;
    const status = path.join(launched.record.run_dir, IN_FLIGHT_RUN_FILES.status);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(status) && Date.now() < deadline) execFileSync('sleep', ['0.1']);
    expect(launchCount()).toBe(1);
    const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 30_000, inFlightDir: inFlight });
    expect(launchCount()).toBe(1);
    expect(run.envelope).toMatchObject({ outcome: 'ok' });
    expect(run.diagnostics).toContain('adopted finished gate.batch');
  });

  it('re-runs when the finished verdict was for a different HEAD', () => {
    const launched = launchTrackedCapRun('gate.batch', path.resolve(worktree), {
      timeoutMs: 30_000,
      inFlightDir: inFlight,
      head: 'f'.repeat(40),
    });
    if ('error' in launched) throw launched.error;
    const status = path.join(launched.record.run_dir, IN_FLIGHT_RUN_FILES.status);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(status) && Date.now() < deadline) execFileSync('sleep', ['0.1']);
    const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 30_000, inFlightDir: inFlight });
    expect(launchCount()).toBe(2);
    expect(run.envelope).toMatchObject({ outcome: 'ok' });
    expect(run.diagnostics).toContain('discarded stale finished in-flight record');
  });

  it('discards a dead record that never finished and launches fresh', () => {
    const runDir = path.join(inFlight, 'run-dead');
    fs.mkdirSync(runDir, { recursive: true });
    writeInFlight(inFlight, {
      version: 1,
      capability: 'gate.batch',
      cwd: path.resolve(worktree),
      pid: 2 ** 22 - 1,
      pid_start: null,
      started_at: new Date().toISOString(),
      timeout_ms: 30_000,
      launcher_pid: 1,
      run_dir: runDir,
      head: head(),
    });
    const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 30_000, inFlightDir: inFlight });
    expect(launchCount()).toBe(1);
    expect(run.envelope).toMatchObject({ outcome: 'ok' });
    expect(run.diagnostics).toContain('discarded dead in-flight record');
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it('a timeout kills the whole process group and reports ETIMEDOUT', { timeout: 30_000 }, () => {
    process.env.GATE_SLEEP = '60';
    const started = Date.now();
    const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 1_500, inFlightDir: inFlight });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((run.spawned.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT');
    expect(run.envelope).toBeNull();
    expect(inFlightAlive({ pid: run.spawned.pid, pid_start: null })).toBe(false);
    expect(readInFlight(inFlight, worktree, 'gate.batch')).toBeNull();
  });

  it('no `ai-dossier` on PATH reads as spawnSync ENOENT (callers fall through as before)', () => {
    fs.rmSync(path.join(binDir, 'ai-dossier'));
    process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const run = spawnCapRun('gate.batch', worktree, { timeoutMs: 10_000, inFlightDir: inFlight });
    expect((run.spawned.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
    expect(run.envelope).toBeNull();
  });
});
