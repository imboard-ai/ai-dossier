/**
 * Persisted multi-host usage ledger (#782): idempotent persist/import, the
 * per-host file layout, ssh sync between two simulated hosts, and the merged
 * per-host report.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildScopeReport,
  buildWindowReport,
  registerUsageCommand,
  renderWindowReport,
  usageCommandDeps,
} from '../commands/usage';
import {
  applyPrepWindows,
  batchPrepTokens,
  prepScanRange,
  prepWindows,
  recordBatchPrep,
} from '../usage/batch-prep';
import {
  buildBundle,
  hostFile,
  importBundle,
  listHosts,
  mergedView,
  persistLocal,
  readHostFile,
  rowKey,
} from '../usage/store';
import { refreshLocal, type SshRunner, syncWithRemotes } from '../usage/sync';
import type { LimitEvent, UsageRow } from '../usage/types';
import { createTestProgram } from './helpers/test-utils';

const tmp: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-store-'));
  tmp.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function row(over: Partial<UsageRow>): UsageRow {
  return {
    ts: '2026-09-29T10:00:00.000Z',
    host: 'host-a',
    provider: 'anthropic',
    model: 'claude-x',
    input: 10,
    output: 5,
    reasoning: 0,
    cache_read: 100,
    cache_write: 20,
    cost_usd: null,
    source: 'claude-code',
    session_id: 'sess-0001',
    parent_session_id: null,
    title: null,
    cwd: null,
    project: null,
    branch: null,
    issue: null,
    issue_source: null,
    batch: null,
    unit: null,
    ...over,
  };
}

const NOW = Date.parse('2026-09-29T12:00:00Z');

describe('rowKey / persistLocal', () => {
  it('keys on the message, not on attribution', () => {
    expect(rowKey(row({}))).toBe(rowKey(row({ issue: 5, unit: 'issue:5' })));
    expect(rowKey(row({}))).not.toBe(rowKey(row({ output: 6 })));
    expect(rowKey(row({}))).not.toBe(rowKey(row({ host: 'host-c' })));
  });

  it('is idempotent and refreshes attribution in place', () => {
    const dir = tmpDir();
    const rows = [row({}), row({ ts: '2026-09-29T10:01:00.000Z' })];
    expect(persistLocal(dir, 'host-a', rows, [])).toMatchObject({ added: 2, updated: 0, total: 2 });
    expect(persistLocal(dir, 'host-a', rows, [])).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 2,
      total: 2,
    });
    const refined = [row({ issue: 7, unit: 'issue:7' })];
    expect(persistLocal(dir, 'host-a', refined, [])).toMatchObject({
      added: 0,
      updated: 1,
      total: 2,
    });
    const stored = [...readHostFile(hostFile(dir, 'host-a')).rows.values()];
    expect(stored.find((r) => r.ts === rows[0].ts)?.issue).toBe(7);
  });

  it("never writes another host's rows into this host's file", () => {
    const dir = tmpDir();
    persistLocal(dir, 'host-a', [row({}), row({ host: 'host-c' })], []);
    expect(listHosts(dir)).toEqual(['host-a']);
    expect(readHostFile(hostFile(dir, 'host-a')).rows.size).toBe(1);
  });
});

describe('bundle export / import', () => {
  const limit: LimitEvent = {
    ts: '2026-09-29T10:05:00.000Z',
    host: 'host-c',
    source: 'sched',
    provider: null,
    session_id: null,
    unit: null,
    status: 429,
    detail: 'wall',
  };

  it('merges idempotently, one file per source host, ignoring its own host', () => {
    const hostC = tmpDir();
    persistLocal(
      hostC,
      'host-c',
      [row({ host: 'host-c' }), row({ host: 'host-c', ts: '2026-09-29T10:02:00.000Z' })],
      [limit]
    );
    const bundle = buildBundle(hostC, 'host-c', null, 0);

    const hostA = tmpDir();
    persistLocal(hostA, 'host-a', [row({})], []);
    const first = importBundle(hostA, bundle.text, 'host-a');
    expect(first).toMatchObject({ added: 3, updated: 0, unchanged: 0, hosts: ['host-c'] });
    const again = importBundle(hostA, bundle.text, 'host-a');
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 3 });
    expect(listHosts(hostA)).toEqual(['host-a', 'host-c']);
    expect(readHostFile(hostFile(hostA, 'host-c')).rows.size).toBe(2);
    expect(readHostFile(hostFile(hostA, 'host-c')).limits.size).toBe(1);

    // A bundle echoing hostA's own rows back is ignored: local files come only from local collection.
    const echo = buildBundle(hostA, 'host-a', null, 0);
    expect(importBundle(hostA, echo.text, 'host-a')).toMatchObject({ added: 0, ignored_local: 1 });
  });

  it('skips malformed / hostile records and rejects a newer bundle version', () => {
    const dir = tmpDir();
    const text = [
      JSON.stringify({ k: 'header', version: 1, host: 'x', exported_at: 'now' }),
      'garbage',
      JSON.stringify({ k: 'row', key: 'k', row: row({ host: '../../etc' }) }),
      JSON.stringify({ k: 'row', key: 'k', row: { ...row({ host: 'host-c' }), input: 'NaN' } }),
      JSON.stringify({ k: 'row', key: 'k', row: row({ host: 'host-c' }) }),
    ].join('\n');
    const r = importBundle(dir, text, 'host-a');
    expect(r).toMatchObject({ added: 1, skipped: 3, hosts: ['host-c'] });
    expect(fs.existsSync(path.join(dir, 'hosts', '..', '..', 'etc'))).toBe(false);
    expect(() =>
      importBundle(
        dir,
        JSON.stringify({ k: 'header', version: 99, host: 'x', exported_at: '' }),
        'host-a'
      )
    ).toThrow(/newer/);
  });

  it('one null / scalar line neither throws nor poisons the file', () => {
    const dir = tmpDir();
    const good = JSON.stringify({ k: 'row', key: 'k', row: row({ host: 'host-c' }) });
    const r = importBundle(dir, `null\n42\n"x"\n${good}\n`, 'host-a');
    expect(r).toMatchObject({ added: 1, skipped: 3 });
    fs.appendFileSync(hostFile(dir, 'host-c'), 'null\n');
    expect(readHostFile(hostFile(dir, 'host-c')).rows.size).toBe(1);
  });

  it('a stale relay never overwrites the owner-fresher record', () => {
    const owner = tmpDir();
    const relay = tmpDir();
    persistLocal(owner, 'host-c', [row({ host: 'host-c' })], []);
    const stale = buildBundle(owner, 'host-c', null, 0).text;
    importBundle(relay, stale, 'host-a');
    // hostC refines its attribution later...
    persistLocal(owner, 'host-c', [row({ host: 'host-c', issue: 9, unit: 'issue:9' })], []);
    const fresh = buildBundle(owner, 'host-c', null, 0).text;
    const consumer = tmpDir();
    importBundle(consumer, fresh, 'host-b');
    // ...then the consumer also receives the STALE copy via a relay: it must not win.
    expect(importBundle(consumer, stale, 'host-b')).toMatchObject({ updated: 0 });
    expect([...readHostFile(hostFile(consumer, 'host-c')).rows.values()][0].issue).toBe(9);
    // And the fresher copy does replace an older one.
    expect(importBundle(relay, fresh, 'host-a')).toMatchObject({ updated: 1 });
  });

  it('--since limits the exported rows', () => {
    const dir = tmpDir();
    persistLocal(dir, 'host-a', [row({}), row({ ts: '2026-09-29T11:00:00.000Z' })], []);
    expect(buildBundle(dir, 'host-a', ['host-a'], Date.parse('2026-09-29T10:30:00Z')).rows).toBe(1);
  });
});

describe('syncWithRemotes (fake ssh between simulated hosts)', () => {
  it('one run from host-c leaves every host with every host, and re-running changes nothing', () => {
    const dirs: Record<string, string> = {
      'host-c': tmpDir(),
      'host-a': tmpDir(),
      'host-b': tmpDir(),
    };
    for (const h of Object.keys(dirs)) {
      persistLocal(dirs[h], h, [row({ host: h, session_id: `sess-${h}` })], []);
    }
    const ssh: SshRunner = (host, script, input) => {
      if (script.includes('usage export --all')) {
        return { status: 0, stdout: buildBundle(dirs[host], host, null, 0).text, stderr: '' };
      }
      if (script.includes('usage import -')) {
        const res = importBundle(dirs[host], input ?? '', host);
        return { status: 0, stdout: `${JSON.stringify(res)}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };
    const opts = { hosts: ['host-a', 'host-b'], sinceMs: 0 };
    const deps = { dir: dirs['host-c'], host: 'host-c', nowMs: NOW, ssh };
    const first = syncWithRemotes(opts, deps);
    expect(first.every((r) => r.ok)).toBe(true);
    for (const h of Object.keys(dirs))
      expect(listHosts(dirs[h])).toEqual(['host-a', 'host-b', 'host-c']);
    const second = syncWithRemotes(opts, deps);
    for (const r of second) {
      expect(r.pulled).toMatchObject({ added: 0, updated: 0 });
      expect(r.push).toMatchObject({ added: 0, updated: 0 });
    }
    for (const h of Object.keys(dirs)) {
      const rows = listHosts(dirs[h]).reduce(
        (n, x) => n + readHostFile(hostFile(dirs[h], x)).rows.size,
        0
      );
      expect(rows).toBe(3);
    }
  });

  const fleet = () => {
    const dirs: Record<string, string> = {
      'host-c': tmpDir(),
      'host-a': tmpDir(),
      'host-b': tmpDir(),
    };
    for (const h of Object.keys(dirs)) {
      persistLocal(dirs[h], h, [row({ host: h, session_id: `sess-${h}` })], []);
    }
    const down = new Set<string>();
    const ssh: SshRunner = (host, script, input) => {
      if (down.has(host)) return { status: 255, stdout: '', stderr: 'down' };
      if (script.includes('usage export --all')) {
        return { status: 0, stdout: buildBundle(dirs[host], host, null, 0).text, stderr: '' };
      }
      const res = importBundle(dirs[host], input ?? '', host);
      return { status: 0, stdout: `${JSON.stringify(res)}\n`, stderr: '' };
    };
    return { dirs, down, ssh };
  };
  const countRows = (dir: string) =>
    listHosts(dir).reduce((n, x) => n + readHostFile(hostFile(dir, x)).rows.size, 0);

  it('a host that was down in run 1 still reaches every host in run 2 (push reaches back to the pull window)', () => {
    const { dirs, down, ssh } = fleet();
    down.add('host-b');
    const deps = { dir: dirs['host-c'], host: 'host-c', nowMs: NOW, ssh };
    syncWithRemotes({ hosts: ['host-a', 'host-b'] }, deps); // cursors: hostA advances, hostB fails
    down.clear();
    // later run: hostA's cursor is recent, but host-b's rows (older than it) must still get to hostA
    syncWithRemotes({ hosts: ['host-a', 'host-b'] }, { ...deps, nowMs: NOW + 3 * 86_400_000 });
    for (const h of Object.keys(dirs)) expect(countRows(dirs[h])).toBe(3);
  });

  it('--no-pull does not advance the pull cursor', () => {
    const { dirs, ssh } = fleet();
    const deps = { dir: dirs['host-c'], host: 'host-c', nowMs: NOW, ssh };
    syncWithRemotes({ hosts: ['host-a'], pull: false }, deps);
    expect(countRows(dirs['host-c'])).toBe(1); // nothing pulled
    syncWithRemotes({ hosts: ['host-a'] }, { ...deps, nowMs: NOW + 86_400_000 });
    expect(listHosts(dirs['host-c'])).toEqual(['host-a', 'host-c']);
    const state = JSON.parse(
      fs.readFileSync(path.join(dirs['host-c'], 'sync-state.json'), 'utf-8')
    );
    expect(state.remotes['host-a'].pull).toBeTruthy();
  });

  it('reports an unreachable host without throwing and does not advance its cursor', () => {
    const dir = tmpDir();
    const ssh: SshRunner = () => ({ status: 255, stdout: '', stderr: 'ssh: connect timed out' });
    const [r] = syncWithRemotes({ hosts: ['host-b'] }, { dir, host: 'host-c', nowMs: NOW, ssh });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out');
    expect(fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf-8')).not.toContain('"host-b"');
    expect(syncWithRemotes({ hosts: ['bad host;rm'] }, { dir, host: 'host-c', ssh })[0].error).toBe(
      'invalid host name'
    );
  });
});

describe('refreshLocal + merged report', () => {
  function fixtureHome(): { paths: Parameters<typeof refreshLocal>[0]; dir: string } {
    const home = tmpDir();
    const projects = path.join(home, 'claude', 'projects', '-x');
    fs.mkdirSync(projects, { recursive: true });
    const line = (ts: string) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-local-1',
        timestamp: ts,
        cwd: '/x',
        message: {
          id: `m-${ts}`,
          model: 'claude-x',
          role: 'assistant',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
          },
        },
      });
    fs.writeFileSync(
      path.join(projects, 'sess-local-1.jsonl'),
      `${line('2026-09-29T10:00:00.000Z')}\n${line('2026-09-29T10:10:00.000Z')}\n`
    );
    return {
      dir: path.join(home, 'usage'),
      paths: {
        paths: {
          claudeProjectsDir: path.join(home, 'claude', 'projects'),
          opencodeDb: path.join(home, 'none.db'),
          schedRoot: path.join(home, 'sched'),
          runsLog: path.join(home, 'runs.jsonl'),
        },
        host: 'host-a',
        nowMs: NOW,
      },
    };
  }

  it('persists the collection once, then resumes from the cursor without duplicating', () => {
    const { dir, paths } = fixtureHome();
    const first = refreshLocal({ ...paths, dir });
    expect(first).toMatchObject({ collected: 2, added: 2, total: 2 });
    const second = refreshLocal({ ...paths, dir });
    expect(second).toMatchObject({ added: 0, total: 2 });
  });

  it('window --hosts all shows per-host rows; default stays local-only; a purged transcript survives', () => {
    const { dir, paths } = fixtureHome();
    refreshLocal({ ...paths, dir });
    persistLocal(
      dir,
      'host-c',
      [row({ host: 'host-c', session_id: 'sess-host-c-1', ts: '2026-09-29T11:00:00.000Z' })],
      []
    );
    const deps = { ...paths, storeDir: dir };
    const opts = { last: '5h', until: '2026-09-29T12:00:00Z' };

    const localOnly = buildWindowReport(opts, deps);
    expect(localOnly.by_host.map((h) => h.key)).toEqual(['host-a']);
    expect(localOnly.totals.messages).toBe(2);

    const all = buildWindowReport({ ...opts, hosts: 'all' }, deps);
    expect(all.hosts).toEqual(['host-a', 'host-c']);
    expect(Object.fromEntries(all.by_host.map((h) => [h.key, h.messages]))).toEqual({
      'host-a': 2,
      'host-c': 1,
    });
    expect(all.totals.messages).toBe(3);
    expect(renderWindowReport(all)).toContain('By host:');

    const onlyWls = buildWindowReport({ ...opts, hosts: 'host-c' }, deps);
    expect(onlyWls.totals.messages).toBe(1);

    // The transcript rotates away; the persisted rows still report.
    fs.rmSync(path.dirname(paths.paths?.claudeProjectsDir ?? ''), { recursive: true, force: true });
    expect(buildWindowReport({ ...opts, hosts: 'local' }, deps).totals.messages).toBe(2);
  });

  it('mergedView prefers the fresh collection per key', () => {
    const dir = tmpDir();
    persistLocal(dir, 'host-a', [row({})], []);
    const fresh = { rows: [row({ issue: 3, unit: 'issue:3' })], limits: [] };
    const view = mergedView(dir, 'host-a', fresh, null, 0, NOW);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].issue).toBe(3);
  });
});

describe('usage sync command wiring (fake ssh)', () => {
  it('routes --hosts / --since / --no-push to the sync engine and pulls remote rows', async () => {
    const home = tmpDir();
    const saved = { ...process.env };
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
    process.env.OPENCODE_DB = path.join(home, 'none.db');
    process.env.DOSSIER_USAGE_DIR = path.join(home, 'usage');
    process.env.DOSSIER_USAGE_HOST = 'host-c';
    const remoteDir = tmpDir();
    persistLocal(remoteDir, 'host-a', [row({ host: 'host-a', session_id: 'sess-host-a' })], []);
    const calls: string[] = [];
    usageCommandDeps.ssh = (host, script) => {
      calls.push(`${host}: ${script}`);
      return { status: 0, stdout: buildBundle(remoteDir, 'host-a', null, 0).text, stderr: '' };
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const p = createTestProgram();
      registerUsageCommand(p);
      await p.parseAsync([
        'node',
        'dossier',
        'usage',
        'sync',
        '--hosts',
        'host-a',
        '--no-push',
        '--since',
        '2026-09-01',
      ]);
      expect(calls).toHaveLength(1); // --no-push: pull only
      expect(calls[0]).toContain('host-a: ');
      expect(calls[0]).toContain("usage export --all --since '2026-09-01T00:00:00.000Z'");
      expect(listHosts(path.join(home, 'usage'))).toEqual(['host-a', 'host-c']);
      expect(log.mock.calls.flat().join('\n')).toContain(
        'host-a: pulled +1'.replace('+1', '1 new')
      );
    } finally {
      usageCommandDeps.ssh = undefined;
      log.mockRestore();
      process.env = saved;
    }
  });
});

describe('prep attribution agrees across views (#899)', () => {
  it('usage --batch and batchPrepTokens give the same per-batch split; scan range ignores other batches', () => {
    const home = tmpDir();
    const projects = path.join(home, 'claude', 'projects', '-x');
    fs.mkdirSync(projects, { recursive: true });
    const S = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const lines = Array.from({ length: 16 }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: S,
        timestamp: `2026-09-29T10:${String(i).padStart(2, '0')}:00.000Z`,
        cwd: '/x',
        message: {
          id: `m${i}`,
          model: 'claude-x',
          role: 'assistant',
          usage: {
            input_tokens: 10 + i,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
          },
        },
      })
    );
    fs.writeFileSync(path.join(projects, `${S}.jsonl`), `${lines.join('\n')}\n`);
    const schedRoot = path.join(home, 'sched');
    const schedDir = path.join(schedRoot, 'proj');
    recordBatchPrep(
      schedDir,
      ['b-1', 'b-2'],
      S,
      'env',
      new Date('2026-09-29T10:30:00Z'),
      new Map([
        ['b-1', 3],
        ['b-2', 1],
      ])
    );
    // an unrelated old batch far in the past must not widen b-1's scan
    recordBatchPrep(schedDir, ['old'], 'zzzzzzzz-old', 'env', new Date('2026-01-01T00:00:00Z'));
    const paths = {
      claudeProjectsDir: path.join(home, 'claude', 'projects'),
      opencodeDb: path.join(home, 'none.db'),
      schedRoot,
      runsLog: path.join(home, 'runs.jsonl'),
    };
    const stats = batchPrepTokens(schedDir, ['b-1', 'b-2'], paths);
    for (const b of ['b-1', 'b-2']) {
      const scope = buildScopeOf(b, paths, home);
      expect(scope).toBe(stats.get(b)?.billable_tokens);
    }
    const w = prepWindows([
      { ts: '2026-09-29T10:30:00Z', batch: 'b-1', session_id: S, source: 'env' },
      { ts: '2026-01-01T00:00:00Z', batch: 'old', session_id: 'zzzzzzzz-old', source: 'env' },
    ]);
    expect(prepScanRange(w, new Set(['b-1'])).sinceMs).toBeGreaterThan(
      Date.parse('2026-09-01T00:00:00Z')
    );
    void applyPrepWindows;
  });
});

function buildScopeOf(
  batch: string,
  paths: Parameters<typeof buildWindowReport>[1] extends infer D
    ? D extends { paths?: infer P }
      ? NonNullable<P>
      : never
    : never,
  home: string
): number {
  const dir = path.join(home, 'store');
  const report = buildScopeReport(
    { batch, since: '2026-09-01T00:00:00Z' },
    { paths, nowMs: Date.parse('2026-09-29T12:00:00Z'), storeDir: dir, host: os.hostname() }
  );
  return report.totals.total;
}
