/**
 * `ai-dossier sync-skills` — retroactively generate opencode wrappers for
 * already-installed dossier skills, and prune wrappers whose source is gone.
 *
 * Complements install-skill's auto-sync: use this after installing opencode on
 * a machine that already has dossier skills, or after any manual change to
 * ~/.claude/skills/.
 *
 * Idempotent by design. All writes go through writeOpencodeWrapper, which
 * no-ops when content matches. See opencode-sync.ts for the wrapper policy.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  CLAUDE_SKILLS_DIR,
  isDossierFrontmatter,
  listOpencodeSkills,
  OPENCODE_CONFIG_DIR,
  OPENCODE_SKILLS_DIR,
  opencodeConfigExists,
  removeOpencodeWrapper,
  writeOpencodeWrapper,
} from '../opencode-sync';

interface SyncCounts {
  created: number;
  updated: number;
  unchanged: number;
  skippedYaml: number;
  skippedInvalid: number;
  removed: number;
}

export function registerSyncSkillsCommand(program: Command): void {
  program
    .command('sync-skills')
    .description('Regenerate opencode YAML wrappers for installed dossier skills (idempotent)')
    .option('--dry-run', 'Show what would change without writing anything')
    .option('--no-prune', 'Keep opencode wrappers whose source is gone (default: prune them)')
    .option('--json', 'Output as JSON')
    .action(async (options: { dryRun?: boolean; prune?: boolean; json?: boolean }) => {
      // Default: prune is on. Commander maps --no-prune → prune: false.
      const prune = options.prune !== false;
      const dryRun = options.dryRun === true;

      // Refuse to run if opencode isn't installed — sync-skills exists only to
      // populate ~/.config/opencode/skills/. Fail loud with a fixable message.
      if (!opencodeConfigExists()) {
        const msg = `opencode not found (expected ${OPENCODE_CONFIG_DIR}). Install opencode or create the directory first.`;
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: 'opencode_missing', message: msg }));
        } else {
          console.error(`\n❌ ${msg}\n`);
        }
        process.exit(1);
      }

      if (!fs.existsSync(CLAUDE_SKILLS_DIR)) {
        const msg = `No claude skills to sync (${CLAUDE_SKILLS_DIR} does not exist).`;
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: msg, counts: emptyCounts() }));
        } else {
          console.log(`\nℹ️  ${msg}\n`);
        }
        process.exit(0);
      }

      const claudeEntries = fs
        .readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => fs.existsSync(path.join(CLAUDE_SKILLS_DIR, e.name, 'SKILL.md')))
        .map((e) => e.name);

      const counts = emptyCounts();
      const details: Array<{ skill: string; action: string }> = [];
      const claudeSet = new Set(claudeEntries);

      // Sync each claude skill forward into opencode.
      for (const skillName of claudeEntries) {
        const sourceFile = path.join(CLAUDE_SKILLS_DIR, skillName, 'SKILL.md');
        let raw: string;
        try {
          raw = fs.readFileSync(sourceFile, 'utf8');
        } catch {
          counts.skippedInvalid += 1;
          details.push({ skill: skillName, action: 'skipped-read-error' });
          continue;
        }

        if (!isDossierFrontmatter(raw)) {
          // YAML-native — opencode already reads it directly from ~/.claude/skills/.
          counts.skippedYaml += 1;
          details.push({ skill: skillName, action: 'skipped-yaml' });
          continue;
        }

        if (dryRun) {
          // Simulate: compare against existing wrapper if present.
          const targetFile = path.join(OPENCODE_SKILLS_DIR, skillName, 'SKILL.md');
          const exists = fs.existsSync(targetFile);
          details.push({ skill: skillName, action: exists ? 'would-update' : 'would-create' });
          if (exists) counts.updated += 1;
          else counts.created += 1;
          continue;
        }

        const result = writeOpencodeWrapper(skillName, raw);
        if (result === 'created') counts.created += 1;
        else if (result === 'updated') counts.updated += 1;
        else if (result === 'unchanged') counts.unchanged += 1;
        else if (result === 'skipped') counts.skippedYaml += 1;
        details.push({ skill: skillName, action: result });
      }

      // Prune wrappers whose claude-side source is gone. Users who want to
      // keep hand-written opencode-only skills should pass --no-prune.
      if (prune) {
        const opencodeSkills = listOpencodeSkills();
        for (const skillName of opencodeSkills) {
          if (!claudeSet.has(skillName)) {
            if (dryRun) {
              details.push({ skill: skillName, action: 'would-remove' });
              counts.removed += 1;
            } else if (removeOpencodeWrapper(skillName)) {
              counts.removed += 1;
              details.push({ skill: skillName, action: 'removed' });
            }
          }
        }
      }

      if (options.json) {
        console.log(JSON.stringify({ success: true, dryRun, prune, counts, details }, null, 2));
        process.exit(0);
      }

      const prefix = dryRun ? '🔍 Dry run — no changes written' : '✅ Sync complete';
      console.log(`\n${prefix}\n`);
      console.log(`  created:   ${counts.created}`);
      console.log(`  updated:   ${counts.updated}`);
      console.log(`  unchanged: ${counts.unchanged}`);
      console.log(`  skipped:   ${counts.skippedYaml} (YAML source, no wrapper needed)`);
      if (counts.skippedInvalid > 0) {
        console.log(`  errors:    ${counts.skippedInvalid} (read failed)`);
      }
      console.log(`  removed:   ${counts.removed}${prune ? '' : ' (prune disabled)'}`);
      console.log('');
      process.exit(0);
    });
}

function emptyCounts(): SyncCounts {
  return {
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedYaml: 0,
    skippedInvalid: 0,
    removed: 0,
  };
}
