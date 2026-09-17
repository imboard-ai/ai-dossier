import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPrBody,
  DOSSIER_PREFIX,
  dossierNameFromFile,
  extractVersion,
  FAMILIES,
  familyShortName,
  main,
  PR_TITLE,
  parsePulledVersion,
  RefreshError,
  selectFamilies,
} from './refresh-examples-snapshot.mjs';

const META_PREFIX = 'imboard-ai/meta';

function dossierContent(version, extra = '{}') {
  return `---dossier\n{\n  "name": "sample",\n  "version": "${version}",\n  "extra": ${JSON.stringify(extra)}\n}\n---\n\n# Sample\n`;
}

describe('dossierNameFromFile', () => {
  it('maps a .ds.md filename onto <prefix>/<slug> for the given family prefix', () => {
    expect(dossierNameFromFile('full-cycle-issue.ds.md', DOSSIER_PREFIX)).toBe(
      `${DOSSIER_PREFIX}/full-cycle-issue`
    );
    expect(dossierNameFromFile('gate-issue.ds.md', DOSSIER_PREFIX)).toBe(
      `${DOSSIER_PREFIX}/gate-issue`
    );
  });

  it('uses whichever prefix is passed, not a hardcoded one (#751)', () => {
    expect(dossierNameFromFile('publish-dossier.ds.md', META_PREFIX)).toBe(
      `${META_PREFIX}/publish-dossier`
    );
  });

  it('rejects a filename without the .ds.md extension', () => {
    expect(() => dossierNameFromFile('full-cycle-issue.md', DOSSIER_PREFIX)).toThrow(RefreshError);
  });

  it('rejects a filename that is only the extension', () => {
    expect(() => dossierNameFromFile('.ds.md', DOSSIER_PREFIX)).toThrow(RefreshError);
  });
});

describe('FAMILIES', () => {
  it('covers both the git and meta example mirrors (#751)', () => {
    expect(FAMILIES).toEqual([
      { prefix: 'imboard-ai/git', dir: 'examples/git' },
      { prefix: 'imboard-ai/meta', dir: 'examples/meta' },
    ]);
  });
});

describe('familyShortName', () => {
  it('returns the last segment of a registry prefix', () => {
    expect(familyShortName('imboard-ai/git')).toBe('git');
    expect(familyShortName('imboard-ai/meta')).toBe('meta');
  });
});

describe('selectFamilies', () => {
  it('returns every family when no name is given', () => {
    expect(selectFamilies(FAMILIES, null)).toBe(FAMILIES);
  });

  it('filters to the one family matching --family <name>', () => {
    expect(selectFamilies(FAMILIES, 'meta')).toEqual([
      { prefix: 'imboard-ai/meta', dir: 'examples/meta' },
    ]);
  });

  it('throws on an unknown family name, listing the known ones', () => {
    expect(() => selectFamilies(FAMILIES, 'nope')).toThrow(/unknown family 'nope'.*git, meta/);
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

  it('defaults to naming every configured family (#751)', () => {
    const body = buildPrBody([]);
    expect(body).toContain('`examples/git/`');
    expect(body).toContain('`examples/meta/`');
  });

  it('names only the families actually passed in, not every configured one (#751)', () => {
    const metaOnly = [{ prefix: META_PREFIX, dir: 'examples/meta' }];
    const body = buildPrBody([], metaOnly);
    expect(body).toContain('`examples/meta/`');
    expect(body).not.toContain('`examples/git/`');
  });
});

describe('PR_TITLE', () => {
  it('is family-agnostic — no longer names one directory verbatim (#751)', () => {
    expect(PR_TITLE).toBe('chore(examples): refresh dossier snapshots');
  });
});

describe('main (orchestration, with a stubbed pull)', () => {
  let repoRoot;
  let examplesDir;
  let families;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'refresh-examples-main-'));
    examplesDir = 'examples/git';
    families = [{ prefix: DOSSIER_PREFIX, dir: examplesDir }];
    mkdirSync(join(repoRoot, examplesDir), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeExample(slug, version, dir = examplesDir) {
    mkdirSync(join(repoRoot, dir), { recursive: true });
    writeFileSync(join(repoRoot, dir, `${slug}.ds.md`), dossierContent(version));
  }

  it('reports changed=true and writes an old->new PR body when a version moved', () => {
    writeExample('full-cycle-issue', '3.6.1');
    const prBodyOut = join(repoRoot, 'pr-body.md');

    const result = main({
      families,
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
      families,
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
      families,
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
        families,
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
        families,
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

  it('drives both directories independently from one family list (#751)', () => {
    const metaDir = 'examples/meta';
    writeExample('full-cycle-issue', '3.6.1', examplesDir);
    writeExample('publish-dossier', '1.1.2', metaDir);
    const twoFamilies = [
      { prefix: DOSSIER_PREFIX, dir: examplesDir },
      { prefix: META_PREFIX, dir: metaDir },
    ];
    const prBodyOut = join(repoRoot, 'pr-body.md');

    const result = main({
      families: twoFamilies,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut,
      // Only the meta dossier moved; the git one is pulled back unchanged.
      pull: ({ name }) =>
        name === `${META_PREFIX}/publish-dossier`
          ? { version: '1.1.3', content: dossierContent('1.1.3') }
          : { version: '3.6.1', content: dossierContent('3.6.1') },
      log: () => {},
    });

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      { name: `${META_PREFIX}/publish-dossier`, oldVersion: '1.1.2', newVersion: '1.1.3' },
    ]);
    expect(result.families).toEqual([
      { prefix: DOSSIER_PREFIX, dir: examplesDir, fileCount: 1, changedCount: 0 },
      { prefix: META_PREFIX, dir: metaDir, fileCount: 1, changedCount: 1 },
    ]);
  });

  it('--check detects drift but does not write the new content to disk', () => {
    writeExample('gate-issue', '1.5.2');
    const localPath = join(repoRoot, examplesDir, 'gate-issue.ds.md');
    const beforeCheck = readFileSync(localPath, 'utf8');
    const prBodyOut = join(repoRoot, 'pr-body.md');

    const result = main({
      families,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut,
      check: true,
      pull: () => ({ version: '1.5.3', content: dossierContent('1.5.3') }),
      log: () => {},
    });

    expect(result.changed).toBe(true);
    expect(result.changes).toEqual([
      { name: `${DOSSIER_PREFIX}/gate-issue`, oldVersion: '1.5.2', newVersion: '1.5.3' },
    ]);
    expect(readFileSync(localPath, 'utf8')).toBe(beforeCheck);
  });

  it('--check reports changed=false when every mirror already matches (AC1)', () => {
    writeExample('gate-issue', '1.5.2');
    const prBodyOut = join(repoRoot, 'pr-body.md');

    const result = main({
      families,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut,
      check: true,
      pull: () => ({ version: '1.5.2', content: dossierContent('1.5.2') }),
      log: () => {},
    });

    expect(result.changed).toBe(false);
  });
});

describe('main GITHUB_OUTPUT (dirs output, #751)', () => {
  let repoRoot;
  let examplesDir;
  let metaDir;
  let families;
  let outputFile;
  let prevGithubOutput;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'refresh-examples-outputs-'));
    examplesDir = 'examples/git';
    metaDir = 'examples/meta';
    families = [
      { prefix: DOSSIER_PREFIX, dir: examplesDir },
      { prefix: META_PREFIX, dir: metaDir },
    ];
    mkdirSync(join(repoRoot, examplesDir), { recursive: true });
    mkdirSync(join(repoRoot, metaDir), { recursive: true });
    writeFileSync(join(repoRoot, examplesDir, 'gate-issue.ds.md'), dossierContent('1.5.2'));
    writeFileSync(join(repoRoot, metaDir, 'publish-dossier.ds.md'), dossierContent('1.1.2'));
    outputFile = join(repoRoot, 'github-output.txt');
    prevGithubOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputFile;
  });

  afterEach(() => {
    if (prevGithubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = prevGithubOutput;
    }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('writes a dirs output listing every family directory, driving the workflow git add (#751)', () => {
    main({
      families,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut: join(repoRoot, 'pr-body.md'),
      pull: () => ({ version: '1.5.2', content: dossierContent('1.5.2') }),
      log: () => {},
    });

    const output = readFileSync(outputFile, 'utf8');
    expect(output).toContain(`dirs=${examplesDir} ${metaDir}\n`);
  });

  it('never writes GITHUB_OUTPUT during --check — a dry run must not masquerade as the real refresh', () => {
    main({
      families,
      cliPath: 'cli/dist/cli.js',
      repoRoot,
      prBodyOut: join(repoRoot, 'pr-body.md'),
      check: true,
      pull: () => ({ version: '1.5.2', content: dossierContent('1.5.2') }),
      log: () => {},
    });

    expect(existsSync(outputFile)).toBe(false);
  });
});
