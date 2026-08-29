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
    const argv = buildAgentCommand(
      DEFAULT_DISPATCH_COMMAND,
      'mid',
      464,
      DEFAULT_TIER_MODELS as Record<string, string | null>
    );
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
