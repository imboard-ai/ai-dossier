import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPrBody,
  DOSSIER_PREFIX,
  dossierNameFromFile,
  extractVersion,
  main,
  PR_TITLE,
  parsePulledVersion,
  RefreshError,
} from './refresh-examples-snapshot.mjs';

function dossierContent(version, extra = '{}') {
  return `---dossier\n{\n  "name": "sample",\n  "version": "${version}",\n  "extra": ${JSON.stringify(extra)}\n}\n---\n\n# Sample\n`;
}

describe('dossierNameFromFile', () => {
  it('maps a .ds.md filename onto imboard-ai/git/<slug>', () => {
    expect(dossierNameFromFile('full-cycle-issue.ds.md')).toBe(
      `${DOSSIER_PREFIX}/full-cycle-issue`
    );
    expect(dossierNameFromFile('gate-issue.ds.md')).toBe(`${DOSSIER_PREFIX}/gate-issue`);
  });

  it('rejects a filename without the .ds.md extension', () => {
    expect(() => dossierNameFromFile('full-cycle-issue.md')).toThrow(RefreshError);
  });

  it('rejects a filename that is only the extension', () => {
    expect(() => dossierNameFromFile('.ds.md')).toThrow(RefreshError);
  });
});

describe('extractVersion', () => {
  it('parses the version out of a well-formed frontmatter block', () => {
    expect(extractVersion(dossierContent('3.12.3'))).toBe('3.12.3');
  });

  it('throws when there is no frontmatter block', () => {
    expect(() => extractVersion('# just a heading\n', 'test.ds.md')).toThrow(RefreshError);
  });

  it('throws when the frontmatter is not valid JSON', () => {
    const bad = '---dossier\n{ not json\n---\n\n# body\n';
    expect(() => extractVersion(bad, 'test.ds.md')).toThrow(RefreshError);
  });

  it('throws when version is missing', () => {
    const noVersion = '---dossier\n{\n  "name": "sample"\n}\n---\n\n# body\n';
    expect(() => extractVersion(noVersion, 'test.ds.md')).toThrow(RefreshError);
  });

  it('includes the source label in the error message for debuggability', () => {
    expect(() => extractVersion('nope', 'examples/git/foo.ds.md')).toThrow(
      /examples\/git\/foo\.ds\.md/
    );
  });
});

describe('parsePulledVersion', () => {
  it('parses the version from a successful pull line', () => {
    const stdout =
      '✅ imboard-ai/git/full-cycle-issue@3.12.3 (updated) [public]\n   /path/to/cache\n';
    expect(parsePulledVersion(stdout, 'imboard-ai/git/full-cycle-issue')).toBe('3.12.3');
  });

  it('parses the version on the already-cached path too', () => {
    const stdout = '✅ imboard-ai/git/gate-issue@1.5.2 (already cached)\n';
    expect(parsePulledVersion(stdout, 'imboard-ai/git/gate-issue')).toBe('1.5.2');
  });

  it('does not confuse two dossiers with a shared name prefix', () => {
    const stdout = '✅ imboard-ai/git/ship-issue-extra@9.9.9 (updated)\n';
    expect(() => parsePulledVersion(stdout, 'imboard-ai/git/ship-issue')).toThrow(RefreshError);
  });

  it('throws when the dossier is not mentioned in the output', () => {
    const stdout = '❌ imboard-ai/git/gate-issue: not found in registry\n';
    expect(() => parsePulledVersion(stdout, 'imboard-ai/git/gate-issue')).toThrow(RefreshError);
  });
});

describe('buildPrBody', () => {
  it('includes an old->new table for each change (AC2)', () => {
    const body = buildPrBody([
      { name: 'imboard-ai/git/full-cycle-issue', oldVersion: '3.6.1', newVersion: '3.12.3' },
      { name: 'imboard-ai/git/gate-issue', oldVersion: '1.0.3', newVersion: '1.5.2' },
    ]);
    expect(body).toContain('| `imboard-ai/git/full-cycle-issue` | 3.6.1 | 3.12.3 |');
    expect(body).toContain('| `imboard-ai/git/gate-issue` | 1.0.3 | 1.5.2 |');
    expect(body).toContain('test-examples.sh');
  });

  it('handles an empty change list without throwing', () => {
    const body = buildPrBody([]);
    expect(body).toContain('No dossier versions changed.');
  });

  it('renders a new-file placeholder when oldVersion is undefined', () => {
    const body = buildPrBody([
      { name: 'imboard-ai/git/new-one', oldVersion: undefined, newVersion: '1.0.0' },
    ]);
    expect(body).toContain('_(new file)_');
  });
});

describe('PR_TITLE', () => {
  it('matches the exact title AC1 requires', () => {
    expect(PR_TITLE).toBe('chore(examples): refresh git/ snapshot');
  });
});

describe('main (orchestration, with a stubbed pull)', () => {
  let repoRoot;
  let examplesDir;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'refresh-examples-main-'));
    examplesDir = 'examples/git';
    mkdirSync(join(repoRoot, examplesDir), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeExample(slug, version) {
    writeFileSync(join(repoRoot, examplesDir, `${slug}.ds.md`), dossierContent(version));
  }

  it('reports changed=true and writes an old->new PR body when a version moved', () => {
    writeExample('full-cycle-issue', '3.6.1');
    const prBodyOut = join(repoRoot, 'pr-body.md');

    const result = main({
      examplesDir,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut,
      pull: () => ({ version: '3.12.3', content: dossierContent('3.12.3') }),
      log: () => {},
    });

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      { name: `${DOSSIER_PREFIX}/full-cycle-issue`, oldVersion: '3.6.1', newVersion: '3.12.3' },
    ]);
  });

  it('reports changed=false on a no-op week (AC4) — pulled content identical to local', () => {
    writeExample('gate-issue', '1.5.2');
    const prBodyOut = join(repoRoot, 'pr-body.md');

    const result = main({
      examplesDir,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut,
      pull: () => ({ version: '1.5.2', content: dossierContent('1.5.2') }),
      log: () => {},
    });

    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it('treats a same-version-but-different-content pull as changed (checksum/date-only republish)', () => {
    writeExample('ship-issue', '1.7.2');
    const prBodyOut = join(repoRoot, 'pr-body.md');

    const result = main({
      examplesDir,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut,
      pull: () => ({ version: '1.7.2', content: dossierContent('1.7.2', 'republished') }),
      log: () => {},
    });

    expect(result.changed).toBe(true);
  });

  it('throws (fails loudly) rather than skipping when the examples dir is empty', () => {
    const prBodyOut = join(repoRoot, 'pr-body.md');
    expect(() =>
      main({
        examplesDir,
        cliPath: 'cli/dist/cli.js',
        repoRoot,
        prBodyOut,
        pull: () => ({ version: '1.0.0', content: '' }),
        log: () => {},
      })
    ).toThrow(RefreshError);
  });

  it('propagates a pull failure for one dossier instead of silently skipping it', () => {
    writeExample('full-cycle-issue', '3.6.1');
    writeExample('gate-issue', '1.5.2');
    const prBodyOut = join(repoRoot, 'pr-body.md');

    expect(() =>
      main({
        examplesDir,
        cliPath: 'cli/dist/cli.js',
        repoRoot,
        prBodyOut,
        pull: ({ name }) => {
          if (name.includes('gate-issue')) {
            throw new RefreshError(`pull failed for '${name}'`);
          }
          return { version: '3.6.1', content: dossierContent('3.6.1') };
        },
        log: () => {},
      })
    ).toThrow(RefreshError);
  });
});
