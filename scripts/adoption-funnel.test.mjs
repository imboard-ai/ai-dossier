import { describe, expect, it } from 'vitest';

import {
  collectMetrics,
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

  it('reports unknown instead of flagging when GitHub traffic is unavailable', () => {
    const prior = {
      ...current,
      packages: [{ ...current.packages[0], weekly_downloads: 100 }],
      github: { ...current.github, unique_clones_14d: null, unique_views_14d: null },
    };
    const latest = {
      ...current,
      github: { ...current.github, unique_clones_14d: null, unique_views_14d: null },
    };

    expect(divergence(latest, prior)).toEqual({
      flagged: false,
      reason: 'Unknown: GitHub traffic unavailable.',
    });
  });

  it('renders failed npm searches as unavailable, not unranked', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith('https://api.npmjs.org/downloads/')) {
        return { ok: true, json: async () => ({ downloads: 1 }) };
      }
      if (url.startsWith('https://registry.npm.org/')) {
        return { ok: true, json: async () => ({ versions: {} }) };
      }
      if (url.startsWith('https://registry.npmjs.com/-/v1/search?')) {
        if (url.includes('text=agent%20skills')) {
          return { ok: false, status: 503, statusText: 'Service Unavailable' };
        }
        return { ok: true, json: async () => ({ objects: [] }) };
      }
      if (url === 'https://api.github.com/repos/imboard-ai/ai-dossier') {
        return { ok: true, json: async () => ({ stargazers_count: 10 }) };
      }
      if (url.endsWith('/traffic/clones') || url.endsWith('/traffic/views')) {
        return { ok: false, status: 403, statusText: 'Forbidden' };
      }
      if (url.endsWith('/releases?per_page=100')) {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const metrics = await collectMetrics({ repo: 'imboard-ai/ai-dossier', fetchImpl });
    const body = renderLedger(metrics, null);

    expect(metrics.ranks['agent skills']['@ai-dossier/cli']).toBe('unavailable');
    expect(metrics.ranks['claude code skill']['@ai-dossier/cli']).toBeNull();
    expect(body).toContain('@ai-dossier/cli: unavailable');
    expect(body).toContain('@ai-dossier/cli: unranked');
  });

  it('renders a parseable structured ledger comment', () => {
    const body = renderLedger(current, null);
    expect(body).toContain('Baseline entry.');
    expect(parseLedgerComment(body)).toEqual(current);
  });
});
