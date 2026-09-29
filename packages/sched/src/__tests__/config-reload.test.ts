import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigReloader, dispatchDiff, resolveProfiledDispatch, SchedStore } from '../index';

let dir: string;
let store: SchedStore;
let bump = 0;

/** Write config.json with the given `mid` model on profile `anthropic`; bump mtime so the edit is always seen. */
function writeConfig(mid: string, raw?: string): void {
  fs.writeFileSync(
    store.configPath,
    raw ??
      JSON.stringify({
        schema_version: '1.9.0',
        max_slots: 2,
        dispatch: { dispatch_profiles: { anthropic: { tier_models: { mid } } } },
      })
  );
  bump += 5;
  const at = new Date(Date.now() + bump * 1000);
  fs.utimesSync(store.configPath, at, at);
}

const midModel = (config: ReturnType<SchedStore['loadConfig']>): string | null =>
  resolveProfiledDispatch(config, 'anthropic').tiers.mid.model;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-reload-test-'));
  store = new SchedStore(path.join(dir, 'sched', 'project'), path.join(dir, 'user.json'));
  fs.mkdirSync(store.dir, { recursive: true });
  writeConfig('opus');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createConfigReloader (#883)', () => {
  const make = (extra: Partial<Parameters<typeof createConfigReloader>[0]> = {}) => {
    const load = vi.fn(() => store.loadConfigStrict());
    const onReload = vi.fn();
    const onInvalid = vi.fn();
    const reloader = createConfigReloader({
      initial: store.loadConfigStrict(),
      load,
      fingerprint: () => store.configFingerprint(),
      onReload,
      onInvalid,
      ...extra,
    });
    return { reloader, load, onReload, onInvalid };
  };

  it('dispatches the NEW model after a profile edit, without a restart', () => {
    const { reloader, onReload } = make();
    expect(midModel(reloader.current())).toBe('opus');

    writeConfig('sonnet');

    const next = reloader.current();
    expect(midModel(next)).toBe('sonnet');
    expect(onReload).toHaveBeenCalledTimes(1);
    const changes = onReload.mock.calls[0][1] as string[];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^anthropic: .*mid=claude\/opus.* -> .*mid=claude\/sonnet/);
  });

  it('does not re-parse the config while the files are unchanged', () => {
    const { reloader, load } = make();
    reloader.current();
    reloader.current();
    expect(load).not.toHaveBeenCalled();
    writeConfig('sonnet');
    reloader.current();
    reloader.current();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good config on an invalid edit and reports it once per edit', () => {
    const { reloader, onInvalid, onReload } = make();
    writeConfig('opus', '{ this is not json');

    expect(midModel(reloader.current())).toBe('opus');
    reloader.current();
    reloader.current();
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();

    // A schema-invalid edit is rejected too — never a silent revert to defaults.
    writeConfig('opus', JSON.stringify({ schema_version: '1.9.0', max_slots: 999, dispatch: {} }));
    expect(reloader.current().max_slots).toBe(2);
    expect(onInvalid).toHaveBeenCalledTimes(2);

    writeConfig('haiku');
    expect(midModel(reloader.current())).toBe('haiku');
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('re-applies startup overrides (derive) to a reloaded config', () => {
    const { reloader } = make({
      derive: (config) => ({ ...config, reconcile_interval_ms: 7000 }),
    });
    writeConfig('sonnet');
    const next = reloader.current();
    expect(next.reconcile_interval_ms).toBe(7000);
    expect(midModel(next)).toBe('sonnet');
  });

  it('a broken user config does not block a valid project reload, and is reported by file', () => {
    const messages: string[] = [];
    const { reloader, onInvalid } = make({
      load: () => store.loadConfigStrict((m) => messages.push(m)),
    });
    fs.writeFileSync(path.join(dir, 'user.json'), '{ nope');
    writeConfig('sonnet');
    expect(midModel(reloader.current())).toBe('sonnet');
    expect(onInvalid).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(path.join(dir, 'user.json'));
  });

  it('a throwing onReload observer does not read as an invalid config', () => {
    const { reloader, onInvalid } = make({
      onReload: () => {
        throw new Error('journal full');
      },
    });
    writeConfig('sonnet');
    expect(midModel(reloader.current())).toBe('sonnet');
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('an edit made between the initial load and the reloader is not marked seen', () => {
    const before = store.configFingerprint();
    const initial = store.loadConfigStrict();
    writeConfig('sonnet');
    const reloader = createConfigReloader({
      initial,
      initialFingerprint: before,
      load: () => store.loadConfigStrict(),
      fingerprint: () => store.configFingerprint(),
    });
    expect(midModel(reloader.current())).toBe('sonnet');
  });

  it('a user-level profile edit reloads too', () => {
    const { reloader } = make();
    fs.writeFileSync(
      path.join(dir, 'user.json'),
      JSON.stringify({ dispatch_profiles: { glm: { tier_models: { mid: 'glm-5.3' } } } })
    );
    const next = reloader.current();
    expect(Object.keys(next.dispatch?.dispatch_profiles ?? {}).sort()).toEqual([
      'anthropic',
      'glm',
    ]);
  });
});

describe('SchedStore.loadConfigStrict (#883)', () => {
  it('throws where loadConfig degrades to defaults', () => {
    writeConfig('opus', '{ nope');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(store.loadConfig().max_slots).toBeDefined();
    err.mockRestore();
    expect(() => store.loadConfigStrict()).toThrow();
  });

  it('tolerates unreadable user profiles, reporting through the callback', () => {
    fs.writeFileSync(path.join(dir, 'user.json'), '{ nope');
    const seen: string[] = [];
    expect(store.loadConfigStrict((m) => seen.push(m)).max_slots).toBe(2);
    expect(seen).toHaveLength(1);
  });
});

describe('dispatchDiff', () => {
  it('is empty when nothing dispatch-shaping changed', () => {
    const config = store.loadConfigStrict();
    expect(dispatchDiff(config, { ...config, max_slots: 3 })).toEqual([]);
  });
});
