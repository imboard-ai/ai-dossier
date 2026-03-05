import { describe, expect, it } from 'vitest';
import {
  buildExecutionPlan,
  buildGraph,
  CycleError,
  detectConflicts,
  detectCycle,
  topologicalSort,
} from '../graph';
import type { DossierNode } from '../types';

function makeNode(name: string, overrides: Partial<DossierNode> = {}): [string, DossierNode] {
  return [
    name,
    {
      name,
      source: 'local',
      ...overrides,
    },
  ];
}

describe('buildGraph', () => {
  it('should create edges from preceded_by relationships', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('setup-infra', {}),
      makeNode('deploy-app', {
        relationships: {
          preceded_by: [
            { dossier: 'setup-infra', condition: 'required', reason: 'Needs infra first' },
          ],
        },
      }),
    ]);

    const graph = buildGraph(nodes);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      from: 'setup-infra',
      to: 'deploy-app',
      condition: 'required',
      reason: 'Needs infra first',
    });
  });

  it('should create edges from followed_by relationships', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('deploy-app', {
        relationships: {
          followed_by: [
            { dossier: 'configure-monitoring', condition: 'suggested', purpose: 'Setup alerts' },
          ],
        },
      }),
      makeNode('configure-monitoring', {}),
    ]);

    const graph = buildGraph(nodes);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toEqual({
      from: 'deploy-app',
      to: 'configure-monitoring',
      condition: 'suggested',
      reason: 'Setup alerts',
    });
  });

  it('should skip edges to nodes not in the graph', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('deploy-app', {
        relationships: {
          preceded_by: [{ dossier: 'nonexistent', condition: 'optional' }],
        },
      }),
    ]);

    const graph = buildGraph(nodes);

    expect(graph.edges).toHaveLength(0);
  });

  it('should default condition to required when not specified', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('a'),
      makeNode('b', {
        relationships: {
          preceded_by: [{ dossier: 'a' }],
        },
      }),
    ]);

    const graph = buildGraph(nodes);

    expect(graph.edges[0].condition).toBe('required');
  });
});

describe('detectCycle', () => {
  it('should return null for acyclic graph', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('a'),
      makeNode('b', {
        relationships: { preceded_by: [{ dossier: 'a' }] },
      }),
      makeNode('c', {
        relationships: { preceded_by: [{ dossier: 'b' }] },
      }),
    ]);

    const graph = buildGraph(nodes);
    expect(detectCycle(graph)).toBeNull();
  });

  it('should detect a simple 2-node cycle', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('a', {
        relationships: { preceded_by: [{ dossier: 'b' }] },
      }),
      makeNode('b', {
        relationships: { preceded_by: [{ dossier: 'a' }] },
      }),
    ]);

    const graph = buildGraph(nodes);
    const cycle = detectCycle(graph);

    expect(cycle).not.toBeNull();
    expect(cycle?.length).toBeGreaterThanOrEqual(3); // at least [a, b, a]
    // Cycle should contain both nodes
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });

  it('should detect a 3-node cycle', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('a', {
        relationships: { preceded_by: [{ dossier: 'c' }] },
      }),
      makeNode('b', {
        relationships: { preceded_by: [{ dossier: 'a' }] },
      }),
      makeNode('c', {
        relationships: { preceded_by: [{ dossier: 'b' }] },
      }),
    ]);

    const graph = buildGraph(nodes);
    const cycle = detectCycle(graph);

    expect(cycle).not.toBeNull();
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
    expect(cycle).toContain('c');
  });

  it('should return null for single node with no edges', () => {
    const nodes = new Map<string, DossierNode>([makeNode('solo')]);

    const graph = buildGraph(nodes);
    expect(detectCycle(graph)).toBeNull();
  });
});

describe('topologicalSort', () => {
  it('should sort a linear chain A -> B -> C', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('a'),
      makeNode('b', {
        relationships: { preceded_by: [{ dossier: 'a' }] },
      }),
      makeNode('c', {
        relationships: { preceded_by: [{ dossier: 'b' }] },
      }),
    ]);

    const graph = buildGraph(nodes);
    const phases = topologicalSort(graph);

    expect(phases).toHaveLength(3);
    expect(phases[0]).toEqual(['a']);
    expect(phases[1]).toEqual(['b']);
    expect(phases[2]).toEqual(['c']);
  });

  it('should group independent nodes in the same phase', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('root'),
      makeNode('child-1', {
        relationships: { preceded_by: [{ dossier: 'root' }] },
      }),
      makeNode('child-2', {
        relationships: { preceded_by: [{ dossier: 'root' }] },
      }),
    ]);

    const graph = buildGraph(nodes);
    const phases = topologicalSort(graph);

    expect(phases).toHaveLength(2);
    expect(phases[0]).toEqual(['root']);
    expect(phases[1]).toHaveLength(2);
    expect(phases[1]).toContain('child-1');
    expect(phases[1]).toContain('child-2');
  });

  it('should handle a diamond dependency pattern', () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    const nodes = new Map<string, DossierNode>([
      makeNode('a'),
      makeNode('b', {
        relationships: { preceded_by: [{ dossier: 'a' }] },
      }),
      makeNode('c', {
        relationships: { preceded_by: [{ dossier: 'a' }] },
      }),
      makeNode('d', {
        relationships: { preceded_by: [{ dossier: 'b' }, { dossier: 'c' }] },
      }),
    ]);

    const graph = buildGraph(nodes);
    const phases = topologicalSort(graph);

    expect(phases).toHaveLength(3);
    expect(phases[0]).toEqual(['a']);
    expect(phases[1]).toHaveLength(2);
    expect(phases[1]).toContain('b');
    expect(phases[1]).toContain('c');
    expect(phases[2]).toEqual(['d']);
  });

  it('should handle single node graph', () => {
    const nodes = new Map<string, DossierNode>([makeNode('solo')]);

    const graph = buildGraph(nodes);
    const phases = topologicalSort(graph);

    expect(phases).toHaveLength(1);
    expect(phases[0]).toEqual(['solo']);
  });

  it('should handle multiple disconnected components', () => {
    const nodes = new Map<string, DossierNode>([makeNode('a'), makeNode('b')]);

    const graph = buildGraph(nodes);
    const phases = topologicalSort(graph);

    expect(phases).toHaveLength(1);
    expect(phases[0]).toHaveLength(2);
    expect(phases[0]).toContain('a');
    expect(phases[0]).toContain('b');
  });
});

describe('detectConflicts', () => {
  it('should detect conflicts between two dossiers in the graph', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('mysql-setup', {
        relationships: {
          conflicts_with: [{ dossier: 'postgres-setup', reason: 'Both set up primary DB' }],
        },
      }),
      makeNode('postgres-setup'),
    ]);

    const graph = buildGraph(nodes);
    const conflicts = detectConflicts(graph);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      dossierA: 'mysql-setup',
      dossierB: 'postgres-setup',
      reason: 'Both set up primary DB',
    });
  });

  it('should not report conflicts with dossiers not in the graph', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('mysql-setup', {
        relationships: {
          conflicts_with: [{ dossier: 'not-in-graph', reason: 'some reason' }],
        },
      }),
    ]);

    const graph = buildGraph(nodes);
    const conflicts = detectConflicts(graph);

    expect(conflicts).toHaveLength(0);
  });

  it('should deduplicate bidirectional conflicts', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('a', {
        relationships: {
          conflicts_with: [{ dossier: 'b', reason: 'conflict' }],
        },
      }),
      makeNode('b', {
        relationships: {
          conflicts_with: [{ dossier: 'a', reason: 'conflict reverse' }],
        },
      }),
    ]);

    const graph = buildGraph(nodes);
    const conflicts = detectConflicts(graph);

    expect(conflicts).toHaveLength(1);
  });

  it('should return empty array when no conflicts exist', () => {
    const nodes = new Map<string, DossierNode>([makeNode('a'), makeNode('b')]);

    const graph = buildGraph(nodes);
    const conflicts = detectConflicts(graph);

    expect(conflicts).toHaveLength(0);
  });
});

describe('buildExecutionPlan', () => {
  it('should build a plan for a simple dependency chain', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('setup', { riskLevel: 'low' }),
      makeNode('deploy', {
        riskLevel: 'high',
        relationships: {
          preceded_by: [{ dossier: 'setup', condition: 'required' }],
        },
      }),
      makeNode('monitor', {
        riskLevel: 'low',
        relationships: {
          preceded_by: [{ dossier: 'deploy', condition: 'suggested' }],
        },
      }),
    ]);

    const graph = buildGraph(nodes);
    const plan = buildExecutionPlan(graph, 'deploy');

    expect(plan.entryDossier).toBe('deploy');
    expect(plan.totalDossiers).toBe(3);
    expect(plan.phases).toHaveLength(3);
    expect(plan.phases[0].dossiers[0].name).toBe('setup');
    expect(plan.phases[1].dossiers[0].name).toBe('deploy');
    expect(plan.phases[2].dossiers[0].name).toBe('monitor');
    expect(plan.conflicts).toHaveLength(0);
  });

  it('should throw CycleError for cyclic graphs', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('a', {
        relationships: { preceded_by: [{ dossier: 'b' }] },
      }),
      makeNode('b', {
        relationships: { preceded_by: [{ dossier: 'a' }] },
      }),
    ]);

    const graph = buildGraph(nodes);

    expect(() => buildExecutionPlan(graph, 'a')).toThrow(CycleError);
  });

  it('should include conflicts in the plan', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('mysql', {
        relationships: {
          conflicts_with: [{ dossier: 'postgres', reason: 'Both set up primary DB' }],
        },
      }),
      makeNode('postgres'),
    ]);

    const graph = buildGraph(nodes);
    const plan = buildExecutionPlan(graph, 'mysql');

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it('should handle single dossier with no dependencies', () => {
    const nodes = new Map<string, DossierNode>([makeNode('standalone', { riskLevel: 'low' })]);

    const graph = buildGraph(nodes);
    const plan = buildExecutionPlan(graph, 'standalone');

    expect(plan.totalDossiers).toBe(1);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].dossiers[0].name).toBe('standalone');
    expect(plan.phases[0].dossiers[0].condition).toBe('required');
  });

  it('should mark entry dossier as required regardless of edge conditions', () => {
    const nodes = new Map<string, DossierNode>([
      makeNode('dep', {
        relationships: {
          followed_by: [{ dossier: 'entry', condition: 'suggested' }],
        },
      }),
      makeNode('entry'),
    ]);

    const graph = buildGraph(nodes);
    const plan = buildExecutionPlan(graph, 'entry');

    const entryPhase = plan.phases.find((p) => p.dossiers.some((d) => d.name === 'entry'));
    expect(entryPhase?.dossiers.find((d) => d.name === 'entry')?.condition).toBe('required');
  });
});
