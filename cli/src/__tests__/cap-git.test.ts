import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureGitState } from '../cap-git';
import { type CapLogEntry, findLastOk } from '../cap-log';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('captureGitState / findLastOk (#941)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-git-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('omits git state outside a work tree', () => {
    expect(captureGitState(dir)).toBeNull();
  });

  it('reports head, tree and dirty inside a work tree', () => {
    git(dir, 'init', '-q');
    git(
      dir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i'
    );
    const clean = captureGitState(dir);
    expect(clean).toEqual({
      git_head: git(dir, 'rev-parse', 'HEAD'),
      git_tree: git(dir, 'rev-parse', 'HEAD^{tree}'),
      dirty: false,
    });
    fs.writeFileSync(path.join(dir, 'x'), 'y');
    expect(captureGitState(dir)?.dirty).toBe(true);
  });

  it('last-ok returns the latest clean ok row for the tree, never a dirty one', () => {
    const file = path.join(dir, 'caps.jsonl');
    const row = (o: Partial<CapLogEntry>): CapLogEntry => ({
      timestamp: 't',
      capability: 'gate.batch',
      outcome: 'ok',
      exit_code: 0,
      duration_ms: 1,
      reason: null,
      signal: null,
      cwd: '/x',
      git_tree: 'T1',
      dirty: false,
      ...o,
    });
    const rows = [
      row({ timestamp: 'a' }),
      row({ timestamp: 'b' }),
      row({ timestamp: 'c', dirty: true }),
      row({ timestamp: 'd', outcome: 'task-failed' }),
      row({ timestamp: 'e', git_tree: 'T2' }),
    ];
    fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\ngarbage\n`);
    expect(findLastOk('gate.batch', 'T1', file)?.timestamp).toBe('b');
    expect(findLastOk('gate.batch', 'T3', file)).toBeNull();
    expect(findLastOk('other', 'T1', file)).toBeNull();
    fs.writeFileSync(file, `${JSON.stringify(row({ dirty: true }))}\n`);
    expect(findLastOk('gate.batch', 'T1', file)).toBeNull();
    expect(findLastOk('gate.batch', 'T1', path.join(dir, 'missing'))).toBeNull();
  });
});
