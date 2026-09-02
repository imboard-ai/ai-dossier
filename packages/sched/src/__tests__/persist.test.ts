import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CorruptStateError,
  createEmptyState,
  DEFAULT_LABEL_POLL_INTERVAL_MS,
  EngineTooOldError,
  enqueueEntries,
  resolveDispatch,
  SCHEMA_VERSION,
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

  it('#537: a state file written by a newer schema than the installed engine refuses to run with a specific, actionable error — not the generic CorruptStateError', () => {
    const store = new SchedStore(dir);
    const [major, minor, patch] = SCHEMA_VERSION.split('.').map(Number);
    const newerVersion = `${major}.${minor}.${(patch ?? 0) + 1}`;
    fs.writeFileSync(
      store.statePath,
      JSON.stringify({
        schema_version: newerVersion,
        paused: false,
        entries: [],
        batches: [],
        slots: [],
        next_slot_id: 1,
      })
    );
    let caught: unknown;
    try {
      store.load();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineTooOldError);
    expect(caught).not.toBeInstanceOf(CorruptStateError);
    const err = caught as EngineTooOldError;
    expect(err.stateVersion).toBe(newerVersion);
    expect(err.installedVersion).toBe(SCHEMA_VERSION);
    expect(err.message).toContain(newerVersion);
    expect(err.message).toContain(SCHEMA_VERSION);
    expect(err.message).toContain('npm i -g @ai-dossier/cli@latest');
    // Must NOT carry the "rename or remove it" advice — that's actively
    // wrong for this case (another engine wrote this state; it isn't corrupt).
    expect(err.message).not.toMatch(/rename or remove/i);
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

describe('#504 config: dispatch.fence_takeover_timeout_ms', () => {
  it('round-trips the fence takeover timeout', () => {
    // Regression: the key was declared on DispatchConfig, read by resolveDispatch and
    // documented — but never copied by validateDispatchConfig's allowlist, so an
    // operator setting it got the default with no error and no warning.
    const store = new SchedStore(dir);
    store.saveConfig({ max_slots: 2, dispatch: { fence_takeover_timeout_ms: 60_000 } });
    expect(store.loadConfig().dispatch?.fence_takeover_timeout_ms).toBe(60_000);
  });

  it('survives a load alongside the other dispatch keys', () => {
    const store = new SchedStore(dir);
    store.saveConfig({
      max_slots: 2,
      dispatch: {
        fence_takeover_timeout_ms: 60_000,
        phase_stall_timeout_ms: { implement: 5_400_000 },
      },
    });
    const config = store.loadConfig();
    expect(config.dispatch?.fence_takeover_timeout_ms).toBe(60_000);
    expect(config.dispatch?.phase_stall_timeout_ms).toEqual({ implement: 5_400_000 });
  });

  it('rejects a non-positive fence takeover timeout (degrades to defaults, loudly)', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { fence_takeover_timeout_ms: 0 } },
      'fence_takeover_timeout_ms',
      'positive integer'
    );
  });
});

describe('#591 config: dispatch.disallowed_tools', () => {
  it('round-trips a custom disallowed-tools list', () => {
    const store = new SchedStore(dir);
    store.saveConfig({ max_slots: 2, dispatch: { disallowed_tools: ['Monitor', 'Other'] } });
    expect(store.loadConfig().dispatch?.disallowed_tools).toEqual(['Monitor', 'Other']);
  });

  it('round-trips the empty-array opt-out', () => {
    // [] is the documented way to disable --disallowedTools entirely — must not be
    // rejected the way an empty dispatch.command would be (that key requires non-empty).
    const store = new SchedStore(dir);
    store.saveConfig({ max_slots: 2, dispatch: { disallowed_tools: [] } });
    expect(store.loadConfig().dispatch?.disallowed_tools).toEqual([]);
  });

  it('rejects a non-array disallowed_tools', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { disallowed_tools: 'Monitor' } },
      'disallowed_tools'
    );
  });

  it('rejects an array containing a non-string entry', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { disallowed_tools: ['Monitor', 42] } },
      'disallowed_tools'
    );
  });

  it('rejects an array containing an empty string', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { disallowed_tools: [''] } },
      'disallowed_tools'
    );
  });
});

describe('#562 config: dispatch.suite_command', () => {
  it('round-trips an explicit aggregate suite command', () => {
    const store = new SchedStore(dir);
    store.saveConfig({ max_slots: 2, dispatch: { suite_command: ['make', 'test'] } });
    expect(store.loadConfig().dispatch?.suite_command).toEqual(['make', 'test']);
  });

  it('rejects an empty argv', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { suite_command: [] } },
      'suite_command'
    );
  });

  it('rejects a non-array value', () => {
    expectConfigRejected(
      { schema_version: '1.2.0', max_slots: 2, dispatch: { suite_command: 'make test' } },
      'suite_command'
    );
  });
});

describe('#527 config: dispatch.tiers (mixed agent-CLI escalation ladders)', () => {
  it('round-trips a per-tier full spawn spec', () => {
    // Regression guard for the #504-documented failure mode: a key declared on
    // DispatchConfig, read by resolveDispatch, but never copied by
    // validateDispatchConfig's allowlist silently reverts to the default.
    const store = new SchedStore(dir);
    store.saveConfig({
      max_slots: 2,
      dispatch: {
        tiers: {
          mid: { command: ['opencode', 'run', '--auto', '--model', '{model}'], model: 'glm' },
          strong: { command: ['claude', '-p', '--model', '{model}'], model: 'opus' },
        },
      },
    });
    const config = store.loadConfig();
    expect(config.dispatch?.tiers?.mid).toEqual({
      command: ['opencode', 'run', '--auto', '--model', '{model}'],
      model: 'glm',
    });
    expect(config.dispatch?.tiers?.strong).toEqual({
      command: ['claude', '-p', '--model', '{model}'],
      model: 'opus',
    });
  });

  it('a tier spec with only a prompt override round-trips', () => {
    const store = new SchedStore(dir);
    store.saveConfig({
      max_slots: 2,
      dispatch: { tiers: { mechanical: { prompt: 'cheap-tier prompt #{issue}' } } },
    });
    expect(store.loadConfig().dispatch?.tiers?.mechanical).toEqual({
      prompt: 'cheap-tier prompt #{issue}',
    });
  });

  it('rejects an unknown tier name', () => {
    expectConfigRejected(
      {
        schema_version: '1.3.0',
        max_slots: 2,
        dispatch: { tiers: { superstrong: { model: 'opus' } } },
      },
      'dispatch.tiers',
      'superstrong'
    );
  });

  it('rejects a tier spec with a malformed command', () => {
    expectConfigRejected(
      { schema_version: '1.3.0', max_slots: 2, dispatch: { tiers: { mid: { command: [] } } } },
      'dispatch.tiers.mid.command'
    );
  });

  it('rejects a tier spec with a non-string model', () => {
    expectConfigRejected(
      { schema_version: '1.3.0', max_slots: 2, dispatch: { tiers: { strong: { model: 42 } } } },
      'dispatch.tiers.strong.model'
    );
  });

  it('rejects a tiers value that is not an object', () => {
    expectConfigRejected(
      { schema_version: '1.3.0', max_slots: 2, dispatch: { tiers: ['mid'] } },
      'dispatch.tiers'
    );
  });

  it('a pre-#527 config (schema 1.3.0, top-level command + tier_models, no tiers) still loads — the shorthand migrates transparently', () => {
    const store = new SchedStore(dir);
    fs.writeFileSync(
      store.configPath,
      JSON.stringify({
        schema_version: '1.3.0',
        max_slots: 2,
        dispatch: {
          command: ['claude', '-p', '--output-format', 'json', '--model', '{model}'],
          tier_models: { mid: 'sonnet', strong: 'opus' },
        },
      })
    );
    const config = store.loadConfig();
    expect(config.dispatch?.command).toEqual([
      'claude',
      '-p',
      '--output-format',
      'json',
      '--model',
      '{model}',
    ]);
    expect(config.dispatch?.tier_models).toEqual({ mid: 'sonnet', strong: 'opus' });
    expect(config.dispatch?.tiers).toBeUndefined();
  });
});

describe('#565 config: default_batch_priority', () => {
  it('round-trips default_batch_priority through save/load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-565-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({ max_slots: 2, default_batch_priority: 25 });
      expect(store.loadConfig().default_batch_priority).toBe(25);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults default_batch_priority to undefined when absent from config.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-565-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({ max_slots: 2 });
      expect(store.loadConfig().default_batch_priority).toBeUndefined();
      expect(fs.readFileSync(store.configPath, 'utf-8')).not.toContain('default_batch_priority');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-integer default_batch_priority (degrades to defaults, loudly)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-565-'));
    try {
      const store = new SchedStore(dir);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({ schema_version: '1.4.0', max_slots: 2, default_batch_priority: 'high' })
      );
      const err = console.error;
      const warnings: string[] = [];
      console.error = (msg: string) => warnings.push(msg);
      try {
        expect(store.loadConfig()).toEqual({ max_slots: 3 });
      } finally {
        console.error = err;
      }
      expect(warnings[0]).toContain('default_batch_priority');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#537 config: auto_upgrade', () => {
  it('round-trips auto_upgrade through save/load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-537-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({ max_slots: 2, auto_upgrade: true });
      expect(store.loadConfig().auto_upgrade).toBe(true);

      store.saveConfig({ max_slots: 2, auto_upgrade: false });
      expect(store.loadConfig().auto_upgrade).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults auto_upgrade to undefined when absent from config.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-537-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({ max_slots: 2 });
      expect(store.loadConfig().auto_upgrade).toBeUndefined();
      expect(fs.readFileSync(store.configPath, 'utf-8')).not.toContain('auto_upgrade');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-boolean auto_upgrade (degrades to defaults, loudly)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-537-'));
    try {
      const store = new SchedStore(dir);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({ schema_version: '1.4.0', max_slots: 2, auto_upgrade: 'yes' })
      );
      const err = console.error;
      const warnings: string[] = [];
      console.error = (msg: string) => warnings.push(msg);
      try {
        expect(store.loadConfig()).toEqual({ max_slots: 3 });
      } finally {
        console.error = err;
      }
      expect(warnings[0]).toContain('auto_upgrade');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#563 config: dissolve_policy', () => {
  it('round-trips dissolve_policy through save/load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-563-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({
        max_slots: 2,
        dissolve_policy: { fraction: 1 / 4, min_evictions_before_dissolve: 2 },
      });
      expect(store.loadConfig().dissolve_policy).toEqual({
        fraction: 1 / 4,
        min_evictions_before_dissolve: 2,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults dissolve_policy to undefined when absent from config.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-563-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({ max_slots: 2 });
      expect(store.loadConfig().dissolve_policy).toBeUndefined();
      expect(fs.readFileSync(store.configPath, 'utf-8')).not.toContain('dissolve_policy');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [{ fraction: 0, min_evictions_before_dissolve: 1 }, 'fraction'],
    [{ fraction: 1.5, min_evictions_before_dissolve: 1 }, 'fraction'],
    [{ fraction: 1 / 3, min_evictions_before_dissolve: 0 }, 'min_evictions_before_dissolve'],
    [{ fraction: 1 / 3, min_evictions_before_dissolve: 1.5 }, 'min_evictions_before_dissolve'],
  ])('rejects an invalid dissolve_policy %j (degrades to defaults, loudly)', (bad, badKey) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-563-'));
    try {
      const store = new SchedStore(dir);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({ schema_version: '1.4.0', max_slots: 2, dissolve_policy: bad })
      );
      const err = console.error;
      const warnings: string[] = [];
      console.error = (msg: string) => warnings.push(msg);
      try {
        expect(store.loadConfig()).toEqual({ max_slots: 3 });
      } finally {
        console.error = err;
      }
      expect(warnings[0]).toContain(badKey);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#544 config: label_poll_interval_ms', () => {
  it('round-trips the label re-read cadence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-544-'));
    try {
      const store = new SchedStore(dir);
      store.saveConfig({ max_slots: 2, label_poll_interval_ms: 90_000 });
      expect(store.loadConfig().label_poll_interval_ms).toBe(90_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a pre-#544 1.4.0 config, leaving the cadence at the engine default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-544-'));
    try {
      const store = new SchedStore(dir);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({ schema_version: '1.4.0', max_slots: 2, pr_poll_interval_ms: 120_000 })
      );
      const config = store.loadConfig();
      expect(config.max_slots).toBe(2);
      expect(config.label_poll_interval_ms).toBeUndefined();
      expect(resolveDispatch(config).labelPollIntervalMs).toBe(DEFAULT_LABEL_POLL_INTERVAL_MS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-positive label_poll_interval_ms (degrades to defaults, loudly)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-544-'));
    try {
      const store = new SchedStore(dir);
      fs.writeFileSync(
        store.configPath,
        JSON.stringify({ schema_version: '1.5.0', max_slots: 2, label_poll_interval_ms: -1 })
      );
      const err = console.error;
      const warnings: string[] = [];
      console.error = (msg: string) => warnings.push(msg);
      try {
        expect(store.loadConfig()).toEqual({ max_slots: 3 });
      } finally {
        console.error = err;
      }
      expect(warnings.join('\n')).toContain('label_poll_interval_ms');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
