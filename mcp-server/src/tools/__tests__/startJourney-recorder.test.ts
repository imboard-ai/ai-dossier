/**
 * Verifies startJourney opens a trace via the configured TraceRecorder.
 * The recorder is mocked at the module boundary so the real
 * createTraceRecorder/fetch path never runs in tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '# Body'),
}));

vi.mock('@ai-dossier/core', () => ({
  parseDossierContent: vi.fn((raw: string) => ({ body: raw })),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCreate = vi.fn().mockResolvedValue(undefined);
const mockRecorder = {
  enabled: true,
  create: mockCreate,
  appendStep: vi.fn().mockResolvedValue(undefined),
  complete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../orchestration/recorder', () => ({
  getRecorder: vi.fn(() => mockRecorder),
}));

import type { ExecutionPlan } from '../../orchestration/types';
import { storeGraph } from '../../utils/graphStore';
import { startJourney } from '../startJourney';

function makePlan(names: string[]): ExecutionPlan {
  return {
    entryDossier: names[0],
    totalDossiers: names.length,
    phases: names.map((name, i) => ({
      phase: i + 1,
      dossiers: [
        {
          name,
          source: 'local' as const,
          path: `/tmp/${name}.ds.md`,
          condition: 'required' as const,
        },
      ],
    })),
    conflicts: [],
    warnings: [],
  };
}

describe('startJourney → TraceRecorder.create', () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls recorder.create with trace_id = session.id and status=running', async () => {
    storeGraph('graph-trace-1', makePlan(['entry-dossier', 'second']));
    const result = (await startJourney({ graph_id: 'graph-trace-1' })) as {
      journey_id: string;
    };

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.trace_id).toBe(result.journey_id);
    expect(arg.status).toBe('running');
    expect(arg.dossier.title).toBe('entry-dossier');
    expect(arg.agent).toEqual({ name: 'mcp-server' });
    expect(typeof arg.started_at).toBe('string');
    expect(new Date(arg.started_at).toString()).not.toBe('Invalid Date');
  });

  it('does not call recorder.create when graph_id is missing', async () => {
    await startJourney({ graph_id: '' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not call recorder.create when graph is not found', async () => {
    await startJourney({ graph_id: 'nonexistent-graph' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not call recorder.create when graph is empty', async () => {
    storeGraph('graph-empty', {
      entryDossier: '',
      totalDossiers: 0,
      phases: [],
      conflicts: [],
      warnings: [],
    });
    await startJourney({ graph_id: 'graph-empty' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
