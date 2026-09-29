/**
 * Persisted multi-host usage ledger (#782): idempotent persist/import, the
 * per-host file layout, ssh sync between two simulated hosts, and the merged
 * per-host report.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWindowReport, renderWindowReport } from '../commands/usage';
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
    host: 'hcc',
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
    expect(rowKey(row({}))).not.toBe(rowKey(row({ host: 'wls' })));
  });

  it('is idempotent and refreshes attribution in place', () => {
    const dir = tmpDir();
    const rows = [row({}), row({ ts: '2026-09-29T10:01:00.000Z' })];
    expect(persistLocal(dir, 'hcc', rows, [])).toMatchObject({ added: 2, updated: 0, total: 2 });
    expect(persistLocal(dir, 'hcc', rows, [])).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 2,
      total: 2,
    });
    const refined = [row({ issue: 7, unit: 'issue:7' })];
    expect(persistLocal(dir, 'hcc', refined, [])).toMatchObject({ added: 0, updated: 1, total: 2 });
    const stored = [...readHostFile(hostFile(dir, 'hcc')).rows.values()];
    expect(stored.find((r) => r.ts === rows[0].ts)?.issue).toBe(7);
  });

  it("never writes another host's rows into this host's file", () => {
    const dir = tmpDir();
    persistLocal(dir, 'hcc', [row({}), row({ host: 'wls' })], []);
    expect(listHosts(dir)).toEqual(['hcc']);
    expect(readHostFile(hostFile(dir, 'hcc')).rows.size).toBe(1);
  });
});

describe('bundle export / import', () => {
  const limit: LimitEvent = {
    ts: '2026-09-29T10:05:00.000Z',
    host: 'wls',
    source: 'sched',
    provider: null,
    session_id: null,
    unit: null,
    status: 429,
    detail: 'wall',
  };

  it('merges idempotently, one file per source host, ignoring its own host', () => {
    const wls = tmpDir();
    persistLocal(
      wls,
      'wls',
      [row({ host: 'wls' }), row({ host: 'wls', ts: '2026-09-29T10:02:00.000Z' })],
      [limit]
    );
    const bundle = buildBundle(wls, 'wls', null, 0);

    const hcc = tmpDir();
    persistLocal(hcc, 'hcc', [row({})], []);
    const first = importBundle(hcc, bundle.text, 'hcc');
    expect(first).toMatchObject({ added: 3, updated: 0, unchanged: 0, hosts: ['wls'] });
    const again = importBundle(hcc, bundle.text, 'hcc');
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 3 });
    expect(listHosts(hcc)).toEqual(['hcc', 'wls']);
    expect(readHostFile(hostFile(hcc, 'wls')).rows.size).toBe(2);
    expect(readHostFile(hostFile(hcc, 'wls')).limits.size).toBe(1);

    // A bundle echoing hcc's own rows back is ignored: local files come only from local collection.
    const echo = buildBundle(hcc, 'hcc', null, 0);
    expect(importBundle(hcc, echo.text, 'hcc')).toMatchObject({ added: 0, ignored_local: 1 });
  });

  it('skips malformed / hostile records and rejects a newer bundle version', () => {
    const dir = tmpDir();
    const text = [
      JSON.stringify({ k: 'header', version: 1, host: 'x', exported_at: 'now' }),
      'garbage',
      JSON.stringify({ k: 'row', key: 'k', row: row({ host: '../../etc' }) }),
      JSON.stringify({ k: 'row', key: 'k', row: { ...row({ host: 'wls' }), input: 'NaN' } }),
      JSON.stringify({ k: 'row', key: 'k', row: row({ host: 'wls' }) }),
    ].join('\n');
    const r = importBundle(dir, text, 'hcc');
    expect(r).toMatchObject({ added: 1, skipped: 3, hosts: ['wls'] });
    expect(fs.existsSync(path.join(dir, 'hosts', '..', '..', 'etc'))).toBe(false);
    expect(() =>
      importBundle(
        dir,
        JSON.stringify({ k: 'header', version: 99, host: 'x', exported_at: '' }),
        'hcc'
      )
    ).toThrow(/newer/);
  });

  it('--since limits the exported rows', () => {
    const dir = tmpDir();
    persistLocal(dir, 'hcc', [row({}), row({ ts: '2026-09-29T11:00:00.000Z' })], []);
    expect(buildBundle(dir, 'hcc', ['hcc'], Date.parse('2026-09-29T10:30:00Z')).rows).toBe(1);
  });
});

describe('syncWithRemotes (fake ssh between simulated hosts)', () => {
  it('one run from wls leaves every host with every host, and re-running changes nothing', () => {
    const dirs: Record<string, string> = { wls: tmpDir(), hcc: tmpDir(), hcc2: tmpDir() };
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
    const opts = { hosts: ['hcc', 'hcc2'], sinceMs: 0 };
    const deps = { dir: dirs.wls, host: 'wls', nowMs: NOW, ssh };
    const first = syncWithRemotes(opts, deps);
    expect(first.every((r) => r.ok)).toBe(true);
    for (const h of Object.keys(dirs)) expect(listHosts(dirs[h])).toEqual(['hcc', 'hcc2', 'wls']);
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

  it('reports an unreachable host without throwing and does not advance its cursor', () => {
    const dir = tmpDir();
    const ssh: SshRunner = () => ({ status: 255, stdout: '', stderr: 'ssh: connect timed out' });
    const [r] = syncWithRemotes({ hosts: ['hcc2'] }, { dir, host: 'wls', nowMs: NOW, ssh });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out');
    expect(fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf-8')).not.toContain('hcc2');
    expect(syncWithRemotes({ hosts: ['bad host;rm'] }, { dir, host: 'wls', ssh })[0].error).toBe(
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
        host: 'hcc',
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
      'wls',
      [row({ host: 'wls', session_id: 'sess-wls-1', ts: '2026-09-29T11:00:00.000Z' })],
      []
    );
    const deps = { ...paths, storeDir: dir };
    const opts = { last: '5h', until: '2026-09-29T12:00:00Z' };

    const localOnly = buildWindowReport(opts, deps);
    expect(localOnly.by_host.map((h) => h.key)).toEqual(['hcc']);
    expect(localOnly.totals.messages).toBe(2);

    const all = buildWindowReport({ ...opts, hosts: 'all' }, deps);
    expect(all.hosts).toEqual(['hcc', 'wls']);
    expect(Object.fromEntries(all.by_host.map((h) => [h.key, h.messages]))).toEqual({
      hcc: 2,
      wls: 1,
    });
    expect(all.totals.messages).toBe(3);
    expect(renderWindowReport(all)).toContain('By host:');

    const onlyWls = buildWindowReport({ ...opts, hosts: 'wls' }, deps);
    expect(onlyWls.totals.messages).toBe(1);

    // The transcript rotates away; the persisted rows still report.
    fs.rmSync(path.dirname(paths.paths?.claudeProjectsDir ?? ''), { recursive: true, force: true });
    expect(buildWindowReport({ ...opts, hosts: 'local' }, deps).totals.messages).toBe(2);
  });

  it('mergedView prefers the fresh collection per key', () => {
    const dir = tmpDir();
    persistLocal(dir, 'hcc', [row({})], []);
    const fresh = { rows: [row({ issue: 3, unit: 'issue:3' })], limits: [] };
    const view = mergedView(dir, 'hcc', fresh, null, 0, NOW);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].issue).toBe(3);
  });
});
