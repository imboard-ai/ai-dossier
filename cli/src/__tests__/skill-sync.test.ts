import { describe, expect, it } from 'vitest';
import { classify, compareVersions, isSkillDossier, planSync } from '../skill-sync';

describe('skill-sync', () => {
  it('compares versions numerically, not lexically', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.2')).toBeGreaterThan(0);
  });

  it('classifies drift', () => {
    expect(classify('1.0.0', '1.1.0')).toBe('behind');
    expect(classify('1.1.0', '1.1.0')).toBe('current');
    expect(classify('2.0.0', '1.1.0')).toBe('ahead');
    expect(classify(undefined, '1.0.0')).toBe('not-installed');
    expect(classify('1.0.0', undefined)).toBe('current');
  });

  it('defines "skill" by -skill suffix or skill tag', () => {
    expect(isSkillDossier({ name: 'a/b/x-skill' })).toBe(true);
    expect(isSkillDossier({ name: 'a/b/x', tags: ['skill'] })).toBe(true);
    expect(isSkillDossier({ name: 'a/b/x', tags: ['git'] })).toBe(false);
  });

  it('plans --all --outdated: install missing/behind, skip current', () => {
    const items = planSync({
      registry: [
        { name: 'o/a-skill', version: '2.0.0' },
        { name: 'o/b-skill', version: '1.0.0' },
        { name: 'o/c-skill', version: '1.0.0' },
      ],
      installed: [
        { dir: 'a-skill', source: 'o/a-skill', version: '1.0.0' },
        { dir: 'b-skill', source: 'o/b-skill', version: '1.0.0' },
      ],
      skillsDir: '/nonexistent',
      all: true,
      outdated: true,
    });
    expect(items.map((i) => [i.skill, i.action])).toEqual([
      ['a-skill', 'install'],
      ['b-skill', 'skip'],
      ['c-skill', 'install'],
    ]);
  });
});
