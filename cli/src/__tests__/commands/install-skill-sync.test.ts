/**
 * install-skill --all / --outdated / --list, against a real (temp) HOME so provenance
 * is verified by reading back what was actually written.
 */
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSignedPayload,
  buildSpecFrontmatter,
  calculateChecksum,
  Ed25519Signer,
  parseDossierContent,
  renderSpecDossier,
} from '@ai-dossier/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => {
  const fsm = require('node:fs') as typeof import('node:fs');
  const osm = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  const dir = fsm.mkdtempSync(p.join(osm.tmpdir(), 'install-skill-sync-'));
  process.env.HOME = dir;
  return dir;
});

import { registerInstallSkillCommand } from '../../commands/install-skill';
import * as multiRegistry from '../../multi-registry';
import { checkSignature } from '../../verify-dossier';
import { logged, runCommandTree } from '../helpers/test-utils';

vi.mock('../../multi-registry');

const skillsDir = path.join(home, '.claude', 'skills');

const dossier = (name: string, version: string) =>
  `---dossier\n${JSON.stringify({ name, version, description: `${name} desc` })}\n---\n# ${name}\n`;

/** Registry state: full path -> version. */
let registry: Record<string, string>;
const missing = new Set<string>();
/** Full path -> exact content served instead of the generated dossier. */
const served = new Map<string, string>();

function mockRegistry() {
  vi.mocked(multiRegistry.multiRegistryList).mockImplementation((async () => ({
    dossiers: Object.entries(registry).map(([name, version]) => ({
      name,
      version,
      _registry: 'public',
    })),
    total: Object.keys(registry).length,
    errors: [],
  })) as never);
  vi.mocked(multiRegistry.multiRegistryGetContent).mockImplementation((async (
    name: string,
    version?: string
  ) => {
    if (missing.has(name)) return { result: null, errors: [] };
    return {
      result: {
        content:
          served.get(name) ?? dossier(name.split('/').pop() as string, version ?? registry[name]),
        _registry: 'public',
      },
      errors: [],
    };
  }) as never);
}

const installedFm = (skill: string) =>
  fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');

const installedSource = (skill: string) =>
  fs.readFileSync(path.join(skillsDir, skill, '.dossier-source'), 'utf8').trim();

const run = (...args: string[]) =>
  runCommandTree(registerInstallSkillCommand, ['install-skill', '--fresh', ...args]);

describe('install-skill --all / --outdated / --list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.config'), { recursive: true, force: true });
    missing.clear();
    served.clear();
    registry = {
      'imboard-ai/skills/alpha-skill': '1.0.0',
      'imboard-ai/skills/beta-skill': '2.0.0',
      'other-org/gamma-skill': '1.0.0',
      'imboard-ai/git/not-a-skill-dossier': '1.0.0',
    };
    mockRegistry();
  });

  it("--all --owner installs only that owner's skills and records provenance", async () => {
    const code = await run('--all', '--owner', 'imboard-ai');
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(skillsDir, 'alpha-skill'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'beta-skill'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'gamma-skill'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'not-a-skill-dossier'))).toBe(false);
    expect(installedSource('alpha-skill')).toBe('imboard-ai/skills/alpha-skill');
    // Provenance stays out of the frontmatter, where it would break a v2 signature (#1136).
    expect(installedFm('alpha-skill')).not.toContain('x_source');
  });

  it('writes provenance into the opencode copy too', async () => {
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    await run('--all', '--owner', 'imboard-ai');
    const oc = fs.readFileSync(
      path.join(home, '.config', 'opencode', 'skills', 'alpha-skill', 'SKILL.md'),
      'utf8'
    );
    expect(oc).toContain('x_source: imboard-ai/skills/alpha-skill');
    expect(oc).toContain("version: '1.0.0'");
  });

  it('--outdated alone reinstalls only installed skills that are BEHIND', async () => {
    await run('--all', '--owner', 'imboard-ai');
    registry['imboard-ai/skills/beta-skill'] = '2.1.0';
    vi.mocked(multiRegistry.multiRegistryGetContent).mockClear();

    const code = await run('--outdated', '--json');
    expect(code).toBe(0);
    const out = JSON.parse(logged().at(-1) as string);
    expect(out.summary).toMatchObject({ ok: 1, skipped: 1, failed: 0 });
    expect(installedFm('beta-skill')).toContain('version: 2.1.0');
    expect(multiRegistry.multiRegistryGetContent).toHaveBeenCalledTimes(1);
  });

  it('--outdated ignores installed skills with no recorded source', async () => {
    fs.mkdirSync(path.join(skillsDir, 'legacy-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'legacy-skill', 'SKILL.md'),
      '---\nname: legacy-skill\n---\nx'
    );
    const code = await run('--outdated', '--json');
    expect(code).toBe(0);
    expect(JSON.parse(logged().at(-1) as string).results).toEqual([]);
  });

  it('--all --outdated installs missing skills and skips current ones', async () => {
    await run('--all', '--owner', 'imboard-ai');
    fs.rmSync(path.join(skillsDir, 'beta-skill'), { recursive: true });
    await run('--all', '--outdated', '--owner', 'imboard-ai', '--json');
    const out = JSON.parse(logged().at(-1) as string);
    expect(out.results.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([
      ['imboard-ai/skills/alpha-skill', 'skipped'],
      ['imboard-ai/skills/beta-skill', 'ok'],
    ]);
  });

  it('reports basename collisions instead of overwriting, and exits non-zero', async () => {
    registry['imboard-ai/qa/dup-skill'] = '1.0.0';
    registry['imboard-ai/skills/dup-skill'] = '1.0.0';
    const code = await run('--all', '--owner', 'imboard-ai', '--json');
    expect(code).toBe(1);
    const out = JSON.parse(logged().at(-1) as string);
    const dups = out.results.filter((r: { skill: string }) => r.skill === 'dup-skill');
    expect(dups.map((r: { status: string }) => r.status)).toEqual(['collision', 'collision']);
    expect(fs.existsSync(path.join(skillsDir, 'dup-skill'))).toBe(false);
    // The non-colliding skills were still installed.
    expect(fs.existsSync(path.join(skillsDir, 'alpha-skill'))).toBe(true);
  });

  it('refuses to replace a different installed dossier without --force', async () => {
    fs.mkdirSync(path.join(skillsDir, 'alpha-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'alpha-skill', 'SKILL.md'),
      '---\nname: alpha-skill\nx_source: someone-else/alpha-skill\nversion: 1.0.0\n---\nx'
    );
    const code = await run('--all', '--owner', 'imboard-ai', '--json');
    expect(code).toBe(1);
    expect(installedFm('alpha-skill')).toContain('someone-else/alpha-skill');

    expect(await run('--all', '--owner', 'imboard-ai', '--force', '--json')).toBe(0);
    expect(installedSource('alpha-skill')).toBe('imboard-ai/skills/alpha-skill');
  });

  it('per-skill failure exits non-zero but keeps going', async () => {
    missing.add('imboard-ai/skills/alpha-skill');
    const code = await run('--all', '--owner', 'imboard-ai', '--json');
    expect(code).toBe(1);
    const out = JSON.parse(logged().at(-1) as string);
    expect(out.success).toBe(false);
    expect(out.summary).toMatchObject({ ok: 1, failed: 1 });
    expect(fs.existsSync(path.join(skillsDir, 'beta-skill'))).toBe(true);
  });

  it('exits non-zero when the registry cannot be listed', async () => {
    vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
      dossiers: [],
      total: 0,
      errors: [{ registry: 'public', error: 'boom' }],
    });
    expect(await run('--all', '--json')).toBe(1);
  });

  it('rejects a name combined with --all', async () => {
    expect(await run('--all', 'org/x-skill')).toBe(1);
  });

  it('--list shows installed vs latest and flags BEHIND / unknown source', async () => {
    await run('--all', '--owner', 'imboard-ai');
    registry['imboard-ai/skills/beta-skill'] = '2.1.0';
    fs.mkdirSync(path.join(skillsDir, 'legacy-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'legacy-skill', 'SKILL.md'),
      '---\nname: legacy-skill\n---\nx'
    );
    vi.mocked(console.log).mockClear();

    await runCommandTree(registerInstallSkillCommand, ['install-skill', '--list']);
    const text = logged().join('\n');
    expect(text).toMatch(/beta-skill.*v2\.0\.0 \(latest 2\.1\.0\) BEHIND/);
    expect(text).toMatch(/alpha-skill.*v1\.0\.0/);
    expect(text).not.toMatch(/alpha-skill.*BEHIND/);
    expect(text).toMatch(/legacy-skill.*unknown source/);
  });

  it('--list --json degrades gracefully when the registry is unreachable', async () => {
    await run('--all', '--owner', 'imboard-ai');
    vi.mocked(multiRegistry.multiRegistryList).mockRejectedValue(new Error('offline'));
    vi.mocked(console.log).mockClear();
    await runCommandTree(registerInstallSkillCommand, ['install-skill', '--list', '--json']);
    const out = JSON.parse(logged().at(-1) as string);
    expect(out.registryError).toBe('offline');
    expect(out.skills[0]).toMatchObject({
      source: 'imboard-ai/skills/alpha-skill',
      status: 'current',
    });
    expect(os.homedir()).toBe(home);
  });

  describe('installs written before #1136 (x_source in frontmatter, no .dossier-source)', () => {
    function writeOldInstall(skill: string, source: string, version: string) {
      fs.mkdirSync(path.join(skillsDir, skill), { recursive: true });
      fs.writeFileSync(
        path.join(skillsDir, skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: ${skill} desc\nversion: ${version}\nx_source: ${source}\n---\n# ${skill}\n`
      );
    }

    it('--list still reads their source and flags BEHIND', async () => {
      writeOldInstall('beta-skill', 'imboard-ai/skills/beta-skill', '1.0.0');
      vi.mocked(console.log).mockClear();
      await runCommandTree(registerInstallSkillCommand, ['install-skill', '--list']);
      expect(logged().join('\n')).toMatch(/beta-skill.*v1\.0\.0 \(latest 2\.0\.0\) BEHIND/);
    });

    it('--outdated still refreshes them, and the refresh records a sidecar', async () => {
      writeOldInstall('beta-skill', 'imboard-ai/skills/beta-skill', '1.0.0');
      writeOldInstall('alpha-skill', 'imboard-ai/skills/alpha-skill', '1.0.0');
      const code = await run('--outdated', '--json');
      expect(code).toBe(0);
      const out = JSON.parse(logged().at(-1) as string);
      expect(out.summary).toMatchObject({ ok: 1, skipped: 1, failed: 0 });
      expect(installedFm('beta-skill')).toContain('version: 2.0.0');
      expect(installedFm('beta-skill')).not.toContain('x_source');
      expect(installedSource('beta-skill')).toBe('imboard-ai/skills/beta-skill');
    });
  });

  // `ai-dossier verify ~/.claude/skills/<name>/SKILL.md` must accept a genuine install.
  describe('a signed install still verifies', () => {
    const BODY = '# Signed skill\n\nDo the signed thing.\n';
    let signer: Ed25519Signer;

    beforeEach(() => {
      const keyPath = path.join(home, 'k.pem');
      const { privateKey } = generateKeyPairSync('ed25519');
      fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
      signer = new Ed25519Signer(keyPath);
    });

    function legacyFm(extra: Record<string, unknown>): Record<string, unknown> {
      return {
        dossier_schema_version: '1.0.0',
        name: 'signed-skill',
        title: 'Signed skill',
        version: '1.0.0',
        risk_level: 'low',
        objective: 'Do the signed thing.',
        checksum: { algorithm: 'sha256', hash: calculateChecksum(BODY) },
        ...extra,
      };
    }

    async function signedLegacy(
      fm: Record<string, unknown>,
      covers: 'body' | 'frontmatter+body'
    ): Promise<string> {
      const sig = await signer.sign(buildSignedPayload(fm, BODY, covers));
      const signature = covers === 'body' ? sig : { ...sig, covers };
      return `---dossier\n${JSON.stringify({ ...fm, signature }, null, 2)}\n---\n${BODY}`;
    }

    async function installAndCheck(content: string) {
      registry['imboard-ai/skills/signed-skill'] = '1.0.0';
      served.set('imboard-ai/skills/signed-skill', content);
      // A single install returns without calling process.exit on success.
      expect((await run('imboard-ai/skills/signed-skill@1.0.0')) ?? 0).toBe(0);
      expect(installedSource('signed-skill')).toBe('imboard-ai/skills/signed-skill');
      const parsed = parseDossierContent(installedFm('signed-skill'));
      expect((await checkSignature(parsed)).verified).toBe(true);
      return parsed;
    }

    it('legacy v2 with a description', async () => {
      const parsed = await installAndCheck(
        await signedLegacy(legacyFm({ description: 'A signed skill.' }), 'frontmatter+body')
      );
      expect(installedFm('signed-skill').startsWith('---\nname: signed-skill\n')).toBe(true);
      expect(parsed.frontmatter.description).toBe('A signed skill.');
    });

    it('legacy v2 without a description is not given one, since v2 covers the frontmatter', async () => {
      const parsed = await installAndCheck(await signedLegacy(legacyFm({}), 'frontmatter+body'));
      expect(parsed.frontmatter.description).toBeUndefined();
    });

    it('legacy v1 (body-only) still gets its description from objective', async () => {
      const parsed = await installAndCheck(await signedLegacy(legacyFm({}), 'body'));
      expect(parsed.frontmatter.description).toBe('Do the signed thing.');
    });

    it('spec-shaped v3', async () => {
      const fm = legacyFm({ description: 'A signed skill.' });
      const { objective: _objective, ...specFm } = fm;
      const sig = await signer.sign(
        buildSignedPayload(buildSpecFrontmatter(specFm), BODY, 'spec-frontmatter+body')
      );
      const content = renderSpecDossier(
        { ...specFm, signature: { ...sig, covers: 'spec-frontmatter+body' } },
        BODY
      );
      await installAndCheck(content);
      expect(installedFm('signed-skill')).toBe(content);
    });
  });
});
