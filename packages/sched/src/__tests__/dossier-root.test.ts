import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDossierRoot, worktreesDirFor } from '../dossier-root';

const present = (dirs: string[]) => (p: string) => dirs.includes(p);

describe('findDossierRoot (#759)', () => {
  const opts = { home: '/home/u', exists: present(['/home/u/proj/.dossier', '/home/u/.dossier']) };

  it('walks up from a nested dir to the .dossier/ root', () => {
    expect(findDossierRoot('/home/u/proj/main/packages/a', opts)).toBe('/home/u/proj');
    expect(findDossierRoot('/home/u/proj', opts)).toBe('/home/u/proj');
  });

  it('never treats the home dir (~/.dossier config) as a project root', () => {
    expect(findDossierRoot('/home/u/other', opts)).toBeNull();
  });

  it('returns null at the filesystem root', () => {
    expect(findDossierRoot('/srv/x', { home: '/home/u', exists: () => false })).toBeNull();
  });

  it('worktreesDirFor falls back to the repo dir when no .dossier/ exists', () => {
    expect(worktreesDirFor('/srv/x', { home: '/home/u', exists: () => false })).toBe(
      path.join('/srv/x', 'worktrees')
    );
    expect(worktreesDirFor('/home/u/proj/main', opts)).toBe('/home/u/proj/worktrees');
  });
});
