// ai-dossier#1259 — the once-per-tree ci-parity gate embedded in the
// implement-issue and ship-issue dossiers (examples/git mirror).
//
// The helper is shell text inside a dossier, so the dossier itself is the
// source under test: this file extracts the `cat > "$GATE" <<'GATE_EOF'`
// heredoc body from each mirror, asserts both copies are byte-identical, and
// drives it against a throwaway git repo whose scripts/ci-parity.sh only
// counts how often it ran. The safe-default contract: a skip happens ONLY on
// a clean worktree whose HEAD^{tree} equals a recorded passing tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const EXAMPLES = join(__dirname, '..', 'examples', 'git');

function extractHelper(file) {
  const text = readFileSync(join(EXAMPLES, file), 'utf-8');
  const match = text.match(/cat > "\$GATE" <<'GATE_EOF'\n([\s\S]*?)\nGATE_EOF\n/);
  if (!match) throw new Error(`no GATE_EOF helper in ${file}`);
  return `${match[1]}\n`;
}

const HELPER = extractHelper('ship-issue.ds.md');

describe('ci-parity once-per-tree gate helper (#1259)', () => {
  let repo;
  let counter;
  let helperPath;

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
  const runs = () => readFileSync(counter, 'utf-8').length;
  const gate = (...args) => {
    const r = spawnSync('bash', [helperPath, ...args], {
      cwd: repo,
      encoding: 'utf-8',
      env: { ...process.env, GATE_COUNTER: counter },
    });
    return { code: r.status, out: r.stdout.trim() };
  };
  const commit = (file, body) => {
    writeFileSync(join(repo, file), body);
    git('add', '-A');
    git('commit', '-q', '-m', `edit ${file}`);
  };
  const setParity = (script) => {
    writeFileSync(join(repo, 'scripts', 'ci-parity.sh'), script);
    git('add', '-A');
    git('commit', '-q', '-m', 'ci-parity');
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gate-tree-'));
    counter = join(mkdtempSync(join(tmpdir(), 'gate-count-')), 'runs');
    writeFileSync(counter, '');
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    execFileSync('mkdir', ['-p', join(repo, 'scripts')]);
    setParity('#!/usr/bin/env bash\nprintf x >> "$GATE_COUNTER"\nexit 0\n');
    commit('a.txt', 'one\n');
    helperPath = git('rev-parse', '--path-format=absolute', '--git-path', 'ci-parity-gate.sh');
    writeFileSync(helperPath, HELPER);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('implement-issue and ship-issue embed a byte-identical helper', () => {
    expect(extractHelper('implement-issue.ds.md')).toBe(HELPER);
  });

  it('(a) unchanged tree after a passing run -> skip with ci_parity=cached', () => {
    const tree = git('rev-parse', 'HEAD^{tree}');
    expect(gate('run', '-')).toEqual({ code: 0, out: `ci_parity=ran tree=${tree}` });
    expect(gate('confirm').out).toBe(`gate_tree=${tree}`);
    expect(gate('run', '-')).toEqual({ code: 0, out: `ci_parity=cached tree=${tree}` });
    expect(runs()).toBe(1);
  });

  it('(b) changed tree (review applied a fix) -> re-run', () => {
    gate('run', '-');
    const stamped = gate('confirm').out.replace('gate_tree=', '');
    commit('a.txt', 'review fix\n');
    const r = gate('run', stamped);
    expect(r.out).toBe(`ci_parity=ran tree=${git('rev-parse', 'HEAD^{tree}')}`);
    expect(runs()).toBe(2);
  });

  it('(c) dirty worktree never skips, even with a matching stamp', () => {
    gate('run', '-');
    const tree = gate('confirm').out.replace('gate_tree=', '');
    writeFileSync(join(repo, 'untracked.txt'), 'x\n');
    expect(gate('run', tree).out).toMatch(/^ci_parity=ran /);
    writeFileSync(join(repo, 'a.txt'), 'modified\n');
    expect(gate('run', tree).out).toMatch(/^ci_parity=ran /);
    expect(runs()).toBe(3);
  });

  it('(d) a stamp or runstate gate_tree from a different tree -> re-run', () => {
    const otherTree = git('rev-parse', 'HEAD~1^{tree}');
    const stampPath = git(
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'ci-parity-gate-tree'
    );
    writeFileSync(stampPath, `${otherTree}\n`);
    expect(gate('run', otherTree).out).toMatch(/^ci_parity=ran /);
    writeFileSync(stampPath, 'garbage\n');
    expect(gate('run', 'none').out).toMatch(/^ci_parity=ran /);
    expect(runs()).toBe(2);
  });

  it('resume: runstate gate_tree equal to the clean tree skips without a local stamp', () => {
    const tree = git('rev-parse', 'HEAD^{tree}');
    expect(gate('run', tree).out).toBe(`ci_parity=cached tree=${tree}`);
    expect(gate('confirm').out).toBe(`gate_tree=${tree}`);
    expect(runs()).toBe(0);
  });

  it('a failing gate never stamps, and the next run re-runs', () => {
    setParity('#!/usr/bin/env bash\nprintf x >> "$GATE_COUNTER"\nexit 3\n');
    expect(gate('run', '-')).toEqual({ code: 3, out: 'ci_parity=fail rc=3' });
    expect(gate('confirm').out).toBe('gate_tree=none');
    expect(gate('run', '-').code).toBe(3);
    expect(runs()).toBe(2);
  });

  it('implement flow: a pass on uncommitted work stamps only once committed unchanged', () => {
    writeFileSync(join(repo, 'b.txt'), 'feature\n');
    expect(gate('run', '-').out).toMatch(/^ci_parity=ran /);
    expect(git('diff', '--cached', '--name-only')).toBe(''); // throwaway index: real index untouched
    expect(gate('confirm').out).toBe('gate_tree=none'); // still dirty -> no stamp yet
    gate('run', '-');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature');
    const tree = git('rev-parse', 'HEAD^{tree}');
    expect(gate('confirm').out).toBe(`gate_tree=${tree}`);
    expect(gate('run', '-').out).toBe(`ci_parity=cached tree=${tree}`);
    expect(runs()).toBe(2);
  });

  it('an edit after the passing run (before commit) yields gate_tree=none', () => {
    writeFileSync(join(repo, 'b.txt'), 'feature\n');
    gate('run', '-');
    writeFileSync(join(repo, 'b.txt'), 'late edit\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature');
    expect(gate('confirm').out).toBe('gate_tree=none');
    expect(gate('run', '-').out).toMatch(/^ci_parity=ran /);
  });

  it('a gate that mutates the tree while running is never stamped', () => {
    setParity('#!/usr/bin/env bash\nprintf x >> "$GATE_COUNTER"\necho fixed >> a.txt\nexit 0\n');
    gate('run', '-');
    git('add', '-A');
    git('commit', '-q', '-m', 'autofix');
    expect(gate('confirm').out).toBe('gate_tree=none');
  });
});
