import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CheckUnavailableError } from './check-version-bumps.mjs';
import { decide, formatDecision, npmLookup, oneLine, parseNpmView, run } from './publish-guard.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./publish-guard.mjs', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('decide', () => {
  it('publishes a version that is not on npm', () => {
    expect(decide({ published: null, headSha: SHA_A }).action).toBe('publish');
  });

  it('skips a re-run of the commit that published the version (idempotency)', () => {
    const d = decide({ published: { gitHead: SHA_A }, headSha: SHA_A });
    expect(d).toEqual({ action: 'skip', reason: 'same-commit' });
  });

  it('skips a later commit that did not change the package release-relevant content', () => {
    const d = decide({
      published: { gitHead: SHA_A },
      headSha: SHA_B,
      diff: { files: [], pins: [] },
    });
    expect(d).toEqual({ action: 'skip', reason: 'no-release-relevant-change' });
  });

  it('reports a collision when the published commit shipped different source (#826)', () => {
    const d = decide({
      published: { gitHead: SHA_A },
      headSha: SHA_B,
      diff: { files: ['cli/src/a.ts'], pins: [] },
    });
    expect(d.action).toBe('collision');
    expect(d.files).toEqual(['cli/src/a.ts']);
  });

  it('refuses to decide without a release diff rather than defaulting to skip', () => {
    expect(() => decide({ published: { gitHead: SHA_A }, headSha: SHA_B })).toThrow(
      CheckUnavailableError
    );
  });

  it('reports a collision when only a workspace pin differs', () => {
    const d = decide({
      published: { gitHead: SHA_A },
      headSha: SHA_B,
      diff: { files: [], pins: ['@ai-dossier/sched'] },
    });
    expect(d.action).toBe('collision');
    expect(d.pins).toEqual(['@ai-dossier/sched']);
  });
});

describe('formatDecision', () => {
  it('names the package, version, both commits, the differing files and the fix', () => {
    const msg = formatDecision({
      name: '@ai-dossier/cli',
      version: '0.62.0',
      published: { gitHead: SHA_A },
      headSha: SHA_B,
      decision: { action: 'collision', files: ['cli/src/a.ts'], pins: [] },
    });
    expect(msg).toContain('@ai-dossier/cli@0.62.0 is already on npm');
    expect(msg).toContain(SHA_A.slice(0, 12));
    expect(msg).toContain(SHA_B.slice(0, 12));
    expect(msg).toContain('Differs: cli/src/a.ts');
    expect(msg).toContain('Fix: open a PR bumping @ai-dossier/cli past 0.62.0');
  });

  it('names the no-release-needed cause too, not only the two-PR race', () => {
    const msg = formatDecision({
      name: '@ai-dossier/cli',
      version: '0.62.0',
      published: { gitHead: SHA_A },
      headSha: SHA_B,
      decision: { action: 'collision', files: ['cli/src/a.ts'], pins: [] },
    });
    expect(msg).toContain('no-release-needed');
  });

  it('throws on an unknown action instead of reporting it as a collision', () => {
    expect(() =>
      formatDecision({ name: 'x', version: '1.0.0', headSha: SHA_A, decision: { action: 'nope' } })
    ).toThrow(/unknown decision action/);
  });

  it('says "re-run" for a same-commit skip', () => {
    const msg = formatDecision({
      name: '@ai-dossier/cli',
      version: '1.0.0',
      published: { gitHead: SHA_A },
      headSha: SHA_A,
      decision: { action: 'skip', reason: 'same-commit' },
    });
    expect(msg).toContain('re-run');
  });
});

describe('oneLine', () => {
  it('cannot emit a workflow command: newlines collapsed and :: broken', () => {
    const out = oneLine('boom\n::error::injected');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('::');
  });
});

describe('npmLookup — retries an unknown answer, never turns it into publish', () => {
  const quiet = { sleep: () => {}, log: () => {} };

  it('retries a registry failure and returns the later answer', () => {
    let calls = 0;
    const view = () => {
      calls += 1;
      if (calls < 3) throw new CheckUnavailableError('ETIMEDOUT');
      return { gitHead: SHA_A };
    };
    expect(npmLookup('@x/y', '1.0.0', { view, ...quiet })).toEqual({ gitHead: SHA_A });
    expect(calls).toBe(3);
  });

  it('rethrows after the last attempt instead of returning null', () => {
    let calls = 0;
    const view = () => {
      calls += 1;
      throw new CheckUnavailableError('ETIMEDOUT');
    };
    expect(() => npmLookup('@x/y', '1.0.0', { view, ...quiet })).toThrow(CheckUnavailableError);
    expect(calls).toBe(3);
  });

  it('does not retry a definite E404 answer', () => {
    let calls = 0;
    const view = () => {
      calls += 1;
      return null;
    };
    expect(npmLookup('@x/y', '1.0.0', { view, ...quiet })).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('parseNpmView — never fails open', () => {
  const spec = '@ai-dossier/cli@1.0.0';

  it('returns the gitHead of a published version', () => {
    const out = JSON.stringify({ version: '1.0.0', gitHead: SHA_A });
    expect(parseNpmView({ status: 0, stdout: out, stderr: '' }, spec)).toEqual({ gitHead: SHA_A });
  });

  it('returns null for E404 (version or package not on npm)', () => {
    const out = JSON.stringify({ error: { code: 'E404', summary: 'No match found' } });
    expect(parseNpmView({ status: 1, stdout: out, stderr: '' }, spec)).toBeNull();
  });

  it('throws on any other npm error instead of guessing publish or skip', () => {
    const out = JSON.stringify({ error: { code: 'ETIMEDOUT', summary: 'network' } });
    expect(() => parseNpmView({ status: 1, stdout: out, stderr: '' }, spec)).toThrow(
      CheckUnavailableError
    );
  });

  it('throws on a non-zero exit with no JSON answer', () => {
    expect(() => parseNpmView({ status: 1, stdout: '', stderr: 'boom' }, spec)).toThrow(
      CheckUnavailableError
    );
  });

  it('throws on unparseable output', () => {
    expect(() => parseNpmView({ status: 0, stdout: '{nope', stderr: '' }, spec)).toThrow(
      /not JSON/
    );
  });

  it('throws when the published version carries no gitHead', () => {
    const out = JSON.stringify({ version: '1.0.0' });
    expect(() => parseNpmView({ status: 0, stdout: out, stderr: '' }, spec)).toThrow(
      /no usable gitHead/
    );
  });
});

// ---------------------------------------------------------------------------
// End to end against a real git repo, replaying #820/#821: two branches cut
// from the same base both bump cli 1.0.0 -> 1.1.0 with different source. The
// first to merge publishes 1.1.0 (npm gitHead = its merge commit); the second's
// publish run must fail loudly rather than skip.
// ---------------------------------------------------------------------------

describe('run — end to end against a real git repo', () => {
  let repo;
  let outDir;
  let winner;
  let loser;
  let unrelated;
  let testOnly;

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const writeCli = (version, src) => {
    mkdirSync(join(repo, 'cli/src'), { recursive: true });
    writeFileSync(
      join(repo, 'cli/package.json'),
      `${JSON.stringify({ name: '@fixture/cli', version }, null, 2)}\n`
    );
    if (src !== undefined) writeFileSync(join(repo, 'cli/src/index.js'), src);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };

  let outCount = 0;
  const guard = ({ head, lookup, extra = ['--defer-collision'] }) => {
    outCount += 1;
    const outputFile = join(outDir, `out-${outCount}`);
    const lines = [];
    const code = run(['--repo-root', repo, '--dir', 'cli', '--head', head, ...extra], {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
      lookup,
      outputFile,
    });
    const outputs = existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '';
    return { code, out: lines.join('\n'), outputs };
  };
  const publishedAt = (gitHead) => () => ({ gitHead });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'publish-guard-'));
    outDir = mkdtempSync(join(tmpdir(), 'publish-guard-out-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(
      join(repo, 'package.json'),
      `${JSON.stringify({ name: 'root', private: true, workspaces: ['cli'] }, null, 2)}\n`
    );
    writeCli('1.0.0', 'export const a = 1;\n');
    commit('base');

    // Winner merges first and publishes 1.1.0.
    writeCli('1.1.0', 'export const a = 2;\n');
    winner = commit('winner: bump cli to 1.1.0');

    // Loser lands on top with the same version but different source — the
    // squash-merge result of a PR whose own merge-base check was green.
    writeFileSync(join(repo, 'cli/src/other.js'), 'export const loser = true;\n');
    loser = commit('loser: cli change, version still 1.1.0');

    git('checkout', '-q', winner);
    writeFileSync(join(repo, 'README.md'), 'docs\n');
    unrelated = commit('docs only');
    writeFileSync(join(repo, 'cli/src/index.test.js'), 'test\n');
    testOnly = commit('test only');
    // Leave the working tree somewhere unrelated: the guard must read the
    // package at --head, never from the checkout.
    git('checkout', '-q', '--detach', 'HEAD~3');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('reports a collision for the race loser and does not claim success silently', () => {
    const r = guard({ head: loser, lookup: publishedAt(winner) });
    expect(r.code).toBe(0); // --defer-collision: the workflow fails the job at the end
    expect(r.outputs).toContain('collision=true');
    expect(r.outputs).toContain('skip=true');
    expect(r.out).toContain('::error title=@fixture/cli@1.1.0 version collision::');
    expect(r.out).toContain('Differs: cli/src/other.js');
  });

  it('exits 1 on a collision when not deferred (direct callers cannot miss it)', () => {
    const r = guard({ head: loser, lookup: publishedAt(winner), extra: [] });
    expect(r.code).toBe(1);
    expect(r.outputs).toContain('collision=true');
  });

  it('looks up the version at --head, not the checked-out version', () => {
    let asked;
    guard({
      head: loser,
      lookup: (name, version) => {
        asked = `${name}@${version}`;
        return null;
      },
    });
    expect(asked).toBe('@fixture/cli@1.1.0');
  });

  it('skips a re-run of the winning commit without a collision (idempotent)', () => {
    const r = guard({ head: winner, lookup: publishedAt(winner) });
    expect(r.code).toBe(0);
    expect(r.outputs).toContain('skip=true');
    expect(r.outputs).toContain('collision=false');
    expect(r.out).toContain('re-run');
  });

  it('skips a later commit that changed nothing release-relevant for the package', () => {
    for (const head of [unrelated, testOnly]) {
      const r = guard({ head, lookup: publishedAt(winner) });
      expect(r.code).toBe(0);
      expect(r.outputs).toContain('skip=true');
      expect(r.outputs).toContain('collision=false');
    }
  });

  it('publishes when the exact version is not on npm', () => {
    const r = guard({ head: loser, lookup: () => null });
    expect(r.code).toBe(0);
    expect(r.outputs).toContain('skip=false');
    expect(r.outputs).toContain('collision=false');
  });

  it('exits 2 and writes no skip output when the npm lookup cannot answer', () => {
    const r = guard({
      head: loser,
      lookup: () => {
        throw new CheckUnavailableError('registry unreachable');
      },
    });
    expect(r.code).toBe(2);
    expect(r.outputs).toBe('');
    expect(r.out).toContain('::error title=publish-guard (cli) could not run::');
  });

  it('exits 2 when the published gitHead is not in the clone and cannot be fetched', () => {
    const r = guard({ head: loser, lookup: publishedAt('c'.repeat(40)) });
    expect(r.code).toBe(2);
    expect(r.outputs).toBe('');
    expect(r.out).toContain('could not be fetched');
  });

  it('runs as a real subprocess and exits 2 on a usage error', () => {
    let status = 0;
    try {
      execFileSync('node', [SCRIPT_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      status = err.status;
    }
    expect(status).toBe(2);
  });
});
