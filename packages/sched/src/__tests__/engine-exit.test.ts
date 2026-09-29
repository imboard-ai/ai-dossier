import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExitProcess, installEngineExitLogging, Journal } from '../index';

/** A process double: a real EventEmitter so nothing here can signal the test runner. */
function fakeProc() {
  const emitter = new EventEmitter();
  const exit = vi.fn((_code?: number) => undefined as never);
  const proc = {
    pid: 4242,
    on: (e: string, l: (...a: never[]) => void) => emitter.on(e, l),
    removeListener: (e: string, l: (...a: never[]) => void) => emitter.removeListener(e, l),
    exit,
  } as ExitProcess;
  return { proc, emitter, exit };
}

describe('installEngineExitLogging (#945)', () => {
  let dir: string;
  let journal: Journal;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-exit-'));
    journal = new Journal(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const exits = () => journal.read().filter((e) => e.event === 'engine-exit');

  it.each([
    'SIGTERM',
    'SIGHUP',
    'SIGINT',
  ])('%s journals engine-exit, requests a graceful stop, and a second one exits hard', (sig) => {
    const { proc, emitter, exit } = fakeProc();
    const requestStop = vi.fn();
    const log = installEngineExitLogging({ journal, requestStop, proc });
    emitter.emit(sig);
    expect(requestStop).toHaveBeenCalledOnce();
    expect(exits()).toHaveLength(1);
    expect(exits()[0]).toMatchObject({ reason: `signal:${sig}`, pid: 4242 });
    expect(exit).not.toHaveBeenCalled();
    expect(log.shouldReleaseLease()).toBe(true);
    emitter.emit(sig);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('an uncaught exception journals the stack, exits 70 and keeps the lease as the crash marker', () => {
    const { proc, emitter, exit } = fakeProc();
    const log = installEngineExitLogging({ journal, requestStop: vi.fn(), proc });
    emitter.emit('uncaughtException', new Error('boom'));
    expect(exits()[0]).toMatchObject({ reason: 'uncaught-exception' });
    expect(exits()[0].detail).toContain('boom');
    expect(exit).toHaveBeenCalledWith(70);
    expect(log.shouldReleaseLease()).toBe(false);
  });

  it('an unhandled rejection is a crash too', () => {
    const { proc, emitter, exit } = fakeProc();
    const log = installEngineExitLogging({ journal, requestStop: vi.fn(), proc });
    emitter.emit('unhandledRejection', 'plain string reason');
    expect(exits()[0]).toMatchObject({ reason: 'unhandled-rejection' });
    expect(exits()[0].detail).toContain('plain string reason');
    expect(exit).toHaveBeenCalledWith(70);
    expect(log.shouldReleaseLease()).toBe(false);
  });

  it('a bare process exit with no earlier reason still leaves a line; the first reason wins', () => {
    const a = fakeProc();
    installEngineExitLogging({ journal, requestStop: vi.fn(), proc: a.proc });
    a.emitter.emit('exit', 1);
    expect(exits().map((e) => e.reason)).toEqual(['process-exit']);

    const b = fakeProc();
    const log = installEngineExitLogging({ journal, requestStop: vi.fn(), proc: b.proc });
    log.logNormalExit('stop requested');
    b.emitter.emit('exit', 0);
    expect(exits().map((e) => e.reason)).toEqual(['process-exit', 'normal']);
  });

  it('dispose removes every listener', () => {
    const { proc, emitter } = fakeProc();
    const log = installEngineExitLogging({ journal, requestStop: vi.fn(), proc });
    log.dispose();
    for (const ev of [
      'SIGTERM',
      'SIGHUP',
      'SIGINT',
      'uncaughtException',
      'unhandledRejection',
      'exit',
    ]) {
      expect(emitter.listenerCount(ev)).toBe(0);
    }
  });
});
