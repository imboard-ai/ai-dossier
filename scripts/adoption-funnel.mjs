#!/usr/bin/env node
// Public adoption signals are intentionally kept in issue comments (#985), not a repo ledger.

import { pathToFileURL } from 'node:url';

export const PACKAGES = [
  '@ai-dossier/cli',
  '@ai-dossier/core',
  '@ai-dossier/mcp-server',
  '@ai-dossier/sched',
  '@ai-dossier/worktree-pool',
];

export const KEYWORDS = [
  'claude code skill',
  'agent skills',
  'MCP server',
  'secure MCP',
  'coding agents',
  'agent orchestration',
  'LLM workflow',
  'signed workflow',
];

const MARKER = 'adoption-funnel:v1';

export async function fetchJson(url, { fetchImpl = fetch, token } = {}) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      // Never send the workflow token to public npm endpoints.
      ...(token && url.startsWith('https://api.github.com/')
        ? { authorization: `Bearer ${token}` }
        : {}),
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

export function rankFor(results, packageName) {
  const index = results.findIndex((result) => result.package?.name === packageName);
  return index === -1 ? null : index + 1;
}

async function npmPackageMetrics(name, options) {
  const encoded = encodeURIComponent(name);
  const [weekly, daily, metadata] = await Promise.all([
    fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`, options),
    fetchJson(`https://api.npmjs.org/downloads/point/last-day/${encoded}`, options),
    fetchJson(`https://registry.npmjs.org/${encoded}`, options),
  ]);
  return {
    name,
    weekly_downloads: weekly.downloads ?? null,
    daily_downloads: daily.downloads ?? null,
    version_count: Object.keys(metadata.versions ?? {}).length,
  };
}

async function npmRanks(options) {
  const ranks = {};
  const rankSearchStatus = {};
  await Promise.all(
    KEYWORDS.map(async (keyword) => {
      const result = await fetchJson(
        `https://registry.npmjs.com/-/v1/search?text=${encodeURIComponent(keyword)}&size=250`,
        options
      ).catch(() => null);
      if (!result) rankSearchStatus[keyword] = 'unavailable';
      ranks[keyword] = Object.fromEntries(
        PACKAGES.map((packageName) => [packageName, rankFor(result?.objects ?? [], packageName)])
      );
    })
  );
  return { ranks, rank_search_status: rankSearchStatus };
}

export async function collectMetrics({ repo, fetchImpl = fetch, token }) {
  const options = { fetchImpl, token };
  const githubBase = `https://api.github.com/repos/${repo}`;
  const unavailable = (value) => Promise.resolve(value).catch(() => null);
  const [packages, rankMetrics, repository, clones, views, releases] = await Promise.all([
    Promise.all(
      PACKAGES.map((name) =>
        npmPackageMetrics(name, options).catch(() => ({
          name,
          weekly_downloads: null,
          daily_downloads: null,
          version_count: null,
        }))
      )
    ),
    npmRanks(options),
    unavailable(fetchJson(githubBase, options)),
    unavailable(fetchJson(`${githubBase}/traffic/clones`, options)),
    unavailable(fetchJson(`${githubBase}/traffic/views`, options)),
    unavailable(fetchJson(`${githubBase}/releases?per_page=100`, options)),
  ]);
  const { ranks, rank_search_status } = rankMetrics;
  return {
    collected_at: new Date().toISOString(),
    packages,
    ranks,
    rank_search_status,
    github: {
      stars: repository?.stargazers_count ?? null,
      unique_clones_14d: clones?.uniques ?? null,
      unique_views_14d: views?.uniques ?? null,
      release_asset_downloads: (releases ?? []).reduce(
        (sum, release) =>
          sum + (release.assets ?? []).reduce((n, asset) => n + (asset.download_count ?? 0), 0),
        0
      ),
    },
  };
}

export function parseLedgerComment(body) {
  const match = body.match(new RegExp(`<!-- ${MARKER} ([^>]+) -->`));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function divergence(current, previous) {
  if (!previous) return { flagged: false, reason: 'Baseline entry.' };
  const total = (metrics) =>
    metrics.packages.reduce((sum, item) => sum + (item.weekly_downloads ?? 0), 0);
  const npmDelta = total(current) - total(previous);
  const hasTrafficMetrics = (metrics) =>
    Number.isFinite(metrics.github?.unique_clones_14d) &&
    Number.isFinite(metrics.github?.unique_views_14d);
  if (!hasTrafficMetrics(current) || !hasTrafficMetrics(previous)) {
    return { flagged: false, reason: 'Unknown: GitHub traffic unavailable.' };
  }
  if (!Number.isFinite(current.github?.stars) || !Number.isFinite(previous.github?.stars)) {
    return { flagged: false, reason: 'Unknown: GitHub star data unavailable.' };
  }
  const githubFlat =
    current.github.stars <= previous.github.stars &&
    current.github.unique_clones_14d <= previous.github.unique_clones_14d &&
    current.github.unique_views_14d <= previous.github.unique_views_14d;
  return {
    flagged: npmDelta > 0 && githubFlat,
    reason:
      npmDelta > 0 && githubFlat
        ? 'Npm increased while GitHub stars, unique clones, and unique views stayed flat; likely automation/crawlers.'
        : 'No npm/GitHub divergence detected by the heuristic.',
  };
}

const delta = (value, prior) =>
  prior === undefined || prior === null
    ? 'baseline'
    : `${value - prior >= 0 ? '+' : ''}${value - prior}`;

export function renderLedger(current, previous) {
  const priorPackages = new Map((previous?.packages ?? []).map((item) => [item.name, item]));
  const signal = divergence(current, previous);
  const rows = current.packages
    .map((item) => {
      const prior = priorPackages.get(item.name);
      return `| ${item.name} | ${item.weekly_downloads ?? 'unavailable'} (${prior ? delta(item.weekly_downloads, prior.weekly_downloads) : 'baseline'}) | ${item.daily_downloads ?? 'unavailable'} | ${item.version_count ?? 'unavailable'} |`;
    })
    .join('\n');
  const ranks = KEYWORDS.map((keyword) => {
    const unavailable = current.rank_search_status?.[keyword] === 'unavailable';
    const values = PACKAGES.map((name) => {
      const rank = current.ranks[keyword]?.[name];
      return `${name}: ${unavailable ? 'unavailable' : (rank ?? 'unranked')}`;
    }).join('<br>');
    return `| ${keyword} | ${values} |`;
  }).join('\n');
  return `## Weekly adoption funnel ledger\n\nCollected: ${current.collected_at}\n\n### Npm\n| Package | Weekly downloads (WoW) | Daily downloads | Published versions |\n| --- | ---: | ---: | ---: |\n${rows}\n\n### Npm search ranks\n| Keyword | Rank (1 is highest) |\n| --- | --- |\n${ranks}\n\n### GitHub\n| Signal | Value |\n| --- | ---: |\n| Stars | ${current.github.stars ?? 'unavailable'} |\n| Unique clones (rolling 14 days) | ${current.github.unique_clones_14d ?? 'unavailable'} |\n| Unique views (rolling 14 days) | ${current.github.unique_views_14d ?? 'unavailable'} |\n| Release asset downloads (all releases) | ${current.github.release_asset_downloads ?? 'unavailable'} |\n\n### Divergence\n${signal.flagged ? '**FLAGGED:**' : 'Not flagged:'} ${signal.reason}\n\nOut of scope: registry accounts/pulls (#986) and website traffic (#987).\n\n<!-- ${MARKER} ${JSON.stringify(current)} -->`;
}

export async function latestLedger({ repo, issue, fetchImpl = fetch, token }) {
  const comments = await fetchJson(
    `https://api.github.com/repos/${repo}/issues/${issue}/comments?per_page=100&sort=created&direction=desc`,
    { fetchImpl, token }
  );
  return comments.map((comment) => parseLedgerComment(comment.body)).find(Boolean) ?? null;
}

export async function run({ repo, issue, fetchImpl = fetch, token }) {
  const [current, previous] = await Promise.all([
    collectMetrics({ repo, fetchImpl, token }),
    latestLedger({ repo, issue, fetchImpl, token }),
  ]);
  const body = renderLedger(current, previous);
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/issues/${issue}/comments`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!response.ok)
    throw new Error(`Could not post adoption ledger: ${response.status} ${response.statusText}`);
  return { current, previous, body };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const issue = Number(process.env.ADOPTION_FUNNEL_ISSUE ?? '985');
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  run({ repo, issue, token }).then(({ current }) =>
    console.log(`Posted adoption ledger at ${current.collected_at}`)
  );
}
