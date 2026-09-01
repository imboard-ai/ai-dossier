import { describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  buildFixPrompt,
  buildPrompt,
  buildReportPrompt,
  DEFAULT_DISPATCH_COMMAND,
  DEFAULT_FIX_PROMPT_TEMPLATE,
  DEFAULT_REPORT_PROMPT_TEMPLATE,
  DEFAULT_TIER_MODELS,
  escalateTier,
  NO_BACKGROUND_EXIT_INSTRUCTION,
  OPENCODE_DISPATCH_COMMAND,
  reportTierFor,
  resolveDispatch,
  type SchedConfig,
  stallTimeoutForPhase,
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

  it('opencode template includes --auto so headless dispatch does not auto-reject external_directory prompts (#506)', () => {
    expect(OPENCODE_DISPATCH_COMMAND).toContain('--auto');
    const argv = buildAgentCommand(OPENCODE_DISPATCH_COMMAND, 'mid', 506, DEFAULT_TIER_MODELS);
    expect(argv).toEqual(['opencode', 'run', '--auto', '--format', 'json', '--model', 'sonnet']);
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
    expect(resolved.phaseStallTimeoutMs).toEqual({ implement: 90 * 60 * 1000 });
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

  it('#495: an operator phase_stall_timeout_ms override merges with, and can override, the built-in implement default', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: { phase_stall_timeout_ms: { implement: 5_000, review: 10_000 } },
    });
    expect(resolved.phaseStallTimeoutMs).toEqual({ implement: 5_000, review: 10_000 });
  });
});

describe('stallTimeoutForPhase (#495)', () => {
  it('uses the phase override when one exists', () => {
    const resolved = resolveDispatch({ max_slots: 1 });
    expect(stallTimeoutForPhase(resolved, 'implement')).toBe(90 * 60 * 1000);
  });

  it('falls back to the global stall timeout for a phase with no override', () => {
    const resolved = resolveDispatch({ max_slots: 1, stall_timeout_ms: 42_000 });
    expect(stallTimeoutForPhase(resolved, 'plan')).toBe(42_000);
  });

  it('falls back to the global stall timeout when phase is null', () => {
    const resolved = resolveDispatch({ max_slots: 1, stall_timeout_ms: 42_000 });
    expect(stallTimeoutForPhase(resolved, null)).toBe(42_000);
  });

  it('an inherited Object.prototype key is not an override (hardening)', () => {
    const resolved = resolveDispatch({ max_slots: 1, stall_timeout_ms: 42_000 });
    for (const p of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(stallTimeoutForPhase(resolved, p)).toBe(42_000);
    }
  });

  it('the "done" sentinel (a legal next= value) is not a phase override', () => {
    const resolved = resolveDispatch({ max_slots: 1, stall_timeout_ms: 42_000 });
    expect(stallTimeoutForPhase(resolved, 'done')).toBe(42_000);
  });

  it('a built-in phase default is a FLOOR against a larger global stall_timeout_ms, never shortened by it', () => {
    const resolved = resolveDispatch({ max_slots: 1, stall_timeout_ms: 3 * 60 * 60 * 1000 });
    expect(stallTimeoutForPhase(resolved, 'implement')).toBe(3 * 60 * 60 * 1000);
    // a phase with no built-in default still just uses the (now larger) global
    expect(stallTimeoutForPhase(resolved, 'plan')).toBe(3 * 60 * 60 * 1000);
  });

  it('an explicit phase override always wins, even below the built-in default', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      stall_timeout_ms: 3 * 60 * 60 * 1000,
      dispatch: { phase_stall_timeout_ms: { implement: 5_000 } },
    });
    expect(stallTimeoutForPhase(resolved, 'implement')).toBe(5_000);
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

  it('refuses to signal a pid whose recorded start-time no longer matches (decision 1, option C)', async () => {
    const { createSpawnDeps } = await import('../index');
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
      const start = deps.processStart(pid);
      if (process.platform === 'linux' && start !== null) {
        // /proc is available: a WRONG recorded start-time (what a reused pid
        // would show) must make kill/isAlive refuse the pid.
        expect(deps.isAlive(pid, start + 999999)).toBe(false);
        expect(deps.kill(pid, start + 999999)).toBe(false);
        // The correct recorded start-time still allows the signal.
        expect(deps.kill(pid, start)).toBe(true);
      } else {
        // No /proc (macOS/Windows): best-effort — the recorded start cannot
        // be verified, so signals go through.
        expect(deps.kill(pid)).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(deps.isAlive(pid)).toBe(false);
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

// --- #468: report dispatch ---

describe('report dispatch (#468 AC2)', () => {
  it('the default prompt is detached ship mode (park and stop)', () => {
    const resolved = resolveDispatch({ max_slots: 1 });
    expect(resolved.prompt).toContain('detached');
    expect(resolved.prompt).toContain('auto-merge');
    expect(resolved.prompt).toContain('STOP');
    // the tail is the scheduler's, not the agent's
    expect(resolved.prompt).toContain('scheduler');
  });

  it('buildReportPrompt substitutes issue, pr, and cleanup', () => {
    const out = buildReportPrompt(
      'Report for #{issue} — PR #{pr} — cleanup {cleanup}',
      468,
      55,
      'failed-pool-return'
    );
    expect(out).toBe('Report for #468 — PR #55 — cleanup failed-pool-return');
  });

  it('report prompts are configurable via dispatch.report_prompt', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: { report_prompt: 'custom report {issue}/{pr}/{cleanup}' },
    });
    expect(resolved.reportPrompt).toBe('custom report {issue}/{pr}/{cleanup}');
  });

  it('reportTierFor climbs mechanical → mid → strong and stops', () => {
    expect(reportTierFor(0)).toBe('mechanical');
    expect(reportTierFor(1)).toBe('mid');
    expect(reportTierFor(2)).toBe('strong');
    expect(reportTierFor(3)).toBeNull();
    expect(reportTierFor(99)).toBeNull();
  });

  it('prPollIntervalMs resolves from config with the 2-3 minute default', () => {
    expect(resolveDispatch({ max_slots: 1 }).prPollIntervalMs).toBe(150_000);
    expect(resolveDispatch({ max_slots: 1, pr_poll_interval_ms: 120_000 }).prPollIntervalMs).toBe(
      120_000
    );
  });
});

// --- #497: never exit while a background build/test command still runs ---

describe('background-exit hardening (#497)', () => {
  it('the default full-cycle prompt tells the agent never to exit on a background wait', () => {
    const resolved = resolveDispatch({ max_slots: 1 });
    expect(resolved.prompt).toContain(NO_BACKGROUND_EXIT_INSTRUCTION);
  });

  it('the default fix prompt tells the agent never to exit on a background wait', () => {
    expect(DEFAULT_FIX_PROMPT_TEMPLATE).toContain(NO_BACKGROUND_EXIT_INSTRUCTION);
    const out = buildFixPrompt(DEFAULT_FIX_PROMPT_TEMPLATE, 497, 'b1', ['a.test.ts']);
    expect(out).toContain(NO_BACKGROUND_EXIT_INSTRUCTION);
  });

  it('the report prompt is deliberately excluded — it never spawns a build/test command', () => {
    expect(DEFAULT_REPORT_PROMPT_TEMPLATE).not.toContain(NO_BACKGROUND_EXIT_INSTRUCTION);
  });
});
