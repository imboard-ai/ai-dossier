import { describe, expect, it } from 'vitest';
import { type ExecFn, resolveProjectSlug, schedStateDir } from '../index';

describe('resolveProjectSlug (fleet-cycle convention)', () => {
  it('uses gh repo view owner-name when available', () => {
    const exec: ExecFn = (file) => {
      if (file === 'gh') {
        return JSON.stringify({ owner: { login: 'imboard-ai' }, name: 'ai-dossier' });
      }
      return null;
    };
    expect(resolveProjectSlug(exec)).toBe('imboard-ai-ai-dossier');
  });

  it('falls back to the git toplevel basename when gh fails', () => {
    const exec: ExecFn = (file, args) => {
      if (file === 'gh') return null;
      if (file === 'git' && args.includes('--show-toplevel')) {
        return '/home/yuvaldim/projects/ai-dossier';
      }
      return null;
    };
    expect(resolveProjectSlug(exec)).toBe('ai-dossier');
  });

  it('falls back to "default" when both fail, and sanitizes unsafe characters', () => {
    expect(resolveProjectSlug(() => null)).toBe('default');
    const weird: ExecFn = (file) =>
      file === 'gh' ? JSON.stringify({ owner: { login: 'a/b' }, name: 'c d' }) : null;
    expect(resolveProjectSlug(weird)).toBe('a-b-c-d');
  });

  it('ignores gh output that is not the expected JSON shape', () => {
    const exec: ExecFn = (file) => (file === 'gh' ? 'not json' : null);
    expect(resolveProjectSlug(exec)).toBe('default');
  });
});

describe('schedStateDir', () => {
  it('nests the project under ~/.dossier/sched with sanitized slugs', () => {
    expect(schedStateDir('imboard-ai-ai-dossier', '/home/tester')).toBe(
      '/home/tester/.dossier/sched/imboard-ai-ai-dossier'
    );
    expect(schedStateDir('a/b', '/home/tester')).toBe('/home/tester/.dossier/sched/a-b');
  });
});
