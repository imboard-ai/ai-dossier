import { describe, expect, it } from 'vitest';
import { normalizePoolFileConfig, remoteForBaseRef } from '../pool-state';
import { DEFAULT_BASE_REF } from '../types';

describe('normalizePoolFileConfig', () => {
  it('defaults base_ref and leaves optional keys unset', () => {
    const cfg = normalizePoolFileConfig({});
    expect(cfg).toEqual({ base_ref: DEFAULT_BASE_REF });
  });

  it('defaults for non-object input', () => {
    expect(normalizePoolFileConfig(null).base_ref).toBe(DEFAULT_BASE_REF);
    expect(normalizePoolFileConfig('nope').base_ref).toBe(DEFAULT_BASE_REF);
    expect(normalizePoolFileConfig(undefined).base_ref).toBe(DEFAULT_BASE_REF);
  });

  it('reads all supported keys', () => {
    const cfg = normalizePoolFileConfig({
      pool_dir: '../worktrees',
      project_subdir: 'main',
      warm_commands: [
        ['pnpm', 'install'],
        ['pnpm', 'run', 'build'],
      ],
      base_ref: 'upstream/develop',
    });
    expect(cfg).toEqual({
      pool_dir: '../worktrees',
      project_subdir: 'main',
      warm_commands: [
        ['pnpm', 'install'],
        ['pnpm', 'run', 'build'],
      ],
      base_ref: 'upstream/develop',
    });
  });

  it('normalizes project_subdir', () => {
    expect(normalizePoolFileConfig({ project_subdir: './main/' }).project_subdir).toBe('main');
    expect(normalizePoolFileConfig({ project_subdir: '  apps/web  ' }).project_subdir).toBe(
      'apps/web'
    );
    expect(normalizePoolFileConfig({ project_subdir: '.' }).project_subdir).toBeUndefined();
    expect(normalizePoolFileConfig({ project_subdir: '' }).project_subdir).toBeUndefined();
  });

  it('drops malformed warm_commands entries', () => {
    const cfg = normalizePoolFileConfig({
      warm_commands: [['npm', 'ci'], [], ['ok'], 'nope', [1, 2]],
    });
    expect(cfg.warm_commands).toEqual([['npm', 'ci'], ['ok']]);
  });

  it('drops warm_commands entirely when nothing valid remains', () => {
    expect(normalizePoolFileConfig({ warm_commands: [] }).warm_commands).toBeUndefined();
    expect(normalizePoolFileConfig({ warm_commands: 'npm ci' }).warm_commands).toBeUndefined();
  });

  it('ignores non-string or blank scalars', () => {
    const cfg = normalizePoolFileConfig({ pool_dir: 42, base_ref: '   ', project_subdir: 7 });
    expect(cfg).toEqual({ base_ref: DEFAULT_BASE_REF });
  });

  it('does not share array references with the raw input', () => {
    const raw = { warm_commands: [['npm', 'ci']] };
    const cfg = normalizePoolFileConfig(raw);
    cfg.warm_commands?.[0].push('--force');
    expect(raw.warm_commands[0]).toEqual(['npm', 'ci']);
  });
});

describe('remoteForBaseRef', () => {
  it('extracts the remote from a remote-tracking ref', () => {
    expect(remoteForBaseRef('origin/main')).toBe('origin');
    expect(remoteForBaseRef('upstream/develop')).toBe('upstream');
    expect(remoteForBaseRef('origin/release/2.0')).toBe('origin');
  });

  it('falls back to origin for a bare ref', () => {
    expect(remoteForBaseRef('main')).toBe('origin');
    expect(remoteForBaseRef('/weird')).toBe('origin');
  });
});
