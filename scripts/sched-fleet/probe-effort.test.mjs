import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  measuredTokens,
  prepareProfile,
  schedulerConfigPath,
  selectEffortPair,
} from './probe-effort.mjs';

describe('selectEffortPair', () => {
  it('chooses the widest same-model effort range', () => {
    expect(
      selectEffortPair({
        mechanical: { model: 'haiku', effort: 'medium' },
        mid: { model: 'opus', effort: 'low' },
        strong: { model: 'opus', effort: 'max' },
      })
    ).toEqual({
      lowTier: 'mid',
      highTier: 'strong',
      setting: 'effort',
      lowValue: 'low',
      highValue: 'max',
      distance: 3,
    });
  });

  it('supports variant values used by non-Claude profiles', () => {
    expect(
      selectEffortPair({
        mechanical: { model: 'glm', variant: 'low' },
        mid: { model: 'glm', variant: 'high' },
        strong: { model: 'glm', variant: 'max' },
      })
    ).toMatchObject({
      lowTier: 'mechanical',
      highTier: 'strong',
      setting: 'variant',
      lowValue: 'low',
      highValue: 'max',
      distance: 3,
    });
  });

  it('does not compare different models or equal settings', () => {
    expect(
      selectEffortPair({
        mechanical: { model: 'one', effort: 'low' },
        mid: { model: 'two', effort: 'max' },
        strong: { model: 'three', effort: 'max' },
      })
    ).toBeNull();
  });
});

describe('prepareProfile', () => {
  it('resolves the same commands the scheduler would spawn', () => {
    const prepared = prepareProfile(
      {
        max_slots: 1,
        dispatch: {
          dispatch_profiles: {
            glm: {
              tiers: {
                mechanical: {
                  command: ['opencode', 'run', '--model', '{model}', '--variant', 'low'],
                  model: 'glm',
                },
                mid: {
                  command: ['opencode', 'run', '--model', '{model}', '--variant', 'high'],
                  model: 'glm',
                },
                strong: {
                  command: ['opencode', 'run', '--model', '{model}', '--variant', 'max'],
                  model: 'glm',
                },
              },
            },
          },
        },
      },
      'glm',
      42
    );

    expect(prepared).toMatchObject({
      profile: 'glm',
      setting: 'variant',
      low: {
        tier: 'mechanical',
        value: 'low',
        model: 'glm',
        command: ['opencode', 'run', '--model', 'glm', '--variant', 'low'],
      },
      max: {
        tier: 'strong',
        value: 'max',
        model: 'glm',
        command: ['opencode', 'run', '--model', 'glm', '--variant', 'max'],
      },
    });
  });
});

describe('schedulerConfigPath', () => {
  it('keeps traversal-shaped project names inside the scheduler state root', () => {
    expect(schedulerConfigPath('../outside', '/tmp/probe-home')).toBe(
      '/tmp/probe-home/.dossier/sched/..-outside/config.json'
    );
  });
});

describe('measuredTokens', () => {
  it('includes OpenCode reasoning in the provider-reported total', () => {
    const stdout = JSON.stringify({
      type: 'step_finish',
      part: { tokens: { total: 42, input: 20, output: 2, reasoning: 20 } },
    });
    expect(measuredTokens('opencode', stdout, { input_tokens: 20, output_tokens: 2 })).toBe(42);
  });

  it('uses the parsed input/output total for Claude-shaped output', () => {
    expect(measuredTokens('claude', '', { input_tokens: 20, output_tokens: 2 })).toBe(22);
  });
});

describe('dispatch-profiles.json', () => {
  it('provides a lower/max same-model comparison for every configured family', () => {
    const profiles = JSON.parse(
      readFileSync(resolve(import.meta.dirname, 'dispatch-profiles.json'), 'utf8')
    );
    const config = { dispatch: { dispatch_profiles: profiles } };
    expect(Object.keys(profiles).sort()).toEqual(['alibaba', 'anthropic', 'openai', 'zai']);
    for (const name of Object.keys(profiles)) {
      const prepared = prepareProfile(config, name);
      expect(prepared.max.value).toBe('max');
      expect(prepared.low.model).toBe(prepared.max.model);
      expect(prepared.low.value).not.toBe(prepared.max.value);
      expect(prepared.low.command).toContain(prepared.low.model);
      expect(prepared.max.command).toContain(prepared.max.model);
    }
  });
});
