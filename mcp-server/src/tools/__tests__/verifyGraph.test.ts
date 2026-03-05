import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionPlan } from '../../orchestration/types';
import type { VerifyDossierOutput } from '../verifyDossier';
import { type VerifyGraphError, type VerifyGraphOutput, verifyGraph } from '../verifyGraph';

vi.mock('../../utils/cli-wrapper', () => ({
  execCli: vi.fn(),
  CliNotFoundError: class CliNotFoundError extends Error {
    constructor() {
      super('ai-dossier CLI not found');
      this.name = 'CliNotFoundError';
    }
  },
}));

vi.mock('../../utils/graphStore', () => ({
  getGraph: vi.fn(),
  generateGraphId: vi.fn(() => 'test-graph-id'),
  storeGraph: vi.fn(),
}));

vi.mock('../../orchestration/resolver', () => {
  const DossierResolver = vi.fn();
  DossierResolver.prototype.resolve = vi.fn();
  DossierResolver.prototype.resolveFromPath = vi.fn();
  DossierResolver.prototype.resolveGraph = vi.fn();
  return { DossierResolver };
});

vi.mock('../../orchestration/graph', () => ({
  buildGraph: vi.fn(),
  buildExecutionPlan: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildExecutionPlan, buildGraph } from '../../orchestration/graph';
import { DossierResolver } from '../../orchestration/resolver';
import { CliNotFoundError, execCli } from '../../utils/cli-wrapper';
import { getGraph } from '../../utils/graphStore';

function makePlan(
  entries: Array<{ name: string; source: 'local' | 'registry'; path?: string; riskLevel?: string }>
): ExecutionPlan {
  return {
    entryDossier: entries[0]?.name ?? 'unknown',
    totalDossiers: entries.length,
    phases: [
      {
        phase: 1,
        dossiers: entries.map((e) => ({
          name: e.name,
          source: e.source,
          path: e.path,
          condition: 'required' as const,
          riskLevel: e.riskLevel,
        })),
      },
    ],
    conflicts: [],
    warnings: [],
  };
}

function passedResult(): VerifyDossierOutput {
  return {
    passed: true,
    stages: [
      { stage: 1, name: 'Integrity Check', passed: true },
      { stage: 2, name: 'Authenticity Check', passed: true },
    ],
  };
}

function failedIntegrity(): VerifyDossierOutput {
  return {
    passed: false,
    stages: [
      { stage: 1, name: 'Integrity Check', passed: false },
      { stage: 2, name: 'Authenticity Check', skipped: true },
    ],
  };
}

function failedAuthenticity(): VerifyDossierOutput {
  return {
    passed: false,
    stages: [
      { stage: 1, name: 'Integrity Check', passed: true },
      { stage: 2, name: 'Authenticity Check', passed: false },
    ],
  };
}

describe('verifyGraph tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error when neither graph_id nor dossier is provided', async () => {
    const result = await verifyGraph({});
    expect(result).toHaveProperty('error');
    expect((result as VerifyGraphError).error.type).toBe('validation');
  });

  it('should return error when graph_id is not found', async () => {
    vi.mocked(getGraph).mockReturnValue(undefined);

    const result = await verifyGraph({ graph_id: 'nonexistent' });
    expect(result).toHaveProperty('error');
    expect((result as VerifyGraphError).error.type).toBe('not_found');
  });

  it('should verify all dossiers from a stored graph', async () => {
    const plan = makePlan([
      { name: 'setup-infra', source: 'local', path: '/tmp/setup.ds.md', riskLevel: 'low' },
      { name: 'deploy-app', source: 'local', path: '/tmp/deploy.ds.md', riskLevel: 'low' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockResolvedValue(passedResult());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    expect(result.overall_recommendation).toBe('ALLOW');
    expect(result.dossiers).toHaveLength(2);
    expect(result.blockers).toHaveLength(0);
    expect(execCli).toHaveBeenCalledTimes(2);
  });

  it('should run verifications in parallel', async () => {
    const plan = makePlan([
      { name: 'a', source: 'local', path: '/a.ds.md' },
      { name: 'b', source: 'local', path: '/b.ds.md' },
      { name: 'c', source: 'local', path: '/c.ds.md' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);

    const callOrder: string[] = [];
    vi.mocked(execCli).mockImplementation((_cmd, args) => {
      callOrder.push(args[0]);
      return Promise.resolve(passedResult());
    });

    await verifyGraph({ graph_id: 'test-id' });

    // All three were called (Promise.all means parallel)
    expect(callOrder).toHaveLength(3);
    expect(callOrder).toContain('/a.ds.md');
    expect(callOrder).toContain('/b.ds.md');
    expect(callOrder).toContain('/c.ds.md');
  });

  it('should BLOCK when any dossier fails integrity', async () => {
    const plan = makePlan([
      { name: 'good', source: 'local', path: '/good.ds.md', riskLevel: 'low' },
      { name: 'bad', source: 'local', path: '/bad.ds.md', riskLevel: 'low' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli)
      .mockResolvedValueOnce(passedResult())
      .mockResolvedValueOnce(failedIntegrity());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    expect(result.overall_recommendation).toBe('BLOCK');
    expect(result.blockers).toContain('bad');
    expect(result.dossiers[1].recommendation).toBe('BLOCK');
  });

  it('should WARN when authenticity fails but integrity passes', async () => {
    const plan = makePlan([
      { name: 'unsigned', source: 'local', path: '/unsigned.ds.md', riskLevel: 'low' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockResolvedValue(failedAuthenticity());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    expect(result.overall_recommendation).toBe('WARN');
    expect(result.blockers).toHaveLength(0);
    expect(result.dossiers[0].recommendation).toBe('WARN');
  });

  it('should WARN for high-risk dossiers even when verification passes', async () => {
    const plan = makePlan([
      { name: 'risky', source: 'local', path: '/risky.ds.md', riskLevel: 'high' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockResolvedValue(passedResult());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    expect(result.overall_recommendation).toBe('WARN');
    expect(result.dossiers[0].recommendation).toBe('WARN');
    expect(result.dossiers[0].passed).toBe(true);
  });

  it('should aggregate worst-case recommendation', async () => {
    const plan = makePlan([
      { name: 'allow', source: 'local', path: '/allow.ds.md', riskLevel: 'low' },
      { name: 'warn', source: 'local', path: '/warn.ds.md', riskLevel: 'high' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockResolvedValue(passedResult());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    // One ALLOW + one WARN = overall WARN
    expect(result.overall_recommendation).toBe('WARN');
  });

  it('should resolve and verify when dossier parameter is used', async () => {
    const mockEntry = {
      name: 'deploy',
      source: 'local' as const,
      path: '/test/deploy.ds.md',
      metadata: {},
      relationships: {},
    };
    const mockNodes = new Map([
      ['deploy', { name: 'deploy', source: 'local' as const, path: '/test/deploy.ds.md' }],
    ]);
    const mockGraph = { nodes: mockNodes, edges: [] };
    const mockPlan = makePlan([
      { name: 'deploy', source: 'local', path: '/test/deploy.ds.md', riskLevel: 'low' },
    ]);

    vi.mocked(DossierResolver.prototype.resolveFromPath).mockResolvedValue(mockEntry);
    vi.mocked(DossierResolver.prototype.resolveGraph).mockResolvedValue(mockNodes);
    vi.mocked(buildGraph).mockReturnValue(mockGraph);
    vi.mocked(buildExecutionPlan).mockReturnValue(mockPlan);
    vi.mocked(execCli).mockResolvedValue(passedResult());

    const result = (await verifyGraph({ dossier: './deploy.ds.md' })) as VerifyGraphOutput;

    expect(result.overall_recommendation).toBe('ALLOW');
    expect(result.dossiers).toHaveLength(1);
    expect(DossierResolver.prototype.resolveFromPath).toHaveBeenCalled();
  });

  it('should return resolve error when inline resolution fails', async () => {
    vi.mocked(DossierResolver.prototype.resolve).mockRejectedValue(
      new Error('Registry unavailable')
    );

    const result = await verifyGraph({ dossier: 'nonexistent-dossier' });

    expect(result).toHaveProperty('error');
    expect((result as VerifyGraphError).error.type).toBe('resolve');
    expect((result as VerifyGraphError).error.message).toContain('Registry unavailable');
  });

  it('should BLOCK when CLI is not found', async () => {
    const plan = makePlan([{ name: 'test', source: 'local', path: '/test.ds.md' }]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockRejectedValue(new CliNotFoundError());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    expect(result.overall_recommendation).toBe('BLOCK');
    expect(result.dossiers[0].recommendation).toBe('BLOCK');
    expect(result.dossiers[0].error).toBeDefined();
  });

  it('should use name when path is not available', async () => {
    const plan = makePlan([{ name: 'org/deploy-app', source: 'registry' }]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockResolvedValue(passedResult());

    await verifyGraph({ graph_id: 'test-id' });

    expect(execCli).toHaveBeenCalledWith('verify', ['org/deploy-app', '--json']);
  });

  it('should deduplicate dossiers across phases', async () => {
    const plan: ExecutionPlan = {
      entryDossier: 'a',
      totalDossiers: 2,
      phases: [
        { phase: 1, dossiers: [{ name: 'a', source: 'local', condition: 'required' }] },
        { phase: 2, dossiers: [{ name: 'a', source: 'local', condition: 'required' }] },
      ],
      conflicts: [],
      warnings: [],
    };

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockResolvedValue(passedResult());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    // Should verify 'a' only once
    expect(execCli).toHaveBeenCalledTimes(1);
    expect(result.dossiers).toHaveLength(1);
  });

  it('should produce a readable summary', async () => {
    const plan = makePlan([
      { name: 'a', source: 'local', path: '/a.ds.md', riskLevel: 'low' },
      { name: 'b', source: 'local', path: '/b.ds.md', riskLevel: 'low' },
      { name: 'c', source: 'local', path: '/c.ds.md', riskLevel: 'low' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli)
      .mockResolvedValueOnce(passedResult())
      .mockResolvedValueOnce(passedResult())
      .mockResolvedValueOnce(failedIntegrity());

    const result = (await verifyGraph({ graph_id: 'test-id' })) as VerifyGraphOutput;

    expect(result.summary).toContain('3 dossiers verified');
    expect(result.summary).toContain('2 passed');
    expect(result.summary).toContain('1 blocked');
  });

  it('should prefer graph_id over dossier when both are provided', async () => {
    const plan = makePlan([
      { name: 'from-store', source: 'local', path: '/store.ds.md', riskLevel: 'low' },
    ]);

    vi.mocked(getGraph).mockReturnValue(plan);
    vi.mocked(execCli).mockResolvedValue(passedResult());

    const result = (await verifyGraph({
      graph_id: 'test-id',
      dossier: './other.ds.md',
    })) as VerifyGraphOutput;

    expect(result.dossiers[0].name).toBe('from-store');
    expect(DossierResolver.prototype.resolve).not.toHaveBeenCalled();
    expect(DossierResolver.prototype.resolveFromPath).not.toHaveBeenCalled();
  });
});
