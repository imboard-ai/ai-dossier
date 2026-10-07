/**
 * Planning logic for `install-skill --all` / `--outdated` / `--list`.
 *
 * Everything here is pure or reads only the local skills directory, so the decision of
 * WHAT to install can be tested without a registry. The command layer does the fetching.
 *
 * "Is a skill" has no registry-side flag today, so it is defined explicitly:
 * a dossier is a skill when its basename ends in `-skill` (the publishing convention
 * for trigger skills) or it carries the `skill` tag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseDossierContent } from '@ai-dossier/core';
import { checkSkillCollision, readSourceSidecar } from './skill-collision';

export const SKILL_SUFFIX = '-skill';

export interface RegistrySkill {
  /** Full registry path, e.g. `imboard-ai/skills/full-cycle-issue-skill`. */
  name: string;
  version?: string;
  tags?: string[];
}

export interface InstalledSkill {
  /** Directory name under the skills dir (the basename). */
  dir: string;
  /** Registry path recorded at install time; undefined for legacy installs. */
  source?: string;
  version?: string;
  /**
   * Rendered by a CLI that wrote `x_source` into the frontmatter (before #1136), which
   * breaks a v2 signature; `--outdated` reinstalls it even when the version is current.
   */
  rerender?: boolean;
}

export type SkillStatus = 'current' | 'behind' | 'ahead' | 'not-installed' | 'unknown-source';

export function skillBasename(name: string): string {
  return name.split('/').pop() ?? name;
}

/** Registry owner is the first path segment (`imboard-ai/qa/x` -> `imboard-ai`). */
export function skillOwner(name: string): string {
  return name.split('/')[0] ?? '';
}

export function isSkillDossier(d: RegistrySkill): boolean {
  return skillBasename(d.name).endsWith(SKILL_SUFFIX) || (d.tags ?? []).includes('skill');
}

/**
 * Compare dotted versions numerically, ignoring any pre-release/build suffix.
 * Returns <0, 0, >0. Non-numeric segments compare as 0.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function classify(installed: string | undefined, latest: string | undefined): SkillStatus {
  if (!installed) return 'not-installed';
  if (!latest) return 'current';
  const c = compareVersions(installed, latest);
  return c < 0 ? 'behind' : c > 0 ? 'ahead' : 'current';
}

/** Read every installed skill's recorded source + version. Unreadable files are kept, unsourced. */
export function readInstalledSkills(skillsDir: string): InstalledSkill[] {
  if (!fs.existsSync(skillsDir)) return [];
  const out: InstalledSkill[] = [];
  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(skillsDir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const skill: InstalledSkill = { dir: e.name };
    try {
      const fm = parseDossierContent(fs.readFileSync(file, 'utf8')).frontmatter as Record<
        string,
        unknown
      >;
      // Only a full registry path is provenance; a bare `name` (pre-x_source install) is not.
      // Installs before #1136 may record it only as `x_source` in the frontmatter.
      const source =
        readSourceSidecar(path.dirname(file)) ??
        (typeof fm.x_source === 'string' ? fm.x_source : undefined);
      if (source?.includes('/')) skill.source = source;
      if (fm.x_source !== undefined) skill.rerender = true;
      if (fm.version != null) skill.version = String(fm.version);
    } catch {
      // unreadable frontmatter -> treated as unknown source
    }
    out.push(skill);
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

export interface PlanItem {
  name: string;
  skill: string;
  installedVersion?: string;
  latestVersion?: string;
  action: 'install' | 'skip' | 'collision';
  /** Why the item was skipped or refused. */
  reason?: string;
}

export interface PlanOptions {
  registry: RegistrySkill[];
  installed: InstalledSkill[];
  skillsDir: string;
  owner?: string;
  /** --all: consider every registry skill. Otherwise only installed skills with a source. */
  all: boolean;
  /** --outdated: install only what is missing or BEHIND. Otherwise refresh everything. */
  outdated: boolean;
  force?: boolean;
}

/**
 * Decide, per candidate, whether to install, skip, or refuse.
 *
 * Refused (`collision`) means installing would silently replace a different dossier:
 * either two candidates share a basename, or the target directory holds another source.
 * Those are reported and never written — `--force` only overrides the second kind,
 * because for the first there is no single right answer to force.
 */
export function planSync(opts: PlanOptions): PlanItem[] {
  const { registry, installed, skillsDir, owner, all, outdated, force } = opts;
  const byDir = new Map(installed.map((s) => [s.dir, s]));
  const latestBy = new Map(registry.map((r) => [r.name, r]));
  const inOwner = (n: string) => !owner || skillOwner(n) === owner;

  let candidates: RegistrySkill[];
  if (all) {
    candidates = registry.filter((d) => isSkillDossier(d) && inOwner(d.name));
  } else {
    candidates = [];
    for (const s of installed) {
      if (!s.source || !inOwner(s.source)) continue;
      candidates.push(latestBy.get(s.source) ?? { name: s.source });
    }
  }

  // Basename groups with more than one distinct registry path.
  const groups = new Map<string, string[]>();
  for (const c of candidates) {
    const b = skillBasename(c.name);
    groups.set(b, [...(groups.get(b) ?? []), c.name]);
  }

  const items: PlanItem[] = [];
  for (const c of candidates) {
    const skill = skillBasename(c.name);
    const inst = byDir.get(skill);
    const item: PlanItem = {
      name: c.name,
      skill,
      installedVersion: inst?.version,
      latestVersion: c.version,
      action: 'install',
    };

    const peers = (groups.get(skill) ?? []).filter((n) => n !== c.name);
    if (peers.length > 0) {
      item.action = 'collision';
      item.reason = `basename collides with ${peers.join(', ')}`;
      items.push(item);
      continue;
    }

    if (inst) {
      const occupied = checkSkillCollision(path.join(skillsDir, skill, 'SKILL.md'), c.name);
      if (occupied.collides && !force) {
        item.action = 'collision';
        item.reason = `directory holds ${occupied.existingSource ?? 'another dossier'}`;
        items.push(item);
        continue;
      }
    }

    if (outdated) {
      const status = classify(inst?.version, c.version);
      const rerender = status === 'current' && inst?.rerender;
      if (status !== 'behind' && status !== 'not-installed' && !rerender) {
        item.action = 'skip';
        item.reason = status === 'ahead' ? 'installed is newer than registry' : 'up to date';
      }
    }
    items.push(item);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
