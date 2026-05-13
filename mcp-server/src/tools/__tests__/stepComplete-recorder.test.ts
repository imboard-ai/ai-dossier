/**
 * Verifies stepComplete and cancelJourney call the TraceRecorder:
 * - appendStep on every step completion (completed or failed)
 * - complete with status=success when the last step finishes
 * - complete with status=failed when a step reports failure
 * - complete with status=cancelled when cancelJourney runs
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '# Body'),
}));

// Per-test override hook; default returns frontmatter so the audit
// metadata (version + checksum + signature) lands on each appendStep.
const mockParse = vi.fn((raw: string) => ({
  body: raw,
  frontmatter: { title: 'Mock Title', version: '1.0.0' },
}));

vi.mock('@ai-dossier/core', () => ({
  parseDossierContent: (raw: string) => mockParse(raw),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockRecorder = {
  enabled: true,
  create: vi.fn().mockResolvedValue(undefined),
  appendStep: vi.fn().mockResolvedValue(undefined),
  complete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../orchestration/recorder', async () => {
  // Use the real finalizeTrace helper; only swap in the mock recorder.
  const actual = await vi.importActual<typeof import('../../orchestration/recorder')>(
    '../../orchestration/recorder'
  );
  return {
    ...actual,
    getRecorder: vi.fn(() => mockRecorder),
  };
});

import type { ExecutionPlan } from '../../orchestration/types';
import { storeGraph } from '../../utils/graphStore';
import { cancelJourney } from '../cancelJourney';
import { startJourney } from '../startJourney';
import { stepComplete } from '../stepComplete';

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

describe('stepComplete → TraceRecorder', () => {
  beforeEach(() => {
    mockRecorder.create.mockClear();
    mockRecorder.appendStep.mockClear();
    mockRecorder.complete.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  it('appends each step and completes with status=success on final step', async () => {
    storeGraph('g-happy', makePlan(['a', 'b']));
    const start = (await startJourney({ graph_id: 'g-happy' })) as { journey_id: string };
    const journeyId = start.journey_id;

    await stepComplete({ journey_id: journeyId, status: 'completed', outputs: { x: 1 } });
    await stepComplete({ journey_id: journeyId, status: 'completed', outputs: { y: 2 } });

    expect(mockRecorder.appendStep).toHaveBeenCalledTimes(2);

    const [traceId1, step1] = mockRecorder.appendStep.mock.calls[0];
    expect(traceId1).toBe(journeyId);
    expect(step1.step_id).toBe('a-0');
    expect(step1.type).toBe('completed');
    expect(step1.outputs).toEqual({ x: 1 });
    expect(step1.dossier).toBe('a');
    expect(step1.index).toBe(0);
    expect(typeof step1.timestamp).toBe('string');

    const [, step2] = mockRecorder.appendStep.mock.calls[1];
    expect(step2.step_id).toBe('b-1');

    expect(mockRecorder.complete).toHaveBeenCalledTimes(1);
    const [completedTraceId, completion] = mockRecorder.complete.mock.calls[0];
    expect(completedTraceId).toBe(journeyId);
    expect(completion.status).toBe('success');
    expect(typeof completion.completed_at).toBe('string');
    expect(typeof completion.duration_ms).toBe('number');
    expect(completion.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('completes with status=failed when a step reports failure', async () => {
    storeGraph('g-fail', makePlan(['a', 'b']));
    const start = (await startJourney({ graph_id: 'g-fail' })) as { journey_id: string };

    await stepComplete({ journey_id: start.journey_id, status: 'failed' });

    expect(mockRecorder.appendStep).toHaveBeenCalledTimes(1);
    expect(mockRecorder.appendStep.mock.calls[0][1].type).toBe('failed');

    expect(mockRecorder.complete).toHaveBeenCalledTimes(1);
    expect(mockRecorder.complete.mock.calls[0][1].status).toBe('failed');
  });

  it('records dossier_meta (version + checksum) on each appendStep', async () => {
    // Different frontmatter per dossier so we can prove the cached metadata
    // is per-step, not just the entry dossier's metadata reused.
    mockParse
      .mockReturnValueOnce({
        body: '# a',
        frontmatter: {
          title: 'Dossier A',
          version: '1.0.0',
          checksum: { algorithm: 'sha256', hash: 'aaa-hash' },
        },
      } as never)
      .mockReturnValueOnce({
        body: '# b',
        frontmatter: {
          title: 'Dossier B',
          version: '2.5.0',
          checksum: { algorithm: 'sha256', hash: 'bbb-hash' },
          signature: {
            algorithm: 'ed25519',
            signature: 'sig-bytes-ignored',
            signed_by: 'tester',
            key_id: 'k1',
            signed_at: '2026-05-13T20:00:00Z',
          },
        },
      } as never);

    storeGraph('g-meta', makePlan(['a', 'b']));
    const start = (await startJourney({ graph_id: 'g-meta' })) as { journey_id: string };
    await stepComplete({ journey_id: start.journey_id, status: 'completed' });
    await stepComplete({ journey_id: start.journey_id, status: 'completed' });

    expect(mockRecorder.appendStep).toHaveBeenCalledTimes(2);

    const stepA = mockRecorder.appendStep.mock.calls[0][1];
    expect(stepA.dossier_meta).toEqual({
      title: 'Dossier A',
      version: '1.0.0',
      checksum: { algorithm: 'sha256', hash: 'aaa-hash' },
    });

    const stepB = mockRecorder.appendStep.mock.calls[1][1];
    expect(stepB.dossier_meta.title).toBe('Dossier B');
    expect(stepB.dossier_meta.version).toBe('2.5.0');
    expect(stepB.dossier_meta.checksum).toEqual({ algorithm: 'sha256', hash: 'bbb-hash' });
    expect(stepB.dossier_meta.signature).toEqual({
      algorithm: 'ed25519',
      signed_by: 'tester',
      key_id: 'k1',
      signed_at: '2026-05-13T20:00:00Z',
    });
    // Signature bytes + public key are NEVER recorded.
    expect(stepB.dossier_meta.signature.signature).toBeUndefined();
    expect(stepB.dossier_meta.signature.public_key).toBeUndefined();
  });

  it('does not finalize on an intermediate (non-final) completed step', async () => {
    storeGraph('g-mid', makePlan(['a', 'b', 'c']));
    const start = (await startJourney({ graph_id: 'g-mid' })) as { journey_id: string };

    await stepComplete({ journey_id: start.journey_id, status: 'completed' });

    expect(mockRecorder.appendStep).toHaveBeenCalledTimes(1);
    expect(mockRecorder.complete).not.toHaveBeenCalled();
  });

  it('does not call recorder when journey_id is missing', async () => {
    await stepComplete({ journey_id: '', status: 'completed' });
    expect(mockRecorder.appendStep).not.toHaveBeenCalled();
    expect(mockRecorder.complete).not.toHaveBeenCalled();
  });

  it('does not call recorder when journey is not found', async () => {
    await stepComplete({ journey_id: 'nope', status: 'completed' });
    expect(mockRecorder.appendStep).not.toHaveBeenCalled();
    expect(mockRecorder.complete).not.toHaveBeenCalled();
  });
});

describe('cancelJourney → TraceRecorder.complete', () => {
  beforeEach(() => {
    mockRecorder.create.mockClear();
    mockRecorder.appendStep.mockClear();
    mockRecorder.complete.mockClear();
  });

  afterEach(() => vi.clearAllMocks());

  it('completes the trace with status=cancelled', async () => {
    storeGraph('g-cancel', makePlan(['a', 'b']));
    const start = (await startJourney({ graph_id: 'g-cancel' })) as { journey_id: string };

    cancelJourney({ journey_id: start.journey_id, reason: 'user-aborted' });

    expect(mockRecorder.complete).toHaveBeenCalledTimes(1);
    const [traceId, completion] = mockRecorder.complete.mock.calls[0];
    expect(traceId).toBe(start.journey_id);
    expect(completion.status).toBe('cancelled');
    expect(typeof completion.completed_at).toBe('string');
    expect(typeof completion.duration_ms).toBe('number');
  });

  it('does not call recorder when journey is not found', () => {
    cancelJourney({ journey_id: 'missing', reason: 'x' });
    expect(mockRecorder.complete).not.toHaveBeenCalled();
  });
});
