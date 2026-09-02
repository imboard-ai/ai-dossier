import { describe, expect, it } from 'vitest';
import {
  buildAgentCommand,
  buildFixPrompt,
  buildPrompt,
  buildReportPrompt,
  buildTierCommand,
  DEFAULT_DISPATCH_COMMAND,
  DEFAULT_FIX_PROMPT_TEMPLATE,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_REPORT_PROMPT_TEMPLATE,
  DEFAULT_TIER_MODELS,
  escalateTier,
  journalCmdModelFields,
  NO_BACKGROUND_EXIT_INSTRUCTION,
  OPENCODE_DISPATCH_COMMAND,
  reportTierFor,
  resolveDispatch,
  resolveTierSpawn,
  type SchedConfig,
  SUPERSESSION_CHECKPOINT_INSTRUCTION,
  stallTimeoutForPhase,
  stallTimeoutForSlot,
} from '../index';

describe('dispatch command building (#464 AC1)', () => {
  it('substitutes {model} and {issue} from the tier and unit', () => {
    const argv = buildAgentCommand(DEFAULT_DISPATCH_COMMAND, 'mid', 464, DEFAULT_TIER_MODELS);
    expect(argv).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'sonnet',
    ]);
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
    // #591: --disallowedTools Monitor is appended by default for claude-family commands.
    expect(resolved.command).toEqual([...DEFAULT_DISPATCH_COMMAND, '--disallowedTools', 'Monitor']);
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
    // The configured body is preserved verbatim; #504 appends the supersession
    // checkpoint on top, so a customised prompt keeps the safety instruction.
    expect(resolved.prompt).toContain('do #{issue}');
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

describe('--disallowedTools hardening (#591 — a headless exit must never hide behind an armed Monitor)', () => {
  it('appends --disallowedTools Monitor to the default claude command', () => {
    const resolved = resolveDispatch({ max_slots: 1 });
    expect(resolved.command).toEqual([...DEFAULT_DISPATCH_COMMAND, '--disallowedTools', 'Monitor']);
  });

  it('appends --disallowedTools Monitor to every tier resolved from the claude shorthand', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: { command: ['claude', '-p', '--model', '{model}'] },
    });
    for (const tier of ['mechanical', 'mid', 'strong'] as const) {
      expect(resolved.tiers[tier].commandTemplate).toEqual([
        'claude',
        '-p',
        '--model',
        '{model}',
        '--disallowedTools',
        'Monitor',
      ]);
    }
  });

  it('dispatch.disallowed_tools: [] opts out on the top-level command and every tier', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: { command: ['claude', '-p', '--model', '{model}'], disallowed_tools: [] },
    });
    expect(resolved.command).toEqual(['claude', '-p', '--model', '{model}']);
    for (const tier of ['mechanical', 'mid', 'strong'] as const) {
      expect(resolved.tiers[tier].commandTemplate).toEqual(['claude', '-p', '--model', '{model}']);
    }
  });

  it('a custom disallowed_tools list joins with a comma', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: { disallowed_tools: ['Monitor', 'SomeOtherTool'] },
    });
    expect(resolved.command).toEqual([
      ...DEFAULT_DISPATCH_COMMAND,
      '--disallowedTools',
      'Monitor,SomeOtherTool',
    ]);
  });

  it('never applied to a non-claude command, even when a tier overrides to opencode', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: {
        tiers: {
          strong: { command: ['opencode', 'run', '--auto', '--model', '{model}'], model: 'glm' },
        },
      },
    });
    expect(resolved.tiers.strong.commandTemplate).toEqual([
      'opencode',
      'run',
      '--auto',
      '--model',
      '{model}',
    ]);
    // untouched tiers still fall back to the claude default and get the flag
    expect(resolved.tiers.mid.commandTemplate).toContain('--disallowedTools');
  });

  it('an explicit claude tier override also gets the flag (not only the shorthand fallback)', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: {
        tiers: { strong: { command: ['claude', '-p', '--model', '{model}'], model: 'opus' } },
      },
    });
    expect(resolved.tiers.strong.commandTemplate).toEqual([
      'claude',
      '-p',
      '--model',
      '{model}',
      '--disallowedTools',
      'Monitor',
    ]);
  });
});

describe('per-tier dispatch (#527 — mixed agent-CLI escalation ladders)', () => {
  it('with no dispatch.tiers configured, every tier falls back to the shorthand (command/tier_models/prompt)', () => {
    const config: SchedConfig = {
      max_slots: 1,
      dispatch: {
        command: ['claude', '-p', '--model', '{model}'],
        tier_models: { mid: 'custom-model' },
        prompt: 'do #{issue}',
        disallowed_tools: [], // #591: opt out — this test is about tier fallback, not the flag
      },
    };
    const resolved = resolveDispatch(config);
    for (const tier of ['mechanical', 'mid', 'strong'] as const) {
      expect(resolved.tiers[tier].commandTemplate).toEqual(['claude', '-p', '--model', '{model}']);
      expect(resolved.tiers[tier].prompt).toContain('do #{issue}');
    }
    expect(resolved.tiers.mechanical.model).toBe('haiku'); // default, untouched
    expect(resolved.tiers.mid.model).toBe('custom-model'); // tier_models override
    expect(resolved.tiers.strong.model).toBe('opus'); // default, untouched
  });

  it('an explicit dispatch.tiers entry overrides the shorthand per-field for that tier only', () => {
    const config: SchedConfig = {
      max_slots: 1,
      dispatch: {
        command: ['claude', '-p', '--model', '{model}'],
        tier_models: { mid: 'sonnet', strong: 'opus' },
        tiers: {
          mid: { command: ['opencode', 'run', '--auto', '--model', '{model}'], model: 'glm' },
        },
        disallowed_tools: [], // #591: opt out — this test is about tier override, not the flag
      },
    };
    const resolved = resolveDispatch(config);
    // mid: fully overridden by dispatch.tiers.mid
    expect(resolved.tiers.mid.commandTemplate).toEqual([
      'opencode',
      'run',
      '--auto',
      '--model',
      '{model}',
    ]);
    expect(resolved.tiers.mid.model).toBe('glm');
    // strong: no tiers entry — falls back to the shorthand unchanged
    expect(resolved.tiers.strong.commandTemplate).toEqual(['claude', '-p', '--model', '{model}']);
    expect(resolved.tiers.strong.model).toBe('opus');
  });

  it('a tiers entry may override only one field, falling back to the shorthand for the rest', () => {
    const config: SchedConfig = {
      max_slots: 1,
      dispatch: {
        command: ['claude', '-p', '--model', '{model}'],
        tiers: { strong: { model: 'custom-strong-model' } },
        disallowed_tools: [], // #591: opt out — this test is about tier override, not the flag
      },
    };
    const resolved = resolveDispatch(config);
    expect(resolved.tiers.strong.commandTemplate).toEqual(['claude', '-p', '--model', '{model}']);
    expect(resolved.tiers.strong.model).toBe('custom-strong-model');
  });

  it('buildTierCommand matches buildAgentCommand when no tiers override is set (back-compat parity)', () => {
    const resolved = resolveDispatch({ max_slots: 1 });
    expect(buildTierCommand(resolved, 'mid', 464)).toEqual(
      buildAgentCommand(resolved.command, 'mid', 464, resolved.tierModels)
    );
  });

  it('buildTierCommand produces a different argv (different binary) when the tier has its own command', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: {
        tiers: {
          mid: { command: ['opencode', 'run', '--auto', '--model', '{model}'], model: 'glm' },
          strong: { command: ['claude', '-p', '--model', '{model}'], model: 'opus' },
        },
        disallowed_tools: [], // #591: opt out — this test is about mixed-CLI resolution, not the flag
      },
    });
    expect(buildTierCommand(resolved, 'mid', 527)).toEqual([
      'opencode',
      'run',
      '--auto',
      '--model',
      'glm',
    ]);
    expect(buildTierCommand(resolved, 'strong', 527)).toEqual(['claude', '-p', '--model', 'opus']);
  });

  it('an explicit dispatch.tiers.<tier>.prompt override gets the supersession checkpoint too, same as the shorthand', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: { tiers: { strong: { prompt: 'strong-tier custom prompt #{issue}' } } },
    });
    expect(resolved.tiers.strong.prompt).toContain('strong-tier custom prompt #{issue}');
    expect(resolved.tiers.strong.prompt).toContain(SUPERSESSION_CHECKPOINT_INSTRUCTION);
    // a tier with no override still falls back to the (already-checkpointed) global prompt
    expect(resolved.tiers.mid.prompt).toContain(SUPERSESSION_CHECKPOINT_INSTRUCTION);
  });

  it('resolveTierSpawn + journalCmdModelFields resolve cmd/model together and format them for the journal', () => {
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: {
        tiers: { mid: { command: ['opencode', 'run', '--model', '{model}'], model: 'glm' } },
      },
    });
    const spawn = resolveTierSpawn(resolved, 'mid', 527);
    expect(spawn.cmd).toEqual(['opencode', 'run', '--model', 'glm']);
    expect(spawn.model).toBe('glm');
    expect(journalCmdModelFields(spawn)).toEqual({ cmd: 'opencode run --model glm', model: 'glm' });
  });

  it('journalCmdModelFields omits model when the tier has none', () => {
    const spawn = { cmd: ['claude', '-p'], model: null };
    expect(journalCmdModelFields(spawn)).toEqual({ cmd: 'claude -p' });
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

describe('takeover prompts (#504)', () => {
  it('leaves a first dispatch prompt untouched', () => {
    const prompt = buildPrompt('Run the workflow for #{issue}.', 504);
    expect(prompt).toBe('Run the workflow for #504.');
    expect(prompt).not.toContain('TAKEOVER');
  });

  it('appends the takeover instruction for a generation above zero', () => {
    const prompt = buildPrompt('Run the workflow for #{issue}.', 504, 2);
    expect(prompt).toContain('Run the workflow for #504.');
    expect(prompt).toContain('generation 2');
    expect(prompt).toContain('--gen 2');
    expect(prompt).toContain('runstate check --issue 504');
    // It must resume rather than restart — the fence exists because the work is shared.
    expect(prompt).toContain('Resume the existing work');
  });

  it('substitutes {gen} for templates that place it themselves', () => {
    expect(buildPrompt('gen={gen} issue={issue}', 7, 3)).toContain('gen=3 issue=7');
  });
});

describe('stallTimeoutForSlot (#504)', () => {
  const dispatch = resolveDispatch({
    max_slots: 1,
    stall_timeout_ms: 60 * 60 * 1000,
    dispatch: { fence_takeover_timeout_ms: 15 * 60 * 1000 },
  });

  it('uses the phase allowance when no takeover is pending', () => {
    expect(stallTimeoutForSlot(dispatch, 'plan', null)).toBe(60 * 60 * 1000);
  });

  it('shortens to the fence window while a takeover has posted nothing', () => {
    expect(stallTimeoutForSlot(dispatch, 'plan', '2026-08-29T12:00:00Z')).toBe(15 * 60 * 1000);
  });

  it('never lengthens a phase whose own allowance is already shorter', () => {
    // A takeover must not get MORE time than a first dispatch would have had.
    const tight = resolveDispatch({
      max_slots: 1,
      stall_timeout_ms: 5 * 60 * 1000,
      dispatch: { fence_takeover_timeout_ms: 15 * 60 * 1000 },
    });
    expect(stallTimeoutForSlot(tight, 'plan', '2026-08-29T12:00:00Z')).toBe(5 * 60 * 1000);
  });

  it('defaults the fence window to fifteen minutes', () => {
    const defaults = resolveDispatch({ max_slots: 1 });
    expect(defaults.fenceTakeoverTimeoutMs).toBe(15 * 60 * 1000);
  });
});

describe('supersession checkpoint in the default prompt (#504 AC2)', () => {
  it('tells EVERY dispatched run to check, not only takeovers', () => {
    // The run that gets fenced is the one already running — generation 0, like any first
    // dispatch. Instructing only takeovers would leave the zombie with no instruction to
    // stop, which is the whole point of the AC.
    const prompt = buildPrompt(DEFAULT_PROMPT_TEMPLATE, 504);
    expect(prompt).toContain('SUPERSESSION CHECKPOINT');
    expect(prompt).toContain('before implement, before review, and before ship');
    expect(prompt).toContain('runstate check --issue 504');
    expect(prompt).toContain('--gen 0');
    expect(prompt).toContain('--comment');
  });

  it('substitutes the takeover’s generation into the checkpoint', () => {
    expect(buildPrompt(DEFAULT_PROMPT_TEMPLATE, 504, 2)).toContain('--gen 2');
  });

  it('names a refused post as the same stop signal', () => {
    expect(buildPrompt(DEFAULT_PROMPT_TEMPLATE, 504)).toContain('SUPERSEDED');
  });

  it('keeps the pre-existing headless instruction', () => {
    expect(buildPrompt(DEFAULT_PROMPT_TEMPLATE, 504)).toContain(NO_BACKGROUND_EXIT_INSTRUCTION);
  });
});

describe('buildReportPrompt generations (#504)', () => {
  it('leaves a first report dispatch untouched', () => {
    const prompt = buildReportPrompt(DEFAULT_REPORT_PROMPT_TEMPLATE, 504, 77, 'done');
    expect(prompt).toContain('#504');
    expect(prompt).toContain('#77');
    expect(prompt).not.toContain('TAKEOVER');
  });

  it('appends the takeover instruction for a fenced report agent', () => {
    const prompt = buildReportPrompt(DEFAULT_REPORT_PROMPT_TEMPLATE, 504, 77, 'done', 3);
    expect(prompt).toContain('TAKEOVER');
    expect(prompt).toContain('--gen 3');
  });
});

describe('the checkpoint survives an operator prompt override (#504)', () => {
  it('appends the checkpoint to a configured prompt', () => {
    // A safety instruction that lives only on the built-in constant stops protecting
    // exactly the deployments that customised their prompt.
    const resolved = resolveDispatch({
      max_slots: 1,
      dispatch: { prompt: 'Do the thing for #{issue}.' },
    });
    expect(resolved.prompt).toContain('SUPERSESSION CHECKPOINT');
    expect(buildPrompt(resolved.prompt, 504)).toContain('runstate check --issue 504');
  });

  it('does not append it twice to the default', () => {
    const resolved = resolveDispatch({ max_slots: 1 });
    const occurrences = resolved.prompt.split('SUPERSESSION CHECKPOINT').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('the report prompt can recover its generation (#504)', () => {
  it('tells a fresh report agent to read the generation off the trail', () => {
    // A report slot is assigned fresh (generation 0) but reports on the same run id,
    // which may have been fenced earlier in the cycle.
    const prompt = buildReportPrompt(DEFAULT_REPORT_PROMPT_TEMPLATE, 504, 77, 'done');
    expect(prompt).toContain('runstate verify --issue 504 --json');
    expect(prompt).toContain('--gen <n>');
  });
});

/**
 * #524 AC3 — "per-agent stdout/stderr logs are never 0 bytes for a unit that
 * ran". Root cause: `claude -p --output-format json` writes nothing until the
 * process exits, so any dispatch the scheduler killed on external-advance
 * left an empty file that was indistinguishable from a spawn that never
 * happened. The spawn preamble makes a dispatch self-describing from t=0.
 */
describe('createSpawnDeps — dispatch log is never 0 bytes (#524 AC3)', () => {
  it('writes a preamble before the agent produces any output of its own', async () => {
    const { createSpawnDeps } = await import('../index');
    const { SCHED_DISPATCH_EVENT } = await import('@ai-dossier/core');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-preamble-'));
    const logFile = path.join(dir, 'issue-524.log');
    // An agent that runs but never writes anything — exactly the shape that
    // produced the pilot's 0-byte logs.
    const fixture = path.join(dir, 'silent.mjs');
    fs.writeFileSync(fixture, 'setTimeout(() => process.exit(0), 5000);\n');

    const deps = createSpawnDeps();
    const pid = deps.spawn(['node', fixture], 'prompt', logFile);
    try {
      expect(fs.statSync(logFile).size).toBeGreaterThan(0);
      const first = JSON.parse(fs.readFileSync(logFile, 'utf-8').split('\n')[0]);
      expect(first.type).toBe(SCHED_DISPATCH_EVENT);
      expect(first.cmd).toEqual(['node', fixture]);
      expect(typeof first.ts).toBe('string');
    } finally {
      deps.kill(pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('appends a fresh preamble per dispatch, after the prior dispatch’s bytes', async () => {
    const { createSpawnDeps } = await import('../index');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-preamble2-'));
    const logFile = path.join(dir, 'issue-524.log');
    const fixture = path.join(dir, 'silent.mjs');
    fs.writeFileSync(fixture, 'setTimeout(() => process.exit(0), 5000);\n');

    const deps = createSpawnDeps();
    const first = deps.spawn(['node', fixture], 'p', logFile);
    const offsetAtSecondSpawn = fs.statSync(logFile).size;
    const second = deps.spawn(['node', fixture], 'p', logFile);
    try {
      // The redispatch's own slice starts at its own preamble, so
      // `log_offset_at_spawn` never replays the first dispatch's bytes. The
      // slice holds exactly this dispatch's two sched markers (preamble +
      // the pid marker written once the child exists) and nothing earlier.
      const slice = fs.readFileSync(logFile).subarray(offsetAtSecondSpawn).toString('utf-8');
      const lines = slice
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines.map((line) => line.type)).toEqual(['sched-dispatch', 'sched-dispatch']);
      expect(lines[1]).toMatchObject({ event: 'spawned', pid: second });
    } finally {
      deps.kill(first);
      deps.kill(second);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
