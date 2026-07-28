import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSkillCollision, collisionMessage, readInstalledSource } from '../skill-collision';
import { toSkillFrontmatter } from '../skill-frontmatter';

const BODY = '# Thing\n\nDo the thing.\n';
const dossier = (fm: Record<string, unknown>) =>
  `---dossier\n${JSON.stringify(fm, null, 2)}\n---\n${BODY}`;

describe('skill collision detection', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = join(tmpdir(), `skill-collision-${Date.now()}-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'SKILL.md');
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports no collision when nothing is installed', () => {
    expect(checkSkillCollision(file, 'imboard-ai/pm/idea-to-prd').collides).toBe(false);
  });

  // The common case. Requiring --force here is what trained people to pass it always.
  it('allows upgrading the same dossier', () => {
    writeFileSync(
      file,
      toSkillFrontmatter(dossier({ name: 'idea-to-prd' }), 'imboard-ai/pm/idea-to-prd')
    );
    expect(checkSkillCollision(file, 'imboard-ai/pm/idea-to-prd').collides).toBe(false);
  });

  // The case that silently cost you a skill: same basename, different dossier.
  it('flags a different dossier occupying the same directory', () => {
    writeFileSync(
      file,
      toSkillFrontmatter(dossier({ name: 'idea-to-prd' }), 'imboard-ai/idea-to-prd')
    );
    const r = checkSkillCollision(file, 'imboard-ai/pm/idea-to-prd');
    expect(r.collides).toBe(true);
    expect(r.existingSource).toBe('imboard-ai/idea-to-prd');
  });

  // Installs predating x_source record only the bare name; an upgrade of the same
  // dossier must not be mistaken for a collision.
  it('treats a legacy install of the same dossier as an upgrade', () => {
    writeFileSync(file, dossier({ name: 'idea-to-prd' }));
    expect(readInstalledSource(file)).toBe('idea-to-prd');
    expect(checkSkillCollision(file, 'imboard-ai/pm/idea-to-prd').collides).toBe(false);
  });

  it('flags a legacy install of a different dossier', () => {
    writeFileSync(file, dossier({ name: 'something-else' }));
    expect(checkSkillCollision(file, 'imboard-ai/pm/idea-to-prd').collides).toBe(true);
  });

  // An unreadable file is not evidence of a collision; blocking on it would be worse
  // than the problem it guards against.
  it('does not block on an unparseable installed file', () => {
    writeFileSync(file, '---dossier\n{ not json\n---\nbody');
    expect(checkSkillCollision(file, 'imboard-ai/pm/idea-to-prd').collides).toBe(false);
  });

  it('names both dossiers in the refusal message', () => {
    const msg = collisionMessage(
      'idea-to-prd',
      'imboard-ai/idea-to-prd',
      'imboard-ai/pm/idea-to-prd',
      file
    );
    expect(msg).toContain('imboard-ai/idea-to-prd');
    expect(msg).toContain('imboard-ai/pm/idea-to-prd');
    expect(msg).toContain('--force');
  });
});

describe('toSkillFrontmatter source recording', () => {
  it('records the full registry path so future installs can compare identity', () => {
    const out = toSkillFrontmatter(dossier({ name: 'idea-to-prd' }), 'imboard-ai/pm/idea-to-prd');
    expect(out).toContain('x_source: imboard-ai/pm/idea-to-prd');
  });

  it('omits x_source when no source is supplied', () => {
    expect(toSkillFrontmatter(dossier({ name: 'idea-to-prd' }))).not.toContain('x_source');
  });
});
