/**
 * End-to-end integration tests for the MCP journey session tools.
 * Tests the full orchestration flow: start → step → complete/cancel/fail.
 *
 * These tests exercise the session management layer directly, using
 * mocked file I/O and graph store to keep tests fast and hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock file system reads so tests don't depend on real dossier files
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '# Step Body\n\nStep instructions go here.'),
}));

// Mock core parser
vi.mock('@ai-dossier/core', () => ({
  parseDossierContent: vi.fn((raw: string) => ({ body: raw })),
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ExecutionPlan } from '../../orchestration/types';
import { storeGraph } from '../../utils/graphStore';
import { cancelJourney } from '../cancelJourney';
import { getJourneyStatus } from '../getJourneyStatus';
import { startJourney } from '../startJourney';
import { stepComplete } from '../stepComplete';

/** Build a minimal execution plan for N sequential steps */
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

/** Store a plan and return its graph_id */
function storePlan(graphId: string, plan: ExecutionPlan): string {
  storeGraph(graphId, plan);
  return graphId;
}

describe('Journey session — happy path (3 steps)', () => {
  const graphId = 'test-graph-happy';

  beforeEach(() => {
    storePlan(graphId, makePlan(['setup-project', 'install-deps', 'run-tests']));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('start_journey returns first step and journey_id', async () => {
    const result = await startJourney({ graph_id: graphId });

    expect(result).not.toHaveProperty('error');
    const out = result as Awaited<ReturnType<typeof startJourney>> & {
      journey_id: string;
      total_steps: number;
      step: { index: number; dossier: string };
    };
    expect(out.journey_id).toBeTruthy();
    expect(out.total_steps).toBe(3);
    expect(out.step.index).toBe(0);
    expect(out.step.dossier).toBe('setup-project');
  });

  it('step_complete advances to step 2 and injects outputs as context', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    const result = (await stepComplete({
      journey_id: journeyId,
      status: 'completed',
      outputs: { project_path: '/tmp/myapp' },
    })) as any;

    expect(result.status).toBe('running');
    expect(result.step.index).toBe(1);
    expect(result.step.dossier).toBe('install-deps');
    expect(result.step.context).toContain('project_path=/tmp/myapp');
    expect(result.step.context).toContain('setup-project');
  });

  it('step_complete advances through all steps and returns completed summary', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    await stepComplete({
      journey_id: journeyId,
      status: 'completed',
      outputs: { project_path: '/tmp/myapp' },
    });

    await stepComplete({
      journey_id: journeyId,
      status: 'completed',
      outputs: { deps_installed: true },
    });

    const result = (await stepComplete({
      journey_id: journeyId,
      status: 'completed',
    })) as any;

    expect(result.status).toBe('completed');
    expect(result.summary.total_steps).toBe(3);
    expect(result.summary.completed_steps).toBe(3);
    expect(result.summary.failed_steps).toBe(0);
    expect(result.summary.outputs['setup-project'].project_path).toBe('/tmp/myapp');
  });

  it('get_journey_status reflects progress after each step', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    await stepComplete({ journey_id: journeyId, status: 'completed' });

    const status = getJourneyStatus({ journey_id: journeyId }) as any;

    expect(status.summary.status).toBe('running');
    expect(status.summary.completed_steps).toBe(1);
    expect(status.current_step?.index).toBe(1);
    expect(status.steps).toHaveLength(3);
    expect(status.steps[0].status).toBe('completed');
    expect(status.steps[1].status).toBe('running');
    expect(status.steps[2].status).toBe('pending');
  });

  it('get_journey_status shows completed after full journey', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    await stepComplete({ journey_id: journeyId, status: 'completed' });
    await stepComplete({ journey_id: journeyId, status: 'completed' });
    await stepComplete({ journey_id: journeyId, status: 'completed' });

    const status = getJourneyStatus({ journey_id: journeyId }) as any;
    expect(status.summary.status).toBe('completed');
    expect(status.current_step).toBeUndefined();
  });
});

describe('Journey session — cancel mid-journey', () => {
  const graphId = 'test-graph-cancel';

  beforeEach(() => {
    storePlan(graphId, makePlan(['setup-project', 'install-deps', 'run-tests']));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('cancel_journey stops the journey and skips remaining steps', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    await stepComplete({ journey_id: journeyId, status: 'completed' });

    const result = cancelJourney({ journey_id: journeyId, reason: 'User cancelled' }) as any;

    expect(result.summary.status).toBe('cancelled');
    expect(result.summary.cancel_reason).toBe('User cancelled');
    expect(result.summary.completed_steps).toBe(1);
  });

  it('cannot step_complete after cancel', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    cancelJourney({ journey_id: journeyId });

    const result = (await stepComplete({ journey_id: journeyId, status: 'completed' })) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('invalid_state');
  });

  it('cannot cancel an already-cancelled journey', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    cancelJourney({ journey_id: journeyId });
    const result = cancelJourney({ journey_id: journeyId }) as any;

    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('invalid_state');
  });
});

describe('Journey session — failed step', () => {
  const graphId = 'test-graph-fail';

  beforeEach(() => {
    storePlan(graphId, makePlan(['setup-project', 'install-deps', 'run-tests']));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('step_complete with failed status returns failed summary', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    const result = (await stepComplete({
      journey_id: journeyId,
      status: 'failed',
    })) as any;

    expect(result.status).toBe('failed');
    expect(result.summary.status).toBe('failed');
    expect(result.summary.failed_steps).toBe(1);
  });

  it('cannot advance after a failed step', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    await stepComplete({ journey_id: journeyId, status: 'failed' });

    const result = (await stepComplete({ journey_id: journeyId, status: 'completed' })) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('invalid_state');
  });
});

describe('Journey session — error handling', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('start_journey returns not_found for unknown graph_id', async () => {
    const result = (await startJourney({ graph_id: 'nonexistent-graph' })) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('not_found');
  });

  it('step_complete returns not_found for unknown journey_id', async () => {
    const result = (await stepComplete({
      journey_id: 'nonexistent-journey',
      status: 'completed',
    })) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('not_found');
  });

  it('get_journey_status returns not_found for unknown journey_id', () => {
    const result = getJourneyStatus({ journey_id: 'nonexistent-journey' }) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('not_found');
  });

  it('cancel_journey returns not_found for unknown journey_id', () => {
    const result = cancelJourney({ journey_id: 'nonexistent-journey' }) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('not_found');
  });

  it('start_journey returns error for missing graph_id', async () => {
    const result = (await startJourney({ graph_id: '' })) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('unknown');
  });

  it('step_complete returns error for missing journey_id', async () => {
    const result = (await stepComplete({ journey_id: '', status: 'completed' })) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('unknown');
  });

  it('get_journey_status returns error for missing journey_id', () => {
    const result = getJourneyStatus({ journey_id: '' }) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('unknown');
  });

  it('cancel_journey returns error for missing journey_id', () => {
    const result = cancelJourney({ journey_id: '' }) as any;
    expect(result).toHaveProperty('error');
    expect(result.error.type).toBe('unknown');
  });
});

describe('Journey session — output context propagation', () => {
  const graphId = 'test-graph-context';

  beforeEach(() => {
    storePlan(graphId, makePlan(['step-a', 'step-b', 'step-c']));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('outputs from multiple steps are all available in context', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    const journeyId = start.journey_id;

    await stepComplete({
      journey_id: journeyId,
      status: 'completed',
      outputs: { host: 'localhost', port: '5432' },
    });

    const step2 = (await stepComplete({
      journey_id: journeyId,
      status: 'completed',
      outputs: { db_name: 'mydb' },
    })) as any;

    expect(step2.step.context).toContain('host=localhost');
    expect(step2.step.context).toContain('port=5432');
    expect(step2.step.context).toContain('db_name=mydb');
  });

  it('context is empty on the first step', async () => {
    const start = (await startJourney({ graph_id: graphId })) as any;
    expect(start.step.context).toBe('');
  });
});
