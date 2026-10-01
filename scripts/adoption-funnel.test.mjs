import { describe, expect, it } from 'vitest';

import {
  divergence,
  fetchJson,
  parseLedgerComment,
  rankFor,
  renderLedger,
} from './adoption-funnel.mjs';

const current = {
  collected_at: '2026-10-01T00:00:00.000Z',
  packages: [
    { name: '@ai-dossier/cli', weekly_downloads: 120, daily_downloads: 20, version_count: 4 },
  ],
  ranks: { 'agent skills': { '@ai-dossier/cli': 2 } },
  github: { stars: 10, unique_clones_14d: 4, unique_views_14d: 8, release_asset_downloads: 30 },
};

describe('adoption funnel ledger', () => {
  it('finds a package rank and treats missing results as unranked', () => {
    expect(rankFor([{ package: { name: '@ai-dossier/cli' } }], '@ai-dossier/cli')).toBe(1);
    expect(rankFor([], '@ai-dossier/cli')).toBeNull();
  });

  it('only sends the workflow token to GitHub', async () => {
    const headers = [];
    const fetchImpl = async (_url, options) => {
      headers.push(options.headers);
      return { ok: true, json: async () => ({}) };
    };
    await fetchJson('https://api.npmjs.org/downloads/point/last-day/example', {
      fetchImpl,
      token: 'secret',
    });
    await fetchJson('https://api.github.com/repos/imboard-ai/ai-dossier', {
      fetchImpl,
      token: 'secret',
    });
    expect(headers[0].authorization).toBeUndefined();
    expect(headers[1].authorization).toBe('Bearer secret');
  });

  it('flags npm growth when GitHub signals remain flat', () => {
    const prior = { ...current, packages: [{ ...current.packages[0], weekly_downloads: 100 }] };
    expect(divergence(current, prior)).toMatchObject({ flagged: true });
  });

  it('renders a parseable structured ledger comment', () => {
    const body = renderLedger(current, null);
    expect(body).toContain('Baseline entry.');
    expect(parseLedgerComment(body)).toEqual(current);
  });
});
