/**
 * Guard against two different dossiers claiming the same skill directory.
 *
 * `install-skill` derives the directory with `dossierName.split('/').pop()`, so
 * `imboard-ai/idea-to-prd` and `imboard-ai/pm/idea-to-prd` both resolve to
 * `~/.claude/skills/idea-to-prd`. Whichever was installed last silently replaced the
 * other, with no warning and no way to tell from the filesystem which one you had.
 *
 * Six such collisions existed in the registry at once. Those were cleaned up by
 * deduplicating the registry, but nothing prevented the seventh — any two dossiers
 * sharing a basename collide again the moment both are installed.
 *
 * This makes the overwrite explicit: installing over a *different* dossier requires
 * --force. Reinstalling or upgrading the same one is unaffected, which is the common
 * case and must stay frictionless.
 */

import fs from 'node:fs';
import { parseDossierContent } from '@ai-dossier/core';

export interface CollisionCheck {
  /** True when the directory already holds a dossier from a different source. */
  collides: boolean;
  /** Registry name of whatever currently occupies the directory, when known. */
  existingSource?: string;
}

/**
 * Read the source identity an installed skill records, if any.
 *
 * `install-skill` writes `x_source` into the frontmatter (see below); older installs
 * predate it, so fall back to the dossier's own `name`. Returns undefined when the
 * file is absent or unparseable — an unreadable file is not evidence of a collision,
 * and blocking on it would be worse than the problem.
 */
export function readInstalledSource(skillFile: string): string | undefined {
  if (!fs.existsSync(skillFile)) return undefined;
  try {
    const fm = parseDossierContent(fs.readFileSync(skillFile, 'utf8')).frontmatter as Record<
      string,
      unknown
    >;
    return (fm.x_source as string) ?? (fm.name as string) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether installing `incomingSource` into `skillFile` would clobber a
 * different dossier.
 *
 * Comparison is on the full registry name where available. When the installed copy
 * only records a bare `name` (pre-`x_source` installs), compare against the incoming
 * basename so an upgrade of the same dossier is not mistaken for a collision.
 */
export function checkSkillCollision(skillFile: string, incomingSource: string): CollisionCheck {
  const existing = readInstalledSource(skillFile);
  if (!existing) return { collides: false };

  if (existing === incomingSource) return { collides: false };

  // Legacy install recorded only the basename.
  if (!existing.includes('/')) {
    const incomingBase = incomingSource.split('/').pop();
    return { collides: existing !== incomingBase, existingSource: existing };
  }

  return { collides: true, existingSource: existing };
}

/** Human-readable explanation of a refused install. */
export function collisionMessage(
  skillName: string,
  existingSource: string,
  incomingSource: string,
  skillFile: string
): string {
  return [
    `\n❌ Skill '${skillName}' is already installed from a different dossier.`,
    '',
    `   installed: ${existingSource}`,
    `   incoming:  ${incomingSource}`,
    `   location:  ${skillFile}`,
    '',
    '   Both resolve to the same skill directory because the directory name is the',
    '   last path segment. Installing would silently replace the existing skill.',
    '',
    '   Use --force to replace it, or --remove it first.',
    '',
  ].join('\n');
}
