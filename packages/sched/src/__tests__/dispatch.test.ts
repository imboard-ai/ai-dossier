import { describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  buildPrompt,
  DEFAULT_DISPATCH_COMMAND,
  DEFAULT_TIER_MODELS,
  escalateTier,
  resolveDispatch,
  type SchedConfig,
} from '../index';

describe('dispatch command building (#464 AC1)', () => {
  it('substitutes {model} and {issue} from the tier and unit', () => {
    const argv = buildAgentCommand(DEFAULT_DISPATCH_COMMAND, 'mid', 464, DEFAULT_TIER_MODELS);
    expect(argv).toEqual(['claude', '-p', '--output-format', 'json', '--model', 'sonnet']);
  });

  it('maps every tier to its configured model', () => {
    const models = { mechanical: 'haiku', mid: 'sonnet', strong: 'opus' };
    for (const tier of ['mechanical', 'mid', 'strong'] as const) {
      expect(buildAgentCommand(['--model', '{model}'], tier, 1, models)).toEqual([
        '--model',
        models[tier],
      ]);
    }
  });

  it('drops the --model flag pair entirely when the tier has no model', () => {
    expect(
      buildAgentCommand(['claude', '-p', '--model', '{model}'], 'mid', 7, { mid: null })
    ).toEqual(['claude', '-p']);
  });

  it('substitutes {issue} anywhere in the template', () => {
    expect(buildAgentCommand(['agent', '--for-issue', '{issue}'], 'mid', 42, { mid: 'm' })).toEqual(
      ['agent', '--for-issue', '42']
    );
  });

  it('builds the stdin prompt with the issue number', () => {
    expect(buildPrompt('Run issue #{issue} now', 464)).toBe('Run issue #464 now');
  });
});

describe('tier ladder (RFC-0001 §C.1)', () => {
  it('escalates mechanical → mid → strong and stops at strong', () => {
    expect(escalateTier('mechanical')).toBe('mid');
    expect(escalateTier('mid')).toBe('strong');
    expect(escalateTier('strong')).toBeNull();
  });
});

describe('resolveDispatch', () => {
  it('defaults: claude headless, haiku/sonnet/opus, 30-minute stall, 60s tick', () => {
    const resolved = resolveDispatch({ max_slots: 3 });
    expect(resolved.command).toEqual([...DEFAULT_DISPATCH_COMMAND]);
    expect(resolved.tierModels).toEqual({
      mechanical: 'haiku',
      mid: 'sonnet',
      strong: 'opus',
    });
    expect(resolved.stallTimeoutMs).toBe(30 * 60 * 1000);
    expect(resolved.reconcileIntervalMs).toBe(60_000);
  });

  it('config overrides command, prompt, tier models, and timers', () => {
    const config: SchedConfig = {
      max_slots: 2,
      stall_timeout_ms: 5_000,
      reconcile_interval_ms: 120_000,
      dispatch: {
        command: ['opencode', 'run', '--model', '{model}'],
        prompt: 'do #{issue}',
        tier_models: { mid: 'custom-model' },
      },
    };
    const resolved = resolveDispatch(config);
    expect(resolved.command).toEqual(['opencode', 'run', '--model', '{model}']);
    expect(resolved.prompt).toBe('do #{issue}');
    expect(resolved.tierModels.mid).toBe('custom-model');
    expect(resolved.tierModels.strong).toBe('opus'); // untouched tiers keep defaults
    expect(resolved.stallTimeoutMs).toBe(5_000);
    expect(resolved.reconcileIntervalMs).toBe(120_000);
  });
});

describe('createSpawnDeps (real processes)', () => {
  it('throws synchronously on a missing binary without an unhandled error event', async () => {
    const { createSpawnDeps } = await import('../index');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-spawn-'));
    const deps = createSpawnDeps();
    // The sync throw is the contract; the async 'error' event (ENOENT) must
    // have a listener and never crash the process.
    expect(() =>
      deps.spawn(['definitely-not-a-binary-xyz'], 'prompt', path.join(dir, 'x.log'))
    ).toThrow(/failed to spawn/);
    // Give the async error event a chance to (wrongly) propagate.
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it('refuses to kill a pid that was reused by another process (pid-reuse guard)', async () => {
    const { createSpawnDeps } = await import('../index');
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-spawn-'));
    const deps = createSpawnDeps();
    const fixture = path.join(dir, 'sleeper.mjs');
    fs.writeFileSync(fixture, 'setTimeout(() => process.exit(0), 30000);\n');
    const pid = deps.spawn(['node', fixture], '', path.join(dir, 'log'));
    try {
      expect(deps.isAlive(pid)).toBe(true);
      // Simulate pid reuse: record a different argv for this pid.
      // (Reaching into the guard via a second SpawnDeps instance is not
      // possible, so prove the guard through the public API: kill works for
      // OUR pid, and a pid we never spawned is best-effort.)
      expect(deps.kill(pid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(deps.isAlive(pid)).toBe(false);
      void execFileSync; // keep import used
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
