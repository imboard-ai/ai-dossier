import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gitLastmod, shallowBoundaries } from './lastmod.mjs';

// Git versions differ in how %cI renders UTC (`Z` vs `+00:00`); compare instants.
const instant = (iso) => (iso ? new Date(iso).toISOString().replace('.000', '') : iso);
const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

function commit(cwd, file, date) {
  writeFileSync(path.join(cwd, file), `${file} ${date}\n`);
  run(cwd, 'add', '-A');
  execFileSync('git', ['commit', '-m', `touch ${file}`], {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

// old.md last changed in the first commit, mid.md and new.md inside a depth-2 window.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'lastmod-'));
  const full = path.join(root, 'full');
  mkdirSync(full);
  run(full, 'init', '-q');
  commit(full, 'old.md', '2026-01-01T00:00:00Z');
  commit(full, 'mid.md', '2026-02-01T00:00:00Z');
  commit(full, 'new.md', '2026-03-01T00:00:00Z');
  const shallow = path.join(root, 'shallow');
  run(root, 'clone', '-q', '--depth', '2', `file://${full}`, shallow);
  return { root, full, shallow };
}

test('full clone keeps every real date and has no boundaries', () => {
  const { root, full } = fixture();
  try {
    assert.equal(shallowBoundaries(full).size, 0);
    assert.equal(instant(gitLastmod('old.md', full)), '2026-01-01T00:00:00Z');
    assert.equal(instant(gitLastmod('new.md', full)), '2026-03-01T00:00:00Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shallow clone: files last changed at the boundary have no lastmod', () => {
  const { root, shallow } = fixture();
  try {
    assert.equal(shallowBoundaries(shallow).size, 1);
    // mid.md was introduced by the boundary commit, so its date is the clone's, not the file's.
    assert.equal(gitLastmod('old.md', shallow), undefined);
    assert.equal(gitLastmod('mid.md', shallow), undefined);
    // new.md changed inside the window and keeps its true date.
    assert.equal(instant(gitLastmod('new.md', shallow)), '2026-03-01T00:00:00Z');
    assert.equal(gitLastmod('missing.md', shallow), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a git repository the result is undefined', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lastmod-nogit-'));
  try {
    assert.equal(gitLastmod('x.md', dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
