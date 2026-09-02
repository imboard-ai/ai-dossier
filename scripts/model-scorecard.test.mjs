import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateAgentRunLog,
  aggregateScorecard,
  attachDeliveryRateDeltas,
  buildDispatchInfo,
  issueFromRunLogName,
  joinRepoRows,
  main,
  mergeCost,
  parseArgs,
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

const providerOfFn = (raw) =>
  raw.trim().toLowerCase().startsWith('llmgateway/') ? 'llmgateway' : null;

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
      providerOfFn,
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
      providerOfFn,
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
      providerOfFn,
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

  it('does not misassign columns when a raw model id contains a space', () => {
    const rows = [
      {
        repo: 'imboard-ai/ai-dossier',
        model: 'weird model with spaces',
        tier: 'mid',
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
    ];
    const sc = aggregateScorecard(rows, meta);
    expect(sc.buckets).toHaveLength(1);
    expect(sc.buckets[0]).toMatchObject({
      model: 'weird model with spaces',
      repo: 'imboard-ai/ai-dossier',
      tier: 'mid',
    });
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

  describe('provider sub-rows (#566 AC2)', () => {
    const row = (over) => ({
      repo: 'r1',
      model: 'glm-5.3',
      tier: 'mid',
      provider: null,
      delivered: true,
      blocked: false,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      apiMinutes: null,
      stalls: 0,
      escalations: 0,
      unverifiedExits: 0,
      reviewFixed: null,
      reviewEscalated: null,
      ...over,
    });

    it('splits a folded model row by the gateway that served each run', () => {
      const sc = aggregateScorecard(
        [
          row({ provider: 'llmgateway', costUsd: 2 }),
          row({ provider: 'llmgateway', costUsd: 4 }),
          row({ provider: 'openrouter/z-ai', costUsd: 9 }),
        ],
        meta
      );
      // One model row -- the fold AC2 asks for -- with the providers still legible under it.
      expect(sc.totals).toHaveLength(1);
      expect(sc.totals[0].n).toBe(3);
      expect(sc.totals[0].providers.map((p) => [p.provider, p.n, p.costPerDeliveredUsd])).toEqual([
        ['llmgateway', 2, 3],
        ['openrouter/z-ai', 1, 9],
      ]);
    });

    it('labels a run whose model id named no gateway rather than leaving it blank', () => {
      const sc = aggregateScorecard([row({ provider: null })], meta);
      expect(sc.totals[0].providers.map((p) => p.provider)).toEqual(['direct']);
    });

    it("a provider's sub-row metrics sum back to the model row", () => {
      const sc = aggregateScorecard(
        [
          row({ provider: 'llmgateway', delivered: true, stalls: 1 }),
          row({ provider: 'openrouter', delivered: false, blocked: true, stalls: 2 }),
        ],
        meta
      );
      const providers = sc.totals[0].providers;
      expect(providers.reduce((acc, p) => acc + p.n, 0)).toBe(sc.totals[0].n);
      expect(providers.reduce((acc, p) => acc + p.delivered, 0)).toBe(sc.totals[0].delivered);
      expect(providers.reduce((acc, p) => acc + p.stalls, 0)).toBe(sc.totals[0].stalls);
    });
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

  describe('provider sub-rows (#566 AC2)', () => {
    const row = (provider, over = {}) => ({
      repo: 'r1',
      model: 'glm-5.3',
      tier: 'mid',
      provider,
      delivered: true,
      blocked: false,
      costUsd: 3,
      inputTokens: 10,
      outputTokens: 20,
      apiMinutes: 5,
      stalls: 0,
      escalations: 0,
      unverifiedExits: 0,
      reviewFixed: null,
      reviewEscalated: null,
      ...over,
    });
    const meta = {
      windowStart: '2026-08-25',
      windowEnd: '2026-09-02',
      generatedAt: '2026-09-02T00:00:00Z',
    };

    it('names the single provider inline and emits no sub-row', () => {
      const md = renderMarkdown(aggregateScorecard([row('llmgateway')], meta));
      expect(md).toContain('| `glm-5.3` | llmgateway |');
      expect(md).not.toContain('| ↳ |');
    });

    it('emits one sub-row per provider when a model row folded more than one', () => {
      const md = renderMarkdown(
        aggregateScorecard([row('llmgateway'), row('openrouter/z-ai')], meta)
      );
      expect(md).toContain('| `glm-5.3` | 2 providers ↓ |');
      expect(md).toContain('| ↳ | llmgateway |');
      expect(md).toContain('| ↳ | openrouter/z-ai |');
    });

    it('keeps the sub-rows in the JSON sidecar so #528 can cite them', () => {
      const parsed = JSON.parse(
        renderJson(aggregateScorecard([row('llmgateway'), row('openrouter/z-ai')], meta))
      );
      expect(parsed.totals[0].providers.map((p) => p.provider)).toEqual([
        'llmgateway',
        'openrouter/z-ai',
      ]);
    });

    it('sanitizes a forged provider the same way as a forged model', () => {
      const md = renderMarkdown(
        aggregateScorecard([row('evil | 100% | $0.001'), row('llmgateway')], meta)
      );
      expect(md).toContain('| ↳ | evil \\| 100% \\| $0.001 |');
    });
  });

  it('sanitizes a model/tier value that would otherwise break out of its table cell', () => {
    const hostile = aggregateScorecard(
      [
        {
          repo: 'r1',
          model: 'evil | 100% | $0.001 (n=1',
          tier: 'sneaky`](https://phish.example',
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
      { windowStart: '2026-08-25', windowEnd: '2026-09-02', generatedAt: '2026-09-02T00:00:00Z' }
    );
    const md = renderMarkdown(hostile);
    const bucketLine = md.split('\n').find((l) => l.includes('evil'));
    expect(bucketLine).toBeDefined();
    // The forged pipes are markdown-escaped (`\|`), so a markdown renderer treats them as
    // literal text inside the cell rather than as column separators.
    expect(bucketLine).toContain('evil \\| 100% \\| $0.001 (n=1');
    // The stray backtick that would otherwise close the `${model}` code span early and
    // open a markdown link is replaced, so it can't break out of the code span.
    expect(bucketLine).not.toContain('`](https://phish.example');
  });

  it('renders "first snapshot" reconciliation text only when isFirstSnapshot is true', () => {
    const first = renderMarkdown(scorecard, { isFirstSnapshot: true });
    expect(first).toContain('First snapshot (#566)');

    const regenerated = renderMarkdown(scorecard, { isFirstSnapshot: false });
    expect(regenerated).not.toContain('First snapshot (#566)');
    expect(regenerated).toContain('regenerated snapshot');
  });

  it('renders the Agent CLI column from the bucket/total agentClis field', () => {
    const withCli = aggregateScorecard(
      [
        {
          repo: 'r1',
          model: 'sonnet',
          tier: 'mid',
          agentCli: 'claude',
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
      { windowStart: '2026-08-25', windowEnd: '2026-09-02', generatedAt: '2026-09-02T00:00:00Z' }
    );
    expect(withCli.buckets[0].agentClis).toEqual(['claude']);
    expect(withCli.totals[0].agentClis).toEqual(['claude']);
    const md = renderMarkdown(withCli);
    expect(md).toContain('Agent CLI');
    expect(md.split('\n').find((l) => l.includes('`sonnet`'))).toContain('claude');
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

  it('normalizes a routing-prefixed, opencode-alias-marked model id (AC2)', () => {
    mkdirSync(join(home, '.dossier'), { recursive: true });
    const gateComment =
      '<!-- runstate:v1 -->\nphase=gate status=done run=r-1-aaaa at=2026-08-26T00:00:00Z model=openrouter/~z-ai/glm-latest next=setup\n';
    const shipComment =
      '<!-- runstate:v1 -->\nphase=ship status=done run=r-1-aaaa at=2026-08-26T02:00:00Z next=report\n';
    const execFile = (cmd) => {
      if (cmd === 'gh') {
        return JSON.stringify([
          { number: 1, comments: [{ body: gateComment }, { body: shipComment }] },
        ]);
      }
      throw new Error(`unexpected command: ${cmd}`);
    };

    const { scorecard } = main({
      repoRoot: REPO_ROOT,
      repos: ['imboard-ai/ai-dossier'],
      dryRun: true,
      execFile,
      home,
      now: new Date('2026-09-02T00:00:00Z'),
      log: () => {},
    });

    // AC2's own example, end to end: the mid-id `~` no longer blocks the second peel, and
    // the declared `glm-latest -> glm-5.3` alias lands it on the pinned row -- while the
    // gateway that served it survives the fold as the row's provider sub-row.
    expect(scorecard.totals).toHaveLength(1);
    expect(scorecard.totals[0].model).toBe('glm-5.3');
    expect(scorecard.totals[0].providers.map((p) => p.provider)).toEqual(['openrouter/z-ai']);
  });

  it('continues with other repos when one gh call fails, and records a warning', () => {
    mkdirSync(join(home, '.dossier'), { recursive: true });
    const gateComment =
      '<!-- runstate:v1 -->\nphase=gate status=done run=r-2-bbbb at=2026-08-26T00:00:00Z model=claude-opus-5 next=setup\n';
    const shipComment =
      '<!-- runstate:v1 -->\nphase=ship status=done run=r-2-bbbb at=2026-08-26T02:00:00Z next=report\n';
    const execFile = (cmd, args) => {
      if (cmd === 'gh' && args.includes('imboard-ai/ai-dossier')) {
        throw Object.assign(new Error('gh: rate limited'), { stderr: 'rate limited' });
      }
      if (cmd === 'gh') {
        return JSON.stringify([
          { number: 2, comments: [{ body: gateComment }, { body: shipComment }] },
        ]);
      }
      throw new Error(`unexpected command: ${cmd}`);
    };

    const { scorecard } = main({
      repoRoot: REPO_ROOT,
      repos: ['imboard-ai/ai-dossier', 'imboard-ai/imboard-monorepo'],
      dryRun: true,
      execFile,
      home,
      now: new Date('2026-09-02T00:00:00Z'),
      log: () => {},
    });

    expect(scorecard.totals).toHaveLength(1);
    expect(scorecard.totals[0].model).toBe('claude-opus-5');
    expect(scorecard.warnings.some((w) => w.includes('imboard-ai/ai-dossier: skipped'))).toBe(true);
  });

  it('throws only when every repo fails', () => {
    const execFile = () => {
      throw Object.assign(new Error('gh: not found'), { stderr: 'not found' });
    };
    expect(() =>
      main({
        repoRoot: REPO_ROOT,
        repos: ['imboard-ai/ai-dossier'],
        dryRun: true,
        execFile,
        home,
        now: new Date('2026-09-02T00:00:00Z'),
        log: () => {},
      })
    ).toThrow(ScorecardError);
  });

  it('warns when ~/.dossier/runs.jsonl is absent on this host', () => {
    const gateComment =
      '<!-- runstate:v1 -->\nphase=gate status=done run=r-3-cccc at=2026-08-26T00:00:00Z model=sonnet next=setup\n';
    const execFile = () => JSON.stringify([{ number: 3, comments: [{ body: gateComment }] }]);

    const { scorecard } = main({
      repoRoot: REPO_ROOT,
      repos: ['imboard-ai/ai-dossier'],
      dryRun: true,
      execFile,
      home,
      now: new Date('2026-09-02T00:00:00Z'),
      log: () => {},
    });

    expect(scorecard.warnings.some((w) => w.includes('no local telemetry'))).toBe(true);
  });

  it('writes the digest to --digest-out when requested', () => {
    mkdirSync(join(home, '.dossier'), { recursive: true });
    const outDir = mkdtempSync(join(tmpdir(), 'model-scorecard-out-'));
    const gateComment =
      '<!-- runstate:v1 -->\nphase=gate status=done run=r-4-dddd at=2026-08-26T00:00:00Z model=sonnet next=setup\n';
    const shipComment =
      '<!-- runstate:v1 -->\nphase=ship status=done run=r-4-dddd at=2026-08-26T02:00:00Z next=report\n';
    const execFile = () =>
      JSON.stringify([{ number: 4, comments: [{ body: gateComment }, { body: shipComment }] }]);

    const digestOut = join(outDir, 'digest.txt');
    main({
      repoRoot: REPO_ROOT,
      repos: ['imboard-ai/ai-dossier'],
      outMd: join(outDir, 'scorecard.md'),
      outJson: join(outDir, 'scorecard.json'),
      digestOut,
      execFile,
      home,
      now: new Date('2026-09-02T00:00:00Z'),
      log: () => {},
    });

    const written = readFileSync(digestOut, 'utf8');
    expect(written.split('\n').filter(Boolean)).toHaveLength(6);
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe('conformance, per-issue review rate, and per-phase wall-clock (#566 AC1)', () => {
  const meta = {
    windowStart: '2026-08-25',
    windowEnd: '2026-09-02',
    generatedAt: '2026-09-02T00:00:00Z',
  };
  const trailFor = (keys) => [
    { phase: 'review', keys },
    // A later non-review milestone must not shadow the review one.
    { phase: 'ship', keys: {} },
  ];

  const joined = (milestones, runOverrides = {}) =>
    joinRepoRows({
      repo: 'o/r',
      trails: [{ issue: 1, milestones }],
      statsReport: { runs: [run('sonnet', runOverrides)] },
      schedCost: { issues: [] },
      dispatchInfo: new Map(),
      canonicalModelFn,
      providerOfFn,
    })[0];

  it('joins ac_met/ac_total off the review milestone', () => {
    const row = joined(trailFor({ ac_met: '4', ac_total: '5', fixed: '19', escalated: '1' }));
    expect(row.acMet).toBe(4);
    expect(row.acTotal).toBe(5);
  });

  it('reads a batch-review milestone too — an anchor is conformance-checked per member', () => {
    const row = joined([{ phase: 'batch-review', keys: { ac_met: '9', ac_total: '12' } }]);
    expect([row.acMet, row.acTotal]).toEqual([9, 12]);
  });

  it('drops a half-recorded verdict rather than reporting a rate it cannot compute', () => {
    expect(joined(trailFor({ ac_met: '4' })).acTotal).toBeNull();
    expect(joined(trailFor({ ac_total: '5' })).acMet).toBeNull();
    // ac_total=0 would divide by zero and is not a conformance verdict either.
    expect(joined(trailFor({ ac_met: '0', ac_total: '0' })).acMet).toBeNull();
  });

  it('weights the conformance rate by criteria, not by run', () => {
    const rows = [
      { ...joined(trailFor({ ac_met: '1', ac_total: '8' })), model: 'sonnet' },
      { ...joined(trailFor({ ac_met: '1', ac_total: '1' })), model: 'sonnet' },
    ];
    const sc = aggregateScorecard(rows, meta);
    // 2 of 9 criteria, not the 56% an average-of-averages would report.
    expect(sc.totals[0].conformanceRate).toBeCloseTo(2 / 9);
    expect(sc.totals[0].conformanceSamples).toBe(2);
  });

  it('reports review findings per issue, not as a bucket sum', () => {
    const rows = [
      { ...joined(trailFor({ fixed: '10' })), model: 'sonnet' },
      { ...joined(trailFor({ fixed: '2' })), model: 'sonnet' },
    ];
    const sc = aggregateScorecard(rows, meta);
    expect(sc.totals[0].reviewFixed).toBe(12);
    expect(sc.totals[0].reviewFixedPerIssue).toBe(6);
  });

  it('derives per-phase wall-clock medians from the trail spans', () => {
    const rows = [
      {
        ...joined([], {
          phases: [
            { phase: 'implement', seconds: 100 },
            { phase: 'review', seconds: 50 },
            // A phase can repeat within a run (ship posts twice, a resume re-runs earlier
            // phases) — the spans sum rather than last-write-wins.
            { phase: 'implement', seconds: 40 },
            // Clock skew produces negatives upstream; they are not a duration.
            { phase: 'ship', seconds: -5 },
          ],
        }),
        model: 'sonnet',
      },
    ];
    const sc = aggregateScorecard(rows, meta);
    expect(sc.phases).toEqual([
      { phase: 'implement', n: 1, medianSeconds: 140 },
      { phase: 'review', n: 1, medianSeconds: 50 },
    ]);
    expect(renderMarkdown(sc)).toContain('## Wall-clock per phase');
  });

  it('counts billable tokens only from rows carrying both halves', () => {
    const base = { ...joined([]), model: 'sonnet', delivered: true };
    const sc = aggregateScorecard(
      [
        { ...base, inputTokens: 100, outputTokens: 50 },
        // Half-recorded: previously contributed a silent 0 to the output average.
        { ...base, inputTokens: 900, outputTokens: null },
      ],
      meta
    );
    expect(sc.totals[0].billableTokensPerDeliveredIssue).toBe(150);
    expect(sc.totals[0].tokenSamples).toBe(1);
  });
});

describe('attachDeliveryRateDeltas (#566 AC1 — 7-day regressions where known)', () => {
  const meta = {
    windowStart: '2026-08-25',
    windowEnd: '2026-09-02',
    generatedAt: '2026-09-02T00:00:00Z',
  };
  const rowFor = (model, delivered) => ({
    repo: 'o/r',
    model,
    tier: 'mid',
    provider: null,
    delivered,
    blocked: !delivered,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    apiMinutes: null,
    wallClockMinutes: null,
    phaseSeconds: {},
    stalls: 0,
    escalations: 0,
    unverifiedExits: 0,
    reviewFixed: null,
    reviewEscalated: null,
    acMet: null,
    acTotal: null,
  });

  it('records the change against the previous snapshot and renders it', () => {
    const sc = aggregateScorecard([rowFor('glm-5.3', true), rowFor('glm-5.3', false)], meta);
    const previous = { windowEnd: '2026-08-26', totals: [{ model: 'glm-5.3', deliveryRate: 1 }] };
    attachDeliveryRateDeltas(sc, previous);
    expect(sc.totals[0].deliveryRateDelta).toBeCloseTo(-0.5);
    expect(renderMarkdown(sc)).toContain('-50pt');
  });

  it('attaches nothing when there is no comparable prior snapshot', () => {
    const sc = aggregateScorecard([rowFor('glm-5.3', true)], meta);
    attachDeliveryRateDeltas(sc, null);
    attachDeliveryRateDeltas(sc, { totals: 'not-an-array' });
    attachDeliveryRateDeltas(sc, { totals: [{ model: 'other', deliveryRate: 1 }] });
    expect(sc.totals[0].deliveryRateDelta).toBeUndefined();
    expect(renderMarkdown(sc)).toContain('| — |');
  });
});

describe('parseArgs', () => {
  it('defaults to the shared 30-day window', () => {
    expect(parseArgs([]).days).toBe(30);
  });

  it('rejects a flag whose value is missing instead of failing much later', () => {
    // `--days` with no operand used to reach Date.toISOString and die with a bare RangeError.
    expect(() => parseArgs(['--days'])).toThrow(ScorecardError);
    expect(() => parseArgs(['--days', '--dry-run'])).toThrow(/--days needs a value/);
    expect(() => parseArgs(['--repos'])).toThrow(ScorecardError);
  });

  it('rejects a non-positive or non-numeric window', () => {
    expect(() => parseArgs(['--days', 'abc'])).toThrow(/--days must be a positive number/);
    expect(() => parseArgs(['--days', '0'])).toThrow(/--days must be a positive number/);
  });

  it('rejects a --since that is not a date', () => {
    // An unvalidated value went straight into `updated:>=…` and produced an empty report.
    expect(() => parseArgs(['--since', 'notadate'])).toThrow(/--since must be YYYY-MM-DD/);
    expect(parseArgs(['--since', '2026-08-25']).since).toBe('2026-08-25');
  });

  it('rejects an empty --repos list rather than scoring nothing', () => {
    expect(() => parseArgs(['--repos', ' , '])).toThrow(/at least one owner\/name/);
  });
});

describe('renderDigest — best model per repo (#566 AC4)', () => {
  const meta = {
    windowStart: '2026-08-25',
    windowEnd: '2026-09-02',
    generatedAt: '2026-09-02T00:00:00Z',
  };
  const row = (repo, model, over = {}) => ({
    repo,
    model,
    tier: 'mid',
    provider: null,
    delivered: true,
    blocked: false,
    costUsd: 5,
    inputTokens: null,
    outputTokens: null,
    apiMinutes: 30,
    wallClockMinutes: null,
    phaseSeconds: {},
    stalls: 0,
    escalations: 0,
    unverifiedExits: 0,
    reviewFixed: null,
    reviewEscalated: null,
    acMet: null,
    acTotal: null,
    ...over,
  });

  const sc = aggregateScorecard(
    [
      row('imboard-ai/ai-dossier', 'glm-5.3', { costUsd: 2, apiMinutes: 40 }),
      row('imboard-ai/ai-dossier', 'sonnet', { costUsd: 9, apiMinutes: 10 }),
      row('imboard-ai/monorepo', 'glm-5.3', { costUsd: 8, apiMinutes: 15 }),
      row('imboard-ai/monorepo', 'sonnet', { costUsd: 3, apiMinutes: 50 }),
    ],
    meta
  );

  it("names each repo's own winner per dimension, still in six lines", () => {
    const lines = renderDigest(sc, null).split('\n');
    expect(lines).toHaveLength(6);
    // Cheapest differs by repo — a repo-folded ranking would report only one of these.
    expect(lines[1]).toContain('ai-dossier glm-5.3');
    expect(lines[1]).toContain('monorepo sonnet');
    // Fastest is the other way round, so the two lines cannot both be a global winner.
    expect(lines[3]).toContain('ai-dossier sonnet');
    expect(lines[3]).toContain('monorepo glm-5.3');
  });

  it('stays six lines when a repo has no measurable data at all', () => {
    const sparse = aggregateScorecard(
      [row('o/a', 'sonnet', { costUsd: null, apiMinutes: null, delivered: false, blocked: true })],
      meta
    );
    expect(renderDigest(sparse, null).split('\n')).toHaveLength(6);
  });

  it('states the configured drop threshold rather than a hardcoded 10', () => {
    expect(renderDigest(sc, null)).toContain('drop >10pt: none');
  });

  it('surfaces the data-warning count on the link line', () => {
    sc.warnings = ['a', 'b'];
    const lines = renderDigest(sc, null).split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain('2 data warning(s)');
    sc.warnings = [];
  });
});

describe('renderMarkdown — warnings are untrusted text', () => {
  const meta = {
    windowStart: '2026-08-25',
    windowEnd: '2026-09-02',
    generatedAt: '2026-09-02T00:00:00Z',
  };

  it('neutralises a markdown link and control characters in a data warning', () => {
    // Warning text embeds `model=` values read off a PUBLIC repo's issue comments, and this
    // report is committed — an unescaped link would render as live in the shipped file.
    const sc = aggregateScorecard([], meta);
    sc.warnings = ['o/r: [click here](https://evil.example)\u001b[31m-latest is a moving tag'];
    const md = renderMarkdown(sc);
    expect(md).not.toContain('[click here](');
    expect(md).not.toContain('\u001b');
    expect(md).toContain('&#91;click here&#93;');
  });

  it('caps a warning long enough to bury the rest of the report', () => {
    const sc = aggregateScorecard([], meta);
    sc.warnings = [`o/r: ${'x'.repeat(5000)}`];
    const line = renderMarkdown(sc)
      .split('\n')
      .find((l) => l.startsWith('- o/r:'));
    expect(line.length).toBeLessThan(320);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('main — guards against writing a snapshot that is not evidence', () => {
  let home;
  let outDir;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'model-scorecard-home-'));
    outDir = mkdtempSync(join(tmpdir(), 'model-scorecard-out-'));
    mkdirSync(join(home, '.dossier'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  const emptyGh = () => JSON.stringify([]);
  const opts = (over = {}) => ({
    repoRoot: REPO_ROOT,
    repos: ['imboard-ai/ai-dossier'],
    execFile: emptyGh,
    home,
    now: new Date('2026-09-02T00:00:00Z'),
    log: () => {},
    outMd: join(outDir, 'model-scorecard.md'),
    outJson: join(outDir, 'model-scorecard.json'),
    ...over,
  });

  it('refuses to replace an existing snapshot with a zero-row one', () => {
    // `gh` exits 0 with zero issues on a search outage or a token that lost `repo` scope;
    // without this the weekly cron would commit the emptied report as that week's data.
    writeFileSync(join(outDir, 'model-scorecard.json'), JSON.stringify({ totals: [] }));
    expect(() => main(opts())).toThrow(/refusing to overwrite the existing snapshot/);
  });

  it('still writes a zero-row first snapshot, when there is nothing to lose', () => {
    expect(() => main(opts())).not.toThrow();
  });

  it('never blocks a --dry-run inspection of the empty result', () => {
    writeFileSync(join(outDir, 'model-scorecard.json'), JSON.stringify({ totals: [] }));
    expect(() => main(opts({ dryRun: true }))).not.toThrow();
  });

  it('warns and carries on when the previous sidecar has the wrong shape', () => {
    writeFileSync(join(outDir, 'model-scorecard.json'), JSON.stringify({ nope: true }));
    const { scorecard } = main(opts({ dryRun: true }));
    expect(scorecard.warnings.some((w) => w.includes("has no 'totals' array"))).toBe(true);
  });

  it('warns and carries on when the previous sidecar is unparseable', () => {
    writeFileSync(join(outDir, 'model-scorecard.json'), '{ not json');
    const { scorecard } = main(opts({ dryRun: true }));
    expect(scorecard.warnings.some((w) => w.includes('is unreadable'))).toBe(true);
  });

  it('warns when the week-over-week baseline is older than the window', () => {
    // The script never merges its own PR, so an unmerged week silently ages the baseline
    // while the drop line still reads as week-over-week.
    writeFileSync(
      join(outDir, 'model-scorecard.json'),
      JSON.stringify({ windowEnd: '2026-06-01', totals: [] })
    );
    const { scorecard } = main(opts({ dryRun: true }));
    expect(scorecard.warnings.some((w) => w.includes('week-over-week baseline'))).toBe(true);
  });

  it('names a stale cli/dist rather than blaming the repos', () => {
    // A dist built before this script's dependencies existed is present but incomplete; the
    // missing export used to surface as "every repo failed", which points at gh, not the build.
    const staleRoot = mkdtempSync(join(tmpdir(), 'model-scorecard-stale-'));
    mkdirSync(join(staleRoot, 'cli', 'dist'), { recursive: true });
    writeFileSync(join(staleRoot, 'cli', 'dist', 'runstate.js'), 'module.exports = {};');
    expect(() => main(opts({ repoRoot: staleRoot }))).toThrow(/does not export parseMilestones/);
    expect(() => main(opts({ repoRoot: staleRoot }))).toThrow(/make build-all/);
    rmSync(staleRoot, { recursive: true, force: true });
  });
});

describe('per-dispatch agent run logs — the third source AC1 names', () => {
  const resultLine = (over = {}) =>
    `${JSON.stringify({
      type: 'result',
      total_cost_usd: 1.5,
      duration_ms: 60_000,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
      ...over,
    })}\n`;

  describe('issueFromRunLogName', () => {
    it('reads the issue off both the solo and the batch-member naming', () => {
      expect(issueFromRunLogName('issue-526.log')).toBe(526);
      expect(issueFromRunLogName('batch-b-20260901-02-m2-542.log')).toBe(542);
    });

    it('ignores a file it cannot attribute to an issue', () => {
      expect(issueFromRunLogName('notes.txt')).toBeNull();
      expect(issueFromRunLogName('issue-.log')).toBeNull();
      expect(issueFromRunLogName('engine.log')).toBeNull();
    });
  });

  describe('aggregateAgentRunLog', () => {
    it('sums every result record — a log accumulates across redispatches', () => {
      const text =
        resultLine() + resultLine({ total_cost_usd: 2.5, duration_ms: 30_000 }) + resultLine();
      const agg = aggregateAgentRunLog(text);
      expect(agg.runs).toBe(3);
      expect(agg.total_cost_usd).toBe(5.5);
      expect(agg.duration_ms).toBe(150_000);
      expect(agg.input_tokens).toBe(30);
      expect(agg.cache_read_tokens).toBe(120);
    });

    it('ignores streamed agent events and keeps only the result record', () => {
      const text = `${JSON.stringify({ type: 'assistant', total_cost_usd: 999 })}\n${resultLine()}`;
      expect(aggregateAgentRunLog(text).total_cost_usd).toBe(1.5);
    });

    it('survives a truncated final line from a killed engine', () => {
      expect(aggregateAgentRunLog(`${resultLine()}{"type":"result","total_cost_usd":`).runs).toBe(
        1
      );
    });

    it('returns null for a log with nothing to recover', () => {
      expect(aggregateAgentRunLog('')).toBeNull();
      expect(aggregateAgentRunLog('not json at all\n')).toBeNull();
    });

    it('reports null for a field no result record carried, never a fabricated 0', () => {
      const agg = aggregateAgentRunLog(resultLine({ total_cost_usd: null, usage: {} }));
      expect(agg.total_cost_usd).toBeNull();
      expect(agg.input_tokens).toBeNull();
      expect(agg.duration_ms).toBe(60_000);
    });
  });

  describe('mergeCost', () => {
    it('keeps runs.jsonl authoritative wherever it reported a value', () => {
      const merged = mergeCost(
        { total_cost_usd: 4.173, duration_ms: 600_000, tier: 'mid' },
        { total_cost_usd: 99, duration_ms: 1 }
      );
      // The #540/#542 reconciliation depends on this: a recovered figure must not move a
      // number that runs.jsonl already attributed.
      expect(merged.total_cost_usd).toBe(4.173);
      expect(merged.costSource).toBe('runs.jsonl');
    });

    it('fills per field, not per source', () => {
      const merged = mergeCost(
        { total_cost_usd: null, duration_ms: 600_000, tier: 'strong' },
        { total_cost_usd: 58.72, input_tokens: 7 }
      );
      expect(merged.total_cost_usd).toBe(58.72);
      expect(merged.duration_ms).toBe(600_000);
      expect(merged.input_tokens).toBe(7);
      expect(merged.tier).toBe('strong');
      expect(merged.costSource).toBe('agent-log');
    });

    it('never invents a tier from the agent log — only runs.jsonl records one', () => {
      expect(mergeCost(null, { total_cost_usd: 1, tier: 'forged' }).tier).toBeNull();
    });

    it('reports no source when neither side has a cost', () => {
      expect(mergeCost({ total_cost_usd: null }, null).costSource).toBeNull();
      expect(mergeCost(null, null)).toBeNull();
    });
  });

  it('discloses how many cost figures were recovered rather than blending them in', () => {
    const row = (over) => ({
      repo: 'o/r',
      model: 'opus',
      tier: 'mid',
      provider: null,
      delivered: true,
      blocked: false,
      inputTokens: null,
      outputTokens: null,
      apiMinutes: null,
      wallClockMinutes: null,
      phaseSeconds: {},
      stalls: 0,
      escalations: 0,
      unverifiedExits: 0,
      reviewFixed: null,
      reviewEscalated: null,
      acMet: null,
      acTotal: null,
      ...over,
    });
    const sc = aggregateScorecard(
      [
        row({ costUsd: 4, costSource: 'runs.jsonl' }),
        row({ costUsd: 58, costSource: 'agent-log' }),
        row({ costUsd: null, costSource: null }),
      ],
      { windowStart: '2026-08-25', windowEnd: '2026-09-02', generatedAt: '2026-09-02T00:00:00Z' }
    );
    expect(sc.grandTotal.costSamples).toBe(2);
    expect(sc.grandTotal.costFromRunLogSamples).toBe(1);
    expect(renderMarkdown(sc)).toContain('1 were');
  });
});
