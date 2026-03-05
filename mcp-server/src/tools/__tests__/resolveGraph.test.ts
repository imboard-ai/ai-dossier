import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionPlan } from '../../orchestration/types';
import { resolveGraph } from '../resolveGraph';

// Mock the resolver
vi.mock('../../orchestration/resolver', () => {
  const DossierResolver = vi.fn();
  DossierResolver.prototype.resolve = vi.fn();
  DossierResolver.prototype.resolveFromPath = vi.fn();
  DossierResolver.prototype.resolveGraph = vi.fn();
  return { DossierResolver, ResolveError: class extends Error {} };
});

// Mock the graph module
vi.mock('../../orchestration/graph', () => ({
  buildGraph: vi.fn(),
  buildExecutionPlan: vi.fn(),
  CycleError: class CycleError extends Error {
    cycle: string[];
    constructor(cycle: string[]) {
      super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
      this.name = 'CycleError';
      this.cycle = cycle;
    }
  },
}));

vi.mock('../../utils/graphStore', () => ({
  generateGraphId: vi.fn(() => 'test-graph-id'),
  storeGraph: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildExecutionPlan, buildGraph, CycleError } from '../../orchestration/graph';
import { DossierResolver } from '../../orchestration/resolver';

const mockResolverInstance = () => {
  const instance = new DossierResolver();
  return instance;
};

describe('resolveGraph tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error when dossier parameter is empty', async () => {
    const result = await resolveGraph({ dossier: '' });

    expect(result).toHaveProperty('error');
    expect((result as any).error.type).toBe('unknown');
    expect((result as any).error.message).toContain('required');
  });

  it('should use resolveFromPath for file paths', async () => {
    const mockEntry = {
      name: 'deploy',
      source: 'local' as const,
      path: '/test/deploy.ds.md',
      metadata: {},
      relationships: {},
    };
    const mockNodes = new Map([['deploy', { name: 'deploy', source: 'local' as const }]]);
    const mockGraph = { nodes: mockNodes, edges: [] };
    const mockPlan: ExecutionPlan = {
      entryDossier: 'deploy',
      totalDossiers: 1,
      phases: [
        {
          phase: 1,
          dossiers: [{ name: 'deploy', source: 'local' as const, condition: 'required' as const }],
        },
      ],
      conflicts: [],
      warnings: [],
    };

    vi.mocked(DossierResolver.prototype.resolveFromPath).mockResolvedValue(mockEntry);
    vi.mocked(DossierResolver.prototype.resolveGraph).mockResolvedValue(mockNodes);
    vi.mocked(buildGraph).mockReturnValue(mockGraph);
    vi.mocked(buildExecutionPlan).mockReturnValue(mockPlan);

    const result = await resolveGraph({ dossier: './deploy.ds.md' });

    expect(DossierResolver.prototype.resolveFromPath).toHaveBeenCalled();
    expect(DossierResolver.prototype.resolve).not.toHaveBeenCalled();
    expect(result).toHaveProperty('plan');
    expect((result as any).plan.totalDossiers).toBe(1);
  });

  it('should use resolve for registry names', async () => {
    const mockEntry = {
      name: 'deploy',
      source: 'registry' as const,
      metadata: {},
      relationships: {},
    };
    const mockNodes = new Map([['deploy', { name: 'deploy', source: 'registry' as const }]]);
    const mockGraph = { nodes: mockNodes, edges: [] };
    const mockPlan: ExecutionPlan = {
      entryDossier: 'deploy',
      totalDossiers: 1,
      phases: [
        {
          phase: 1,
          dossiers: [
            { name: 'deploy', source: 'registry' as const, condition: 'required' as const },
          ],
        },
      ],
      conflicts: [],
      warnings: [],
    };

    vi.mocked(DossierResolver.prototype.resolve).mockResolvedValue(mockEntry);
    vi.mocked(DossierResolver.prototype.resolveGraph).mockResolvedValue(mockNodes);
    vi.mocked(buildGraph).mockReturnValue(mockGraph);
    vi.mocked(buildExecutionPlan).mockReturnValue(mockPlan);

    const result = await resolveGraph({ dossier: 'deploy-to-aws' });

    expect(DossierResolver.prototype.resolve).toHaveBeenCalledWith('deploy-to-aws');
    expect(DossierResolver.prototype.resolveFromPath).not.toHaveBeenCalled();
    expect(result).toHaveProperty('plan');
  });

  it('should treat paths with slashes as file paths', async () => {
    const mockEntry = {
      name: 'deploy',
      source: 'local' as const,
      path: '/test/sub/deploy.ds.md',
      metadata: {},
    };
    const mockNodes = new Map([['deploy', { name: 'deploy', source: 'local' as const }]]);

    vi.mocked(DossierResolver.prototype.resolveFromPath).mockResolvedValue(mockEntry);
    vi.mocked(DossierResolver.prototype.resolveGraph).mockResolvedValue(mockNodes);
    vi.mocked(buildGraph).mockReturnValue({ nodes: mockNodes, edges: [] });
    vi.mocked(buildExecutionPlan).mockReturnValue({
      entryDossier: 'deploy',
      totalDossiers: 1,
      phases: [],
      conflicts: [],
      warnings: [],
    });

    await resolveGraph({ dossier: 'sub/deploy' });

    expect(DossierResolver.prototype.resolveFromPath).toHaveBeenCalled();
  });

  it('should return cycle error with cycle path', async () => {
    const mockEntry = {
      name: 'a',
      source: 'local' as const,
      metadata: {},
    };
    const mockNodes = new Map([
      ['a', { name: 'a', source: 'local' as const }],
      ['b', { name: 'b', source: 'local' as const }],
    ]);

    vi.mocked(DossierResolver.prototype.resolve).mockResolvedValue(mockEntry);
    vi.mocked(DossierResolver.prototype.resolveGraph).mockResolvedValue(mockNodes);
    vi.mocked(buildGraph).mockReturnValue({ nodes: mockNodes, edges: [] });
    vi.mocked(buildExecutionPlan).mockImplementation(() => {
      throw new CycleError(['a', 'b', 'a']);
    });

    const result = await resolveGraph({ dossier: 'a' });

    expect(result).toHaveProperty('error');
    const err = (result as any).error;
    expect(err.type).toBe('cycle');
    expect(err.cycle).toEqual(['a', 'b', 'a']);
    expect(err.message).toContain('cycle');
  });

  it('should return resolve error for other failures', async () => {
    vi.mocked(DossierResolver.prototype.resolve).mockRejectedValue(new Error('Connection timeout'));

    const result = await resolveGraph({ dossier: 'broken-dossier' });

    expect(result).toHaveProperty('error');
    const err = (result as any).error;
    expect(err.type).toBe('resolve');
    expect(err.message).toContain('Connection timeout');
  });
});
