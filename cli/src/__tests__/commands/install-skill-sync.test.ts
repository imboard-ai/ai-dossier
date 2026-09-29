/**
 * install-skill --all / --outdated / --list, against a real (temp) HOME so provenance
 * is verified by reading back what was actually written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { logged, runCommandTree } from '../helpers/test-utils';

vi.mock('../../multi-registry');

const skillsDir = path.join(home, '.claude', 'skills');

const dossier = (name: string, version: string) =>
  `---dossier\n${JSON.stringify({ name, version, description: `${name} desc` })}\n---\n# ${name}\n`;

/** Registry state: full path -> version. */
let registry: Record<string, string>;
const missing = new Set<string>();

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
        content: dossier(name.split('/').pop() as string, version ?? registry[name]),
        _registry: 'public',
      },
      errors: [],
    };
  }) as never);
}

const installedFm = (skill: string) =>
  fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');

const run = (...args: string[]) =>
  runCommandTree(registerInstallSkillCommand, ['install-skill', '--fresh', ...args]);

describe('install-skill --all / --outdated / --list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(home, '.config'), { recursive: true, force: true });
    missing.clear();
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
    expect(installedFm('alpha-skill')).toContain('x_source: imboard-ai/skills/alpha-skill');
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
    expect(installedFm('alpha-skill')).toContain('x_source: imboard-ai/skills/alpha-skill');
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
});
