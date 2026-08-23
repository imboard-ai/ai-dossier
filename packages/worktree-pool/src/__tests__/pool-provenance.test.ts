import { describe, expect, it } from 'vitest';
import {
  classifyPoolDirEntry,
  isPoolDirName,
  isPoolTempBranch,
  type PoolDirEntryInput,
} from '../pool-state';
import type { PoolWorktree } from '../types';
import { createWorktree } from './helpers/setup';

function input(overrides: Partial<PoolDirEntryInput> = {}): PoolDirEntryInput {
  return {
    name: 'pool-1750000000000-4242',
    branch: 'pool/spare-pool-1750000000000-4242',
    registered: true,
    existsOnDisk: true,
    stateEntry: null,
    ...overrides,
  };
}

describe('isPoolDirName', () => {
  it('accepts the pool-<timestamp>-<pid> shape', () => {
    expect(isPoolDirName('pool-1750000000000-4242')).toBe(true);
    expect(isPoolDirName('pool-1-1')).toBe(true);
  });

  it('rejects developer worktree names', () => {
    expect(isPoolDirName('2332-budget-composable-dashboard')).toBe(false);
    expect(isPoolDirName('fix-1173-playwright-start')).toBe(false);
    expect(isPoolDirName('pool-abc-def')).toBe(false);
    expect(isPoolDirName('pool-123')).toBe(false);
    expect(isPoolDirName('my-pool-123-456')).toBe(false);
    expect(isPoolDirName('pool-123-456-extra')).toBe(false);
  });
});

describe('isPoolTempBranch', () => {
  it('accepts pool/spare-* with a suffix', () => {
    expect(isPoolTempBranch('pool/spare-pool-1-2')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isPoolTempBranch('pool/spare-')).toBe(false);
    expect(isPoolTempBranch('feature/999-test')).toBe(false);
    expect(isPoolTempBranch('main')).toBe(false);
    expect(isPoolTempBranch(null)).toBe(false);
    expect(isPoolTempBranch(undefined)).toBe(false);
  });
});

describe('classifyPoolDirEntry', () => {
  it('owns a directory recorded in pool state', () => {
    const stateEntry = createWorktree({ id: 'pool-1-2', path: 'pool-1-2' });
    const result = classifyPoolDirEntry(
      input({ name: 'pool-1-2', branch: stateEntry.temp_branch, stateEntry })
    );
    expect(result).toMatchObject({ provenance: 'tracked', owned: true });
  });

  it('owns a claimed worktree still on its assigned branch', () => {
    const stateEntry: PoolWorktree = createWorktree({
      id: 'pool-1-2',
      path: 'feature-999-test',
      status: 'assigned',
      assigned_to_issue: 999,
      assigned_branch: 'feature/999-test',
    });
    const result = classifyPoolDirEntry(
      input({ name: 'feature-999-test', branch: 'feature/999-test', stateEntry })
    );
    expect(result.owned).toBe(true);
  });

  it('owns a state entry whose directory is already gone', () => {
    const stateEntry = createWorktree({ id: 'pool-1-2', path: 'pool-1-2' });
    const result = classifyPoolDirEntry(
      input({ name: 'pool-1-2', existsOnDisk: false, registered: false, stateEntry })
    );
    expect(result.owned).toBe(true);
  });

  it('disowns a state entry whose directory now holds someone else s branch', () => {
    const stateEntry = createWorktree({ id: 'pool-1-2', path: 'pool-1-2' });
    const result = classifyPoolDirEntry(
      input({ name: 'pool-1-2', branch: 'handmade/replacement', stateEntry })
    );
    expect(result).toMatchObject({ provenance: 'foreign', owned: false });
    expect(result.reason).toContain('handmade/replacement');
  });

  it('owns an untracked directory carrying both pool marks', () => {
    const result = classifyPoolDirEntry(input());
    expect(result).toMatchObject({ provenance: 'pool-created', owned: true });
  });

  it('disowns a developer worktree sharing the pool directory', () => {
    const result = classifyPoolDirEntry(
      input({
        name: '2332-budget-composable-dashboard',
        branch: '2332-budget-composable-dashboard',
      })
    );
    expect(result).toMatchObject({ provenance: 'foreign', owned: false });
    expect(result.reason).toContain('.pool-state.json');
  });

  it('disowns a pool-shaped name that is not on a pool/spare branch', () => {
    const result = classifyPoolDirEntry(input({ branch: 'feature/handmade' }));
    expect(result).toMatchObject({ provenance: 'foreign', owned: false });
    expect(result.reason).toContain('feature/handmade');
  });

  it('disowns a pool-shaped name with a detached HEAD', () => {
    const result = classifyPoolDirEntry(input({ branch: null }));
    expect(result.owned).toBe(false);
    expect(result.reason).toContain('detached HEAD');
  });

  it('disowns a pool-shaped directory that is not a registered worktree', () => {
    const result = classifyPoolDirEntry(input({ registered: false, branch: null }));
    expect(result.owned).toBe(false);
    expect(result.reason).toContain('not a registered git worktree');
  });
});
