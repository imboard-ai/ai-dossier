import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearJourneyOutputs,
  collectOutputs,
  generateInjectedContext,
  getJourneyOutputs,
  initJourneyOutputs,
  resolveStepInputs,
  validateGraphMappings,
} from '../outputMapper';
import type { DossierNode, ExecutionPlan, FromDossierDeclaration } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(name: string, overrides: Partial<DossierNode> = {}): DossierNode {
  return { name, source: 'local', ...overrides };
}

function makePlan(phases: Array<{ phase: number; names: string[] }>): ExecutionPlan {
  return {
    entryDossier: phases[0]?.names[0] ?? '',
    totalDossiers: phases.reduce((n, p) => n + p.names.length, 0),
    phases: phases.map(({ phase, names }) => ({
      phase,
      dossiers: names.map((name) => ({ name, source: 'local', condition: 'required' })),
    })),
    conflicts: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// collectOutputs / getJourneyOutputs / clearJourneyOutputs
// ---------------------------------------------------------------------------

describe('journey output store', () => {
  const jid = 'test-journey-1';

  afterEach(() => {
    clearJourneyOutputs(jid);
  });

  it('should initialise an empty store for a journey', () => {
    initJourneyOutputs(jid);
    expect(getJourneyOutputs(jid).size).toBe(0);
  });

  it('should collect outputs for a dossier', () => {
    collectOutputs(jid, 'setup-infra', {
      cluster_arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster',
    });
    const outputs = getJourneyOutputs(jid);
    expect(outputs.get('setup-infra')?.get('cluster_arn')).toBe(
      'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster'
    );
  });

  it('should merge additional outputs for the same dossier', () => {
    collectOutputs(jid, 'setup-infra', { cluster_arn: 'arn:1' });
    collectOutputs(jid, 'setup-infra', { vpc_id: 'vpc-123' });
    const dossierOutputs = getJourneyOutputs(jid).get('setup-infra')!;
    expect(dossierOutputs.get('cluster_arn')).toBe('arn:1');
    expect(dossierOutputs.get('vpc_id')).toBe('vpc-123');
  });

  it('should collect outputs for multiple dossiers independently', () => {
    collectOutputs(jid, 'step-a', { key_a: 'value_a' });
    collectOutputs(jid, 'step-b', { key_b: 'value_b' });
    const outputs = getJourneyOutputs(jid);
    expect(outputs.get('step-a')?.get('key_a')).toBe('value_a');
    expect(outputs.get('step-b')?.get('key_b')).toBe('value_b');
  });

  it('should return an empty map for unknown journey ids', () => {
    expect(getJourneyOutputs('nonexistent-journey').size).toBe(0);
  });

  it('should clear journey outputs', () => {
    collectOutputs(jid, 'step-a', { x: 1 });
    clearJourneyOutputs(jid);
    expect(getJourneyOutputs(jid).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateGraphMappings
// ---------------------------------------------------------------------------

describe('validateGraphMappings', () => {
  it('should return no warnings when all mappings are valid', () => {
    const nodes = new Map<string, DossierNode>([
      [
        'setup-infra',
        makeNode('setup-infra', {
          outputConfig: [{ key: 'cluster_arn', description: 'ECS cluster ARN' }],
        }),
      ],
      [
        'deploy',
        makeNode('deploy', {
          fromDossiers: [{ source_dossier: 'setup-infra', output_name: 'cluster_arn' }],
        }),
      ],
    ]);
    const plan = makePlan([
      { phase: 1, names: ['setup-infra'] },
      { phase: 2, names: ['deploy'] },
    ]);

    expect(validateGraphMappings(plan, nodes)).toHaveLength(0);
  });

  it('should warn when source_dossier is not in the graph', () => {
    const nodes = new Map<string, DossierNode>([
      [
        'deploy',
        makeNode('deploy', {
          fromDossiers: [{ source_dossier: 'missing-dossier', output_name: 'cluster_arn' }],
        }),
      ],
    ]);
    const plan = makePlan([{ phase: 1, names: ['deploy'] }]);

    const warnings = validateGraphMappings(plan, nodes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"missing-dossier" is not in the execution graph');
  });

  it('should warn when source_dossier is in the same phase as the consumer', () => {
    const nodes = new Map<string, DossierNode>([
      ['a', makeNode('a')],
      [
        'b',
        makeNode('b', {
          fromDossiers: [{ source_dossier: 'a', output_name: 'some_key' }],
        }),
      ],
    ]);
    // Both in phase 1 — ordering is wrong
    const plan = makePlan([{ phase: 1, names: ['a', 'b'] }]);

    const warnings = validateGraphMappings(plan, nodes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('does not precede the consumer');
  });

  it('should warn when source_dossier is in a later phase than the consumer', () => {
    const nodes = new Map<string, DossierNode>([
      ['late-step', makeNode('late-step')],
      [
        'early-consumer',
        makeNode('early-consumer', {
          fromDossiers: [{ source_dossier: 'late-step', output_name: 'some_key' }],
        }),
      ],
    ]);
    const plan = makePlan([
      { phase: 1, names: ['early-consumer'] },
      { phase: 2, names: ['late-step'] },
    ]);

    const warnings = validateGraphMappings(plan, nodes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('does not precede the consumer');
  });

  it('should return no warnings for nodes with no fromDossiers', () => {
    const nodes = new Map<string, DossierNode>([
      ['step-a', makeNode('step-a')],
      ['step-b', makeNode('step-b')],
    ]);
    const plan = makePlan([
      { phase: 1, names: ['step-a'] },
      { phase: 2, names: ['step-b'] },
    ]);

    expect(validateGraphMappings(plan, nodes)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveStepInputs
// ---------------------------------------------------------------------------

describe('resolveStepInputs', () => {
  it('should resolve available inputs', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'setup-infra', output_name: 'cluster_arn' },
    ];
    const available = new Map([
      ['setup-infra', new Map<string, unknown>([['cluster_arn', 'arn:123']])],
    ]);

    expect(resolveStepInputs(fromDossiers, available)).toEqual({ cluster_arn: 'arn:123' });
  });

  it('should skip inputs that are not yet available', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'step-a', output_name: 'key_a' },
      { source_dossier: 'step-b', output_name: 'key_b' },
    ];
    const available = new Map([['step-a', new Map<string, unknown>([['key_a', 'val_a']])]]);

    expect(resolveStepInputs(fromDossiers, available)).toEqual({ key_a: 'val_a' });
  });

  it('should return empty object when nothing is available', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'setup-infra', output_name: 'cluster_arn' },
    ];
    expect(resolveStepInputs(fromDossiers, new Map())).toEqual({});
  });

  it('should namespace keys when two sources provide the same output_name', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'step-a', output_name: 'region' },
      { source_dossier: 'step-b', output_name: 'region' },
    ];
    const available = new Map([
      ['step-a', new Map<string, unknown>([['region', 'us-east-1']])],
      ['step-b', new Map<string, unknown>([['region', 'eu-west-1']])],
    ]);

    const result = resolveStepInputs(fromDossiers, available);
    expect(result).toEqual({
      'step-a.region': 'us-east-1',
      'step-b.region': 'eu-west-1',
    });
    expect(result['region']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateInjectedContext
// ---------------------------------------------------------------------------

describe('generateInjectedContext', () => {
  it('should return empty string when fromDossiers is empty', () => {
    expect(generateInjectedContext([], new Map())).toBe('');
  });

  it('should list resolved values', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'setup-infra', output_name: 'cluster_arn', usage: 'Target ECS cluster' },
    ];
    const available = new Map([
      ['setup-infra', new Map<string, unknown>([['cluster_arn', 'arn:aws:ecs:123']])],
    ]);

    const ctx = generateInjectedContext(fromDossiers, available);
    expect(ctx).toContain('cluster_arn');
    expect(ctx).toContain('arn:aws:ecs:123');
    expect(ctx).toContain('Target ECS cluster');
    expect(ctx).toContain('setup-infra');
  });

  it('should list missing inputs separately', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'step-a', output_name: 'key_a' },
      { source_dossier: 'step-b', output_name: 'key_b' },
    ];
    const available = new Map([['step-a', new Map<string, unknown>([['key_a', 'val_a']])]]);

    const ctx = generateInjectedContext(fromDossiers, available);
    expect(ctx).toContain('key_a');
    expect(ctx).toContain('val_a');
    expect(ctx).toContain('key_b');
    expect(ctx).toContain('not yet available');
  });

  it('should handle all inputs missing', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'step-a', output_name: 'key_a' },
    ];
    const ctx = generateInjectedContext(fromDossiers, new Map());
    expect(ctx).toContain('key_a');
    expect(ctx).toContain('not yet available');
    expect(ctx).not.toContain('available from previous steps');
  });

  it('should include usage description when present', () => {
    const fromDossiers: FromDossierDeclaration[] = [
      { source_dossier: 'step-a', output_name: 'my_key', usage: 'Used for auth' },
    ];
    const available = new Map([['step-a', new Map<string, unknown>([['my_key', 'secret']])]]);

    const ctx = generateInjectedContext(fromDossiers, available);
    expect(ctx).toContain('Used for auth');
  });
});
