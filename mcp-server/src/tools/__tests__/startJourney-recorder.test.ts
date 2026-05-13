/**
 * Verifies startJourney opens a trace via the configured TraceRecorder.
 * The recorder is mocked at the module boundary so the real
 * createTraceRecorder/fetch path never runs in tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '# Body'),
}));

// Per-test override hook; default returns a minimal frontmatter so the
// recorder's required `title` field is non-empty.
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
    // title comes from the parsed frontmatter, not the graph entry name
    expect(arg.dossier.title).toBe('Mock Title');
    expect(arg.dossier.version).toBe('1.0.0');
    expect(arg.agent.name).toBe('mcp-server');
    expect(typeof arg.agent.host).toBe('string');
    expect(arg.agent.host.length).toBeGreaterThan(0);
    expect(typeof arg.started_at).toBe('string');
    expect(new Date(arg.started_at).toString()).not.toBe('Invalid Date');
  });

  it('records the verified body checksum from the dossier frontmatter', async () => {
    mockParse.mockReturnValueOnce({
      body: '# body',
      frontmatter: {
        title: 'Signed Dossier',
        version: '2.1.0',
        checksum: {
          algorithm: 'sha256',
          hash: 'deadbeefcafebabe1234567890abcdef',
        },
      },
    } as never);
    storeGraph('graph-signed', makePlan(['signed-dossier']));
    await startJourney({ graph_id: 'graph-signed' });

    const arg = mockCreate.mock.calls[0][0];
    expect(arg.dossier.title).toBe('Signed Dossier');
    expect(arg.dossier.version).toBe('2.1.0');
    expect(arg.dossier.checksum).toEqual({
      algorithm: 'sha256',
      hash: 'deadbeefcafebabe1234567890abcdef',
    });
    // No signature recorded when the frontmatter has none.
    expect(arg.dossier.signature).toBeUndefined();
  });

  it('records signature metadata (no signature bytes) when the dossier is signed', async () => {
    mockParse.mockReturnValueOnce({
      body: '# body',
      frontmatter: {
        title: 'Trusted Dossier',
        version: '1.0.0',
        checksum: { algorithm: 'sha256', hash: 'abc123' },
        signature: {
          algorithm: 'ed25519',
          signature: 'BASE64-SIGNATURE-BYTES-NOT-RECORDED',
          public_key: 'PUBKEY-NOT-RECORDED',
          signed_by: 'Yuval Dimnik <yuval.dimnik@gmail.com>',
          key_id: 'test-key-2026',
          signed_at: '2026-05-13T20:00:00Z',
        },
      },
    } as never);
    storeGraph('graph-trusted', makePlan(['trusted-dossier']));
    await startJourney({ graph_id: 'graph-trusted' });

    const arg = mockCreate.mock.calls[0][0];
    expect(arg.dossier.signature).toEqual({
      algorithm: 'ed25519',
      signed_by: 'Yuval Dimnik <yuval.dimnik@gmail.com>',
      key_id: 'test-key-2026',
      signed_at: '2026-05-13T20:00:00Z',
    });
    // Crucially the signature bytes + public key are NOT in the trace.
    const sig = arg.dossier.signature as Record<string, unknown>;
    expect(sig.signature).toBeUndefined();
    expect(sig.public_key).toBeUndefined();
  });

  it('falls back to entry name + "unknown" version when the file does not parse', async () => {
    mockParse.mockImplementationOnce(() => {
      throw new Error('not a valid dossier');
    });
    storeGraph('graph-broken', makePlan(['broken-dossier']));
    await startJourney({ graph_id: 'graph-broken' });

    const arg = mockCreate.mock.calls[0][0];
    expect(arg.dossier.title).toBe('broken-dossier');
    expect(arg.dossier.version).toBe('unknown');
    expect(arg.dossier.checksum).toBeUndefined();
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
