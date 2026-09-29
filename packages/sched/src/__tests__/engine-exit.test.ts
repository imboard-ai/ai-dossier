import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoppingMarker,
  type ExitProcess,
  installEngineExitLogging,
  Journal,
  readStoppingMarker,
  writeStoppingMarker,
} from '../index';

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
    expect(exits().map((e) => e.reason)).toEqual([`signal:${sig}`]);
  });

  it('SIGHUP never stops the engine: journaled as ignored, no stop, no exit, lease kept', () => {
    const { proc, emitter, exit } = fakeProc();
    const requestStop = vi.fn();
    const log = installEngineExitLogging({ journal, requestStop, proc });
    emitter.emit('SIGHUP');
    emitter.emit('SIGHUP');
    expect(requestStop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(exits().map((e) => e.reason)).toEqual([
      'signal-ignored:SIGHUP',
      'signal-ignored:SIGHUP',
    ]);
    expect(log.reason()).toBeNull();
    // a real stop afterwards still works
    emitter.emit('SIGTERM');
    expect(requestStop).toHaveBeenCalledOnce();
  });

  it('the first stop signal writes the stopping marker BEFORE requesting the stop', () => {
    const { proc, emitter } = fakeProc();
    const order: string[] = [];
    installEngineExitLogging({
      journal,
      proc,
      markStopping: (sig) => order.push(`mark:${sig}`),
      requestStop: () => order.push('stop'),
    });
    emitter.emit('SIGTERM');
    emitter.emit('SIGTERM');
    expect(order).toEqual(['mark:SIGTERM', 'stop']);
  });

  it('a wedged stop is bounded: the deadline journals stop-timeout and exits without marking a crash', () => {
    const { proc, emitter, exit } = fakeProc();
    let fire: () => void = () => undefined;
    const unref = vi.fn();
    const log = installEngineExitLogging({
      journal,
      proc,
      requestStop: vi.fn(),
      stopTimeoutMs: 5_000,
      setTimer: (fn, ms) => {
        expect(ms).toBe(5_000);
        fire = fn;
        return { unref };
      },
    });
    emitter.emit('SIGTERM');
    expect(unref).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    fire();
    expect(exits().map((e) => e.reason)).toEqual(['signal:SIGTERM', 'stop-timeout']);
    expect(exit).toHaveBeenCalledWith(143);
    expect(log.shouldReleaseLease()).toBe(true);
  });

  it('a crash after a signal is still journaled with its stack (every cause is kept)', () => {
    const { proc, emitter, exit } = fakeProc();
    const log = installEngineExitLogging({ journal, requestStop: vi.fn(), proc });
    emitter.emit('SIGTERM');
    emitter.emit('uncaughtException', new Error('during stop'));
    expect(exits().map((e) => e.reason)).toEqual(['signal:SIGTERM', 'uncaught-exception']);
    expect(exits()[1].detail).toContain('during stop');
    expect(exit).toHaveBeenCalledWith(70);
    expect(log.shouldReleaseLease()).toBe(false);
  });

  it('a signal arriving before anything else was set up (logger is first) is still logged', () => {
    const { proc, emitter } = fakeProc();
    installEngineExitLogging({ journal, requestStop: vi.fn(), proc });
    emitter.emit('SIGINT');
    expect(exits().map((e) => e.reason)).toEqual(['signal:SIGINT']);
  });

  it('an unwritable journal cannot block the exit path', () => {
    const { proc, emitter, exit } = fakeProc();
    const broken = {
      append: () => {
        throw new Error('disk full');
      },
    } as unknown as Journal;
    installEngineExitLogging({ journal: broken, requestStop: vi.fn(), proc });
    emitter.emit('uncaughtException', new Error('x'));
    expect(exit).toHaveBeenCalledWith(70);
  });

  it('the stopping marker round-trips and clears', () => {
    expect(readStoppingMarker(dir)).toBeNull();
    writeStoppingMarker(dir, { pid: 5, signal: 'SIGTERM', at: 'T' });
    expect(readStoppingMarker(dir)).toEqual({ pid: 5, signal: 'SIGTERM', at: 'T' });
    clearStoppingMarker(dir);
    expect(readStoppingMarker(dir)).toBeNull();
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
