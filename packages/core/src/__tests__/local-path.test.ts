import { describe, expect, it } from 'vitest';
import {
  containsHomePath,
  isPortablePath,
  redactHomePaths,
  resolvePortablePath,
  toPortablePath,
} from '../local-path';

const HOMES = ['/home/alice'];
const ANCHOR = '/home/alice/projects/acme/main';

describe('toPortablePath', () => {
  it('rewrites a path inside the main checkout to <repo>/<relative>', () => {
    expect(toPortablePath(`${ANCHOR}/cli/src/x.ts`, { anchor: ANCHOR, homes: HOMES })).toBe(
      '<repo>/cli/src/x.ts'
    );
    expect(toPortablePath(ANCHOR, { anchor: ANCHOR, homes: HOMES })).toBe('<repo>');
  });

  it('rewrites a sibling worktree (one level beside the checkout) to <repo>/../…', () => {
    expect(
      toPortablePath('/home/alice/projects/acme/worktrees/bug-1-x/PLANNING-1-x.md', {
        anchor: ANCHOR,
        homes: HOMES,
      })
    ).toBe('<repo>/../worktrees/bug-1-x/PLANNING-1-x.md');
  });

  it('redacts a path outside the repository to <local>/<basename>', () => {
    expect(toPortablePath('/home/alice/elsewhere/wt-7', { anchor: ANCHOR, homes: HOMES })).toBe(
      '<local>/wt-7'
    );
    expect(toPortablePath('/srv/pool/wt-7', { anchor: ANCHOR, homes: HOMES })).toBe('<local>/wt-7');
    expect(toPortablePath('/home/alice/x', { anchor: null, homes: HOMES })).toBe('<local>/x');
  });

  it('never keeps a user name: a home directory itself becomes <local>', () => {
    expect(toPortablePath('/home/alice', { anchor: null, homes: HOMES })).toBe('<local>');
    expect(toPortablePath('/Users/bob', { anchor: null, homes: HOMES })).toBe('<local>');
  });

  it('does not climb into the home root when the checkout sits directly in a home directory', () => {
    // anchor /home/alice/acme → container /home/alice is the home dir: no <repo>/.. form.
    expect(
      toPortablePath('/home/alice/other/x', { anchor: '/home/alice/acme', homes: HOMES })
    ).toBe('<local>/x');
  });

  it('resolves a relative input against cwd, and leaves it alone without one', () => {
    expect(
      toPortablePath('PLANNING-1-x.md', {
        anchor: ANCHOR,
        homes: HOMES,
        cwd: '/home/alice/projects/acme/worktrees/wt',
      })
    ).toBe('<repo>/../worktrees/wt/PLANNING-1-x.md');
    expect(toPortablePath('worktrees/wt', { anchor: ANCHOR, homes: HOMES })).toBe('worktrees/wt');
  });

  it('passes an already-portable value through unchanged', () => {
    expect(toPortablePath('<repo>/a', { anchor: ANCHOR, homes: HOMES })).toBe('<repo>/a');
    expect(toPortablePath('<local>/a', { anchor: ANCHOR, homes: HOMES })).toBe('<local>/a');
    expect(isPortablePath('<repo>/a')).toBe(true);
    expect(isPortablePath('/abs')).toBe(false);
  });
});

describe('resolvePortablePath', () => {
  const here = '/data/u2/acme/main';
  it('resolves <repo>/… against THIS machine’s anchor, not the posted string', () => {
    expect(resolvePortablePath('<repo>/../worktrees/wt', { anchor: here })).toBe(
      '/data/u2/acme/worktrees/wt'
    );
    expect(resolvePortablePath('<repo>', { anchor: here })).toBe(here);
  });

  it('round-trips a sibling worktree on the same machine', () => {
    const wt = '/home/alice/projects/acme/worktrees/bug-1-x';
    const posted = toPortablePath(wt, { anchor: ANCHOR, homes: HOMES });
    expect(resolvePortablePath(posted, { anchor: ANCHOR })).toBe(wt);
  });

  it('resolves <local>/<name> by a unique local worktree basename', () => {
    const worktrees = ['/srv/pool/wt-7', '/srv/pool/wt-8'];
    expect(resolvePortablePath('<local>/wt-7', { anchor: here, worktrees })).toBe('/srv/pool/wt-7');
    expect(resolvePortablePath('<local>/nope', { anchor: here, worktrees })).toBeNull();
    expect(
      resolvePortablePath('<local>/wt-7', { worktrees: [...worktrees, '/other/wt-7'] })
    ).toBeNull();
  });

  it('keeps legacy absolute values working', () => {
    expect(resolvePortablePath('/legacy/abs/wt', {})).toBe('/legacy/abs/wt');
  });

  it('refuses a <repo> value that climbs above the anchor’s parent', () => {
    expect(resolvePortablePath('<repo>/../../../etc', { anchor: here })).toBeNull();
    expect(resolvePortablePath('<repo>/x', { anchor: null })).toBeNull();
    expect(resolvePortablePath('<local>/../x', { worktrees: ['/x'] })).toBeNull();
  });
});

describe('redactHomePaths', () => {
  it('redacts every home-directory form in free text', () => {
    const text = [
      'worktree=/home/alice/projects/acme/worktrees/wt',
      'see /Users/bob/code/thing.md.',
      'win C:\\Users\\carol\\repo\\file.txt and C:/Users/carol/x',
      'bare /home/dave',
    ].join('\n');
    const out = redactHomePaths(text, { homes: HOMES });
    expect(out).not.toMatch(/alice|bob|carol|dave/);
    expect(out).toContain('worktree=<local>/wt');
    expect(out).toContain('see <local>/thing.md.');
    expect(out).toContain('<local>/file.txt');
    expect(out).toContain('bare <local>');
    expect(containsHomePath(out, { homes: HOMES })).toBe(false);
  });

  it('prefers <repo>/… for a home path inside the repository', () => {
    expect(
      redactHomePaths(`edit ${ANCHOR}/cli/src/gh.ts now`, { anchor: ANCHOR, homes: HOMES })
    ).toBe('edit <repo>/cli/src/gh.ts now');
  });

  it("redacts the running user's own home even outside /home and /Users", () => {
    const out = redactHomePaths('state in /var/lib/svc/.dossier/x.json', {
      homes: ['/var/lib/svc'],
    });
    expect(out).toBe('state in <local>/x.json');
  });

  it('leaves URLs, non-home paths, and portable tokens alone; is idempotent', () => {
    const text = 'https://example.com/home/alice/x /tmp/a/b <repo>/x <local>/y';
    expect(redactHomePaths(text, { homes: HOMES })).toBe(text);
    const once = redactHomePaths('/home/alice/a/b', { homes: HOMES });
    expect(redactHomePaths(once, { homes: HOMES })).toBe(once);
  });
});
