import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CorruptStateError,
  createEmptyState,
  enqueueEntries,
  SchedStore,
  transitionIssue,
  validateState,
  writeAtomic,
} from '../index';

const NOW = new Date('2026-08-29T12:00:00Z');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeAtomic', () => {
  it('leaves no .tmp behind and writes exact contents', () => {
    const file = path.join(dir, 'state.json');
    writeAtomic(file, '{"a":1}\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":1}\n');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('overwrites a stale .tmp from a previous crashed write without using it', () => {
    const file = path.join(dir, 'state.json');
    writeAtomic(file, 'first');
    fs.writeFileSync(`${file}.tmp`, 'GARBAGE-PARTIAL-WRITE');
    writeAtomic(file, 'second');
    expect(fs.readFileSync(file, 'utf-8')).toBe('second');
  });
});

describe('SchedStore', () => {
  it('load returns an empty state when no file exists', () => {
    const store = new SchedStore(dir);
    expect(store.load()).toEqual(createEmptyState());
  });

  it('save → load round-trips exactly', () => {
    const store = new SchedStore(dir);
    let state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 101, mode: 'full' },
        { issue: 201, mode: 'slot', batch: 'b1', deps: [101] },
      ],
      NOW
    );
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  it('a crash between writes never corrupts state (interrupted-write simulation)', () => {
    const store = new SchedStore(dir);
    const good = enqueueEntries(createEmptyState(), [{ issue: 1 }], NOW);
    store.save(good);
    // simulate: writer dies mid-write — tmp holds a partial payload, state.json still old
    fs.writeFileSync(`${store.statePath}.tmp`, '{"schema_version":"1.0.0","entr');
    expect(store.load()).toEqual(good); // last good state, tmp ignored
  });

  it('external corruption of state.json is a loud CorruptStateError, never a silent reset', () => {
    const store = new SchedStore(dir);
    fs.writeFileSync(store.statePath, '{ not json');
    expect(() => store.load()).toThrow(CorruptStateError);
    fs.writeFileSync(
      store.statePath,
      JSON.stringify({
        schema_version: '0.0.1',
        paused: false,
        entries: [],
        batches: [],
        slots: [],
        next_slot_id: 1,
      })
    );
    expect(() => store.load()).toThrow(/Unsupported schema version/);
  });

  it('withLock reads, mutates, and saves atomically', () => {
    const store = new SchedStore(dir);
    const depth = store.withLock((state) => {
      const next = enqueueEntries(state, [{ issue: 5 }, { issue: 6 }], NOW);
      return { state: next, result: next.entries.length };
    });
    expect(depth).toBe(2);
    expect(store.load().entries).toHaveLength(2);
  });

  it('withLock releases the lock even when the mutator throws', () => {
    const store = new SchedStore(dir);
    expect(() =>
      store.withLock(() => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(fs.existsSync(path.join(dir, '.sched-lock'))).toBe(false);
    // a subsequent withLock succeeds immediately
    expect(store.withLock((s) => ({ state: s, result: 'ok' }))).toBe('ok');
  });

  it('steals a lock left behind by a dead process', () => {
    const store = new SchedStore(dir);
    const lockDir = path.join(dir, '.sched-lock');
    fs.mkdirSync(lockDir);
    // a pid that definitely does not exist
    fs.writeFileSync(path.join(lockDir, 'pid'), '999999999');
    const result = store.withLock((s) => ({ state: s, result: 'stolen' }));
    expect(result).toBe('stolen');
  });

  it('config defaults to max_slots 3, persists overrides, and warns (not silently) on corrupt files', () => {
    const store = new SchedStore(dir);
    expect(store.loadConfig()).toEqual({ max_slots: 3 });
    store.saveConfig({ max_slots: 6 });
    expect(store.loadConfig()).toEqual({ max_slots: 6 });
    fs.writeFileSync(store.configPath, '{corrupt');
    const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.loadConfig()).toEqual({ max_slots: 3 });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0][0])).toContain('unreadable');
    warned.mockRestore();
  });

  it('validates what it loads (validateState integration)', () => {
    const store = new SchedStore(dir);
    const state = enqueueEntries(createEmptyState(), [{ issue: 1 }], NOW);
    store.save(state);
    const onDisk = JSON.parse(fs.readFileSync(store.statePath, 'utf-8'));
    expect(validateState(onDisk)).toEqual(state);
  });
});

describe('#468 config: pr_poll_interval_ms and dispatch.report_prompt', () => {
  it('round-trips the watcher cadence and the report prompt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-468-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({
        max_slots: 2,
        pr_poll_interval_ms: 120_000,
        dispatch: { report_prompt: 'custom report {issue} {pr} {cleanup}' },
      });
      const config = store.loadConfig();
      expect(config.max_slots).toBe(2);
      expect(config.pr_poll_interval_ms).toBe(120_000);
      expect(config.dispatch?.report_prompt).toBe('custom report {issue} {pr} {cleanup}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-positive pr_poll_interval_ms (degrades to defaults, loudly)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-468-'));
    try {
      const store = new SchedStore(dir);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({ schema_version: '1.2.0', max_slots: 2, pr_poll_interval_ms: 0 })
      );
      const err = console.error;
      const warnings: string[] = [];
      console.error = (msg: string) => warnings.push(msg);
      try {
        expect(store.loadConfig()).toEqual({ max_slots: 3 });
      } finally {
        console.error = err;
      }
      expect(warnings.some((w) => w.includes('unreadable'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads legacy 1.1.0 configs (dispatch without report_prompt)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-468-'));
    try {
      const store = new SchedStore(dir);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({
          schema_version: '1.1.0',
          max_slots: 4,
          dispatch: { command: ['claude', '-p'] },
        })
      );
      const config = store.loadConfig();
      expect(config.max_slots).toBe(4);
      expect(config.dispatch?.command).toEqual(['claude', '-p']);
      expect(config.dispatch?.report_prompt).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Writes a raw config file (module-level `dir`) and asserts it degrades to defaults with a warning matching every `expectedInMessage` fragment. */
function expectConfigRejected(rawConfig: unknown, ...expectedInMessage: string[]): void {
  const store = new SchedStore(dir);
  fs.writeFileSync(store.configPath, JSON.stringify(rawConfig));
  const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(store.loadConfig()).toEqual({ max_slots: 3 });
    const message = String(warned.mock.calls[0]?.[0]);
    expect(message).toContain('unreadable');
    for (const fragment of expectedInMessage) expect(message).toContain(fragment);
  } finally {
    warned.mockRestore();
  }
}

describe('#495 config: dispatch.phase_stall_timeout_ms', () => {
  it('round-trips a per-phase stall timeout override', () => {
    const store = new SchedStore(dir);
    store.saveConfig({
      max_slots: 2,
      dispatch: { phase_stall_timeout_ms: { implement: 5_400_000 } },
    });
    const config = store.loadConfig();
    expect(config.dispatch?.phase_stall_timeout_ms).toEqual({ implement: 5_400_000 });
  });

  it('rejects a non-positive phase timeout (degrades to defaults, loudly)', () => {
    expectConfigRejected(
      {
        schema_version: '1.2.0',
        max_slots: 2,
        dispatch: { phase_stall_timeout_ms: { implement: 0 } },
      },
      'phase_stall_timeout_ms.implement',
      'positive integer'
    );
  });

  it('rejects a non-object phase_stall_timeout_ms', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { phase_stall_timeout_ms: 'implement' } },
      'phase_stall_timeout_ms'
    );
  });

  it('rejects an array phase_stall_timeout_ms (not just non-object)', () => {
    expectConfigRejected(
      {
        schema_version: '1.2.0',
        max_slots: 2,
        dispatch: { phase_stall_timeout_ms: [90_000, 1_000] },
      },
      'phase_stall_timeout_ms'
    );
  });

  it('rejects an unrecognized phase key (typo protection)', () => {
    expectConfigRejected(
      {
        schema_version: '1.2.0',
        max_slots: 2,
        dispatch: { phase_stall_timeout_ms: { implment: 5_400_000 } },
      },
      "unknown phase 'implment'"
    );
  });

  it('accepts a batch-phase key (aggregate-mode units share the same stall check)', () => {
    const store = new SchedStore(dir);
    store.saveConfig({
      max_slots: 2,
      dispatch: { phase_stall_timeout_ms: { 'batch-review': 3_600_000 } },
    });
    expect(store.loadConfig().dispatch?.phase_stall_timeout_ms).toEqual({
      'batch-review': 3_600_000,
    });
  });
});

describe('#495 config: dispatch.fix_prompt (pre-existing gap in the function this PR extends)', () => {
  it('round-trips a custom fix prompt', () => {
    const store = new SchedStore(dir);
    store.saveConfig({
      max_slots: 2,
      dispatch: { fix_prompt: 'fix #{issue} in batch {batch}: {tests}' },
    });
    expect(store.loadConfig().dispatch?.fix_prompt).toBe('fix #{issue} in batch {batch}: {tests}');
  });

  it('rejects a non-string fix_prompt', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { fix_prompt: 42 } },
      'fix_prompt'
    );
  });
});
