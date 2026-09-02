import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateScorecard,
  buildDispatchInfo,
  joinRepoRows,
  main,
  pickCanonicalRun,
  projectSlug,
  renderDigest,
  renderJson,
  renderMarkdown,
  ScorecardError,
  windowStartDate,
} from './model-scorecard.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function run(model, overrides = {}) {
  return {
    issue: 1,
    run: 'r-1-aaaa',
    model,
    phases: [],
    last_phase: 'ship',
    last_status: 'done',
    started_at: '2026-08-25T00:00:00Z',
    ended_at: '2026-08-25T01:00:00Z',
    total_seconds: 3600,
    ...overrides,
  };
}

describe('windowStartDate', () => {
  it('subtracts the window in whole days', () => {
    expect(windowStartDate(30, new Date('2026-09-02T00:00:00Z'))).toBe('2026-08-03');
    expect(windowStartDate(7, new Date('2026-09-02T00:00:00Z'))).toBe('2026-08-26');
  });
});

describe('projectSlug', () => {
  it('maps owner/name to the sched directory slug', () => {
    expect(projectSlug('imboard-ai/ai-dossier')).toBe('imboard-ai-ai-dossier');
    expect(projectSlug('imboard-ai/imboard-monorepo')).toBe('imboard-ai-imboard-monorepo');
  });
});

describe('pickCanonicalRun', () => {
  it('returns null for an empty list', () => {
    expect(pickCanonicalRun([])).toBeNull();
  });

  it('prefers a delivered run over a more recent blocked one', () => {
    const delivered = run('sonnet', { started_at: '2026-08-20T00:00:00Z' });
    const blocked = run('opus', {
      started_at: '2026-08-25T00:00:00Z',
      last_phase: 'plan',
      last_status: 'blocked',
    });
    expect(pickCanonicalRun([delivered, blocked])).toBe(delivered);
  });

  it('falls back to the most recently started run when none delivered', () => {
    const older = run('sonnet', {
      started_at: '2026-08-20T00:00:00Z',
      last_phase: 'plan',
      last_status: 'blocked',
    });
    const newer = run('opus', {
      started_at: '2026-08-25T00:00:00Z',
      last_phase: 'implement',
      last_status: 'blocked',
    });
    expect(pickCanonicalRun([older, newer])).toBe(newer);
  });
});

describe('buildDispatchInfo', () => {
  const SINCE = '2026-08-25T00:00:00Z';
  const UNTIL = '2026-09-02T23:59:59Z';

  it('records tier and agent CLI from spawned/redispatched events', () => {
    const events = [
      {
        ts: '2026-08-26T00:00:00Z',
        event: 'spawned',
        issue: 10,
        tier: 'mid',
        cmd: 'claude -p --model sonnet',
      },
      {
        ts: '2026-08-27T00:00:00Z',
        event: 'redispatched',
        issue: 10,
        tier: 'strong',
        cmd: 'claude -p --model opus',
      },
    ];
    const info = buildDispatchInfo(events, SINCE, UNTIL);
    const entry = info.get(10);
    expect(entry.tier).toBe('strong');
    expect(entry.agentCli).toBe('claude');
    expect(entry.escalations).toBe(1);
  });

  it('counts stalled and fence-written events per issue', () => {
    const events = [
      { ts: '2026-08-26T00:00:00Z', event: 'stalled', issue: 20 },
      { ts: '2026-08-26T01:00:00Z', event: 'stalled', issue: 20 },
      { ts: '2026-08-26T02:00:00Z', event: 'fence-written', issue: 20 },
    ];
    const info = buildDispatchInfo(events, SINCE, UNTIL);
    const entry = info.get(20);
    expect(entry.stalls).toBe(2);
    expect(entry.unverifiedExits).toBe(1);
  });

  it('excludes events outside the window', () => {
    const events = [{ ts: '2026-08-01T00:00:00Z', event: 'stalled', issue: 30 }];
    const info = buildDispatchInfo(events, SINCE, UNTIL);
    expect(info.has(30)).toBe(false);
  });

  it('ignores events with no issue number', () => {
    const events = [{ ts: '2026-08-26T00:00:00Z', event: 'stalled' }];
    const info = buildDispatchInfo(events, SINCE, UNTIL);
    expect(info.size).toBe(0);
  });
});

const canonicalModelFn = (raw) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/^llmgateway\//, '');

describe('joinRepoRows', () => {
  it('joins trail, cost, and dispatch data by issue, canonicalizing the model', () => {
    const trails = [
      {
        issue: 1,
        milestones: [
          { phase: 'gate', status: 'done', keys: {} },
          { phase: 'review', status: 'done', keys: { fixed: '3', escalated: '0' } },
        ],
      },
    ];
    const statsReport = { runs: [run('llmgateway/glm-5.3', { issue: 1 })] };
    const schedCost = {
      issues: [
        {
          issue: 1,
          total_cost_usd: 2.5,
          input_tokens: 100,
          output_tokens: 200,
          duration_ms: 60000,
          tier: null,
        },
      ],
    };
    const dispatchInfo = buildDispatchInfo(
      [
        {
          ts: '2026-08-25T00:30:00Z',
          event: 'spawned',
          issue: 1,
          tier: 'mid',
          cmd: 'opencode run',
        },
      ],
      '2026-08-25T00:00:00Z',
      '2026-09-02T00:00:00Z'
    );

    const rows = joinRepoRows({
      repo: 'imboard-ai/ai-dossier',
      trails,
      statsReport,
      schedCost,
      dispatchInfo,
      canonicalModelFn,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: 'imboard-ai/ai-dossier',
      issue: 1,
      model: 'glm-5.3',
      rawModel: 'llmgateway/glm-5.3',
      tier: 'mid',
      agentCli: 'opencode',
      delivered: true,
      blocked: false,
      costUsd: 2.5,
      apiMinutes: 1,
      reviewFixed: 3,
      reviewEscalated: 0,
    });
  });

  it('falls back to the sched-cost tier when no dispatch info is recorded', () => {
    const trails = [{ issue: 2, milestones: [] }];
    const statsReport = { runs: [run('sonnet', { issue: 2 })] };
    const schedCost = { issues: [{ issue: 2, total_cost_usd: null, tier: 'strong' }] };
    const rows = joinRepoRows({
      repo: 'imboard-ai/ai-dossier',
      trails,
      statsReport,
      schedCost,
      dispatchInfo: new Map(),
      canonicalModelFn,
    });
    expect(rows[0].tier).toBe('strong');
    expect(rows[0].costUsd).toBeNull();
  });

  it('picks up review fields from the last review milestone, not an earlier one', () => {
    const trails = [
      {
        issue: 3,
        milestones: [
          { phase: 'review', status: 'partial', keys: { fixed: '1', escalated: '1' } },
          { phase: 'review', status: 'done', keys: { fixed: '4', escalated: '0' } },
        ],
      },
    ];
    const statsReport = { runs: [run('sonnet', { issue: 3 })] };
    const schedCost = { issues: [{ issue: 3 }] };
    const rows = joinRepoRows({
      repo: 'imboard-ai/ai-dossier',
      trails,
      statsReport,
      schedCost,
      dispatchInfo: new Map(),
      canonicalModelFn,
    });
    expect(rows[0].reviewFixed).toBe(4);
    expect(rows[0].reviewEscalated).toBe(0);
  });
});

describe('aggregateScorecard', () => {
  const meta = {
    windowStart: '2026-08-25',
    windowEnd: '2026-09-02',
    generatedAt: '2026-09-02T00:00:00Z',
  };

  it('buckets by model x repo x tier and rolls up per-model totals', () => {
    const rows = [
      {
        repo: 'r1',
        model: 'sonnet',
        tier: 'mid',
        delivered: true,
        blocked: false,
        costUsd: 2,
        inputTokens: 10,
        outputTokens: 20,
        apiMinutes: 5,
        stalls: 0,
        escalations: 0,
        unverifiedExits: 0,
        reviewFixed: 1,
        reviewEscalated: 0,
      },
      {
        repo: 'r1',
        model: 'sonnet',
        tier: 'mid',
        delivered: false,
        blocked: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        apiMinutes: null,
        stalls: 1,
        escalations: 0,
        unverifiedExits: 0,
        reviewFixed: null,
        reviewEscalated: null,
      },
      {
        repo: 'r2',
        model: 'sonnet',
        tier: 'strong',
        delivered: true,
        blocked: false,
        costUsd: 6,
        inputTokens: 30,
        outputTokens: 40,
        apiMinutes: 15,
        stalls: 0,
        escalations: 1,
        unverifiedExits: 0,
        reviewFixed: 2,
        reviewEscalated: 1,
      },
      {
        repo: 'r1',
        model: null,
        tier: null,
        delivered: true,
        blocked: false,
        costUsd: 1,
        inputTokens: 5,
        outputTokens: 5,
        apiMinutes: 2,
        stalls: 0,
        escalations: 0,
        unverifiedExits: 0,
        reviewFixed: 0,
        reviewEscalated: 0,
      },
    ];
    const sc = aggregateScorecard(rows, meta);

    expect(sc.buckets).toHaveLength(3);
    const midBucket = sc.buckets.find((b) => b.model === 'sonnet' && b.tier === 'mid');
    expect(midBucket).toMatchObject({ n: 2, delivered: 1, blocked: 1, costSamples: 1 });
    expect(midBucket.deliveryRate).toBeCloseTo(0.5);

    const sonnetTotal = sc.totals.find((t) => t.model === 'sonnet');
    expect(sonnetTotal).toMatchObject({ n: 3, delivered: 2 });
    expect(sonnetTotal.costPerDeliveredUsd).toBeCloseTo(4); // (2 + 6) / 2

    const unknownTotal = sc.totals.find((t) => t.model === '<unknown>');
    expect(unknownTotal.n).toBe(1);

    expect(sc.grandTotal.n).toBe(4);
    expect(sc.grandTotal.delivered).toBe(3);
  });

  it('reports null cost/speed when no delivered row measured them', () => {
    const rows = [
      {
        repo: 'r1',
        model: 'x',
        tier: 't',
        delivered: false,
        blocked: true,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        apiMinutes: null,
        stalls: 0,
        escalations: 0,
        unverifiedExits: 0,
        reviewFixed: null,
        reviewEscalated: null,
      },
    ];
    const sc = aggregateScorecard(rows, meta);
    expect(sc.buckets[0].costPerDeliveredUsd).toBeNull();
    expect(sc.buckets[0].medianApiMinutes).toBeNull();
    expect(sc.buckets[0].deliveryRate).toBe(0);
  });
});

describe('renderMarkdown / renderJson', () => {
  const scorecard = aggregateScorecard(
    [
      {
        repo: 'r1',
        model: 'sonnet',
        tier: 'mid',
        delivered: true,
        blocked: false,
        costUsd: 2,
        inputTokens: 10,
        outputTokens: 20,
        apiMinutes: 5,
        stalls: 0,
        escalations: 0,
        unverifiedExits: 0,
        reviewFixed: 1,
        reviewEscalated: 0,
      },
    ],
    { windowStart: '2026-08-25', windowEnd: '2026-09-02', generatedAt: '2026-09-02T00:00:00Z' }
  );
  scorecard.warnings = ['example warning'];

  it('renders a markdown table with the confidence column and a warnings section', () => {
    const md = renderMarkdown(scorecard);
    expect(md).toContain('# Model Scorecard');
    expect(md).toContain('confidence column');
    expect(md).toContain('`sonnet`');
    expect(md).toContain('example warning');
    expect(md).toContain('## Reconciliation');
  });

  it('renders valid JSON that round-trips the scorecard', () => {
    const json = renderJson(scorecard);
    const parsed = JSON.parse(json);
    expect(parsed.windowStart).toBe('2026-08-25');
    expect(parsed.totals[0].model).toBe('sonnet');
  });
});

describe('renderDigest', () => {
  const meta = {
    windowStart: '2026-08-25',
    windowEnd: '2026-09-02',
    generatedAt: '2026-09-02T00:00:00Z',
  };

  it('produces a 6-line digest naming the best model per dimension', () => {
    const sc = aggregateScorecard(
      [
        {
          repo: 'r1',
          model: 'cheap',
          tier: 't',
          delivered: true,
          blocked: false,
          costUsd: 1,
          inputTokens: 1,
          outputTokens: 1,
          apiMinutes: 10,
          stalls: 0,
          escalations: 0,
          unverifiedExits: 0,
          reviewFixed: 0,
          reviewEscalated: 0,
        },
        {
          repo: 'r1',
          model: 'good',
          tier: 't',
          delivered: true,
          blocked: false,
          costUsd: 5,
          inputTokens: 1,
          outputTokens: 1,
          apiMinutes: 1,
          stalls: 0,
          escalations: 0,
          unverifiedExits: 0,
          reviewFixed: 0,
          reviewEscalated: 0,
        },
      ],
      meta
    );
    const digest = renderDigest(sc, null);
    const lines = digest.split('\n');
    expect(lines).toHaveLength(6);
    expect(digest).toContain('cheap');
    expect(digest).toContain('none'); // no previous week to compare against
  });

  it('flags a model whose delivery rate dropped more than 10 points week-over-week', () => {
    const previous = { totals: [{ model: 'flaky', deliveryRate: 0.9 }] };
    const sc = aggregateScorecard(
      [
        {
          repo: 'r1',
          model: 'flaky',
          tier: 't',
          delivered: false,
          blocked: true,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          apiMinutes: null,
          stalls: 0,
          escalations: 0,
          unverifiedExits: 0,
          reviewFixed: null,
          reviewEscalated: null,
        },
        {
          repo: 'r1',
          model: 'flaky',
          tier: 't',
          delivered: true,
          blocked: false,
          costUsd: 1,
          inputTokens: 1,
          outputTokens: 1,
          apiMinutes: 1,
          stalls: 0,
          escalations: 0,
          unverifiedExits: 0,
          reviewFixed: 0,
          reviewEscalated: 0,
        },
      ],
      meta
    );
    const digest = renderDigest(sc, previous);
    expect(digest).toContain('flaky');
    expect(digest).not.toContain('none');
  });
});

describe('main (integration, fixture gh + fixture ~/.dossier)', () => {
  let home;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'model-scorecard-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('throws a ScorecardError when cli/dist is missing', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'model-scorecard-noroot-'));
    expect(() =>
      main({
        repoRoot: emptyRoot,
        dryRun: true,
        repos: [],
        home,
        now: new Date('2026-09-02T00:00:00Z'),
        log: () => {},
      })
    ).toThrow(ScorecardError);
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it('runs end-to-end against fixture gh output and local telemetry', () => {
    mkdirSync(join(home, '.dossier'), { recursive: true });
    writeFileSync(
      join(home, '.dossier', 'runs.jsonl'),
      `${JSON.stringify({ unit: 'issue:1', total_cost_usd: 3.5, input_tokens: 100, output_tokens: 200, duration_ms: 120000, tier: null, model: 'sonnet' })}\n`
    );
    mkdirSync(join(home, '.dossier', 'sched', 'imboard-ai-ai-dossier'), { recursive: true });
    writeFileSync(
      join(home, '.dossier', 'sched', 'imboard-ai-ai-dossier', 'events.jsonl'),
      `${JSON.stringify({ ts: '2026-08-26T00:00:00Z', event: 'spawned', issue: 1, tier: 'mid', cmd: 'claude -p' })}\n`
    );

    const gateComment =
      '<!-- runstate:v1 -->\nphase=gate status=done run=r-1-aaaa at=2026-08-26T00:00:00Z model=claude-sonnet-5 next=setup\n';
    const shipComment =
      '<!-- runstate:v1 -->\nphase=ship status=done run=r-1-aaaa at=2026-08-26T02:00:00Z next=report\n';

    const execFile = (cmd, args) => {
      if (cmd === 'gh') {
        return JSON.stringify([
          { number: 1, comments: [{ body: gateComment }, { body: shipComment }] },
        ]);
      }
      throw new Error(`unexpected command in test: ${cmd} ${args.join(' ')}`);
    };

    const { scorecard, digest } = main({
      repoRoot: REPO_ROOT,
      repos: ['imboard-ai/ai-dossier'],
      dryRun: true,
      execFile,
      home,
      now: new Date('2026-09-02T00:00:00Z'),
      log: () => {},
    });

    expect(scorecard.totals).toHaveLength(1);
    expect(scorecard.totals[0].model).toBe('claude-sonnet-5');
    expect(scorecard.totals[0].delivered).toBe(1);
    expect(scorecard.totals[0].costPerDeliveredUsd).toBeCloseTo(3.5);
    expect(digest.split('\n')).toHaveLength(6);
  });
});
