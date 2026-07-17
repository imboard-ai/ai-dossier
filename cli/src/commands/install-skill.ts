import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDossierContent } from '@ai-dossier/core';
import type { Command } from 'commander';
import {
  parseMaxAgeOption,
  readCachedContent,
  resolveCachedVersion,
  writeCachedContent,
} from '../cache-resolver';
import { multiRegistryGetContent } from '../multi-registry';
import {
  isDossierFrontmatter,
  listOpencodeSkills,
  OPENCODE_SKILLS_DIR,
  removeOpencodeWrapper,
  resolveTargets,
  type SyncTarget,
  writeOpencodeWrapper,
} from '../opencode-sync';
import { parseNameVersion } from '../registry-client';

/** Valid values for --for. Anything else is rejected up front. */
const VALID_TARGETS = new Set<SyncTarget>(['claude', 'opencode', 'both']);

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install a registry dossier as a Claude Code skill')
    .argument('[name]', 'Dossier name to install (use name@version for specific version)')
    .option('--force', 'Overwrite if skill already exists')
    .option('--fresh', 'Skip cache, fetch fresh from registry')
    .option(
      '--max-age <seconds>',
      'Max age of cached version resolution before re-checking the registry (default: 300, 0 = always check)'
    )
    .option('--list', 'List currently installed skills')
    .option('--remove <skill>', 'Remove an installed skill')
    .option(
      '--for <target>',
      'Install targets: claude | opencode | both (default: claude + auto-detect opencode)'
    )
    .option('--json', 'Output as JSON')
    .action(
      async (
        name: string | undefined,
        options: {
          force?: boolean;
          fresh?: boolean;
          maxAge?: string;
          list?: boolean;
          remove?: string;
          for?: string;
          json?: boolean;
        }
      ) => {
        const skillsDir = path.join(os.homedir(), '.claude', 'skills');

        // Validate --for early — surfaces typos before any I/O.
        if (options.for && !VALID_TARGETS.has(options.for as SyncTarget)) {
          console.error(
            `\n❌ Invalid --for value: ${options.for}. Must be one of: claude, opencode, both\n`
          );
          process.exit(1);
        }
        const targets = resolveTargets(options.for as SyncTarget | undefined);

        if (options.list) {
          if (!fs.existsSync(skillsDir)) {
            console.log('\nNo installed skills.\n');
            process.exit(0);
          }

          const entries = fs
            .readdirSync(skillsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .filter((e) => fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')));

          if (entries.length === 0) {
            console.log('\nNo installed skills.\n');
            process.exit(0);
          }

          // Cross-reference opencode installs so we can badge dual-installed skills.
          const opencodeInstalled = new Set(listOpencodeSkills());

          console.log(`\n📋 Installed skills (${entries.length}):\n`);
          for (const e of entries) {
            const skillFile = path.join(skillsDir, e.name, 'SKILL.md');
            const content = fs.readFileSync(skillFile, 'utf8');

            let description = '';
            const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (yamlMatch) {
              const descMatch = yamlMatch[1].match(/description:\s*(.+?)(?:\n|$)/);
              if (descMatch) description = descMatch[1].trim();
            }

            const badge = opencodeInstalled.has(e.name) ? ' [claude, opencode]' : ' [claude]';
            console.log(`  ${e.name}${badge}`);
            if (description) {
              const snippet =
                description.length > 80 ? `${description.slice(0, 80)}...` : description;
              console.log(`  ${snippet}`);
            }
            console.log('');
          }
          process.exit(0);
        }

        if (options.remove) {
          const skillDir = path.join(skillsDir, options.remove);
          const claudePresent = fs.existsSync(skillDir);
          const opencodePresent = fs.existsSync(path.join(OPENCODE_SKILLS_DIR, options.remove));

          if (!claudePresent && !opencodePresent) {
            console.error(`\n❌ Skill not found: ${options.remove}\n`);
            process.exit(1);
          }

          if (claudePresent) {
            fs.rmSync(skillDir, { recursive: true, force: true });
          }
          const removedWrapper = removeOpencodeWrapper(options.remove);

          const parts: string[] = [];
          if (claudePresent) parts.push('claude');
          if (removedWrapper) parts.push('opencode');
          console.log(`\n✅ Removed skill: ${options.remove} (${parts.join(', ')})\n`);
          process.exit(0);
        }

        if (!name) {
          console.error(
            '\n❌ Please provide a dossier name to install, or use --list / --remove\n'
          );
          process.exit(1);
        }

        const [dossierName, version] = parseNameVersion(name);
        const skillName = dossierName.split('/').pop() ?? dossierName;
        const skillDir = path.join(skillsDir, skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');

        if (!options.force && fs.existsSync(skillFile)) {
          console.error(`\n❌ Skill '${skillName}' already installed at ${skillDir}`);
          console.error('   Use --force to overwrite\n');
          process.exit(1);
        }

        try {
          let resolvedVersion = version;

          // For versionless installs: resolve which version to use via the TTL'd resolver.
          if (!version) {
            const maxAgeSeconds = parseMaxAgeOption(options.maxAge);
            const resolved = await resolveCachedVersion(dossierName, {
              fresh: options.fresh,
              maxAgeSeconds,
            });
            resolvedVersion = resolved.version;
          }

          let content: string | null = null;
          let fromCache = false;

          if (!options.fresh) {
            const cached = readCachedContent(dossierName, resolvedVersion as string);
            if (cached !== null) {
              content = cached;
              fromCache = true;
            }
          }

          if (!content) {
            const { result: fetchedContent } = await multiRegistryGetContent(
              dossierName,
              resolvedVersion
            );
            if (!fetchedContent) {
              throw { statusCode: 404, message: `Not found: ${dossierName}` };
            }
            content = fetchedContent.content;
            // Write to cache so future installs hit it.
            if (!options.fresh) {
              writeCachedContent(
                dossierName,
                resolvedVersion as string,
                content,
                fetchedContent._registry
              );
            }
          }

          // Write the primary claude skill. Always true today; the flag exists so
          // future flows (e.g. opencode-only refreshes via sync-skills) can opt out.
          if (targets.writeClaude) {
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(skillFile, content, 'utf8');
          }

          // Dual-write the opencode wrapper when requested. YAML-native sources are
          // skipped because opencode reads them directly from ~/.claude/skills/.
          let opencodeResult: 'created' | 'updated' | 'unchanged' | 'skipped' | 'off' = 'off';
          if (targets.writeOpencode) {
            opencodeResult = writeOpencodeWrapper(skillName, content);
          }

          const fileSize = Buffer.byteLength(content, 'utf8');
          let summary = '';
          try {
            const parsed = parseDossierContent(content);
            const fm = parsed.frontmatter as Record<string, unknown>;
            summary = (fm.objective as string) || '';
            if (!summary) {
              const firstLine = parsed.body.split('\n').find((l) => l.trim().length > 0);
              summary = firstLine?.replace(/^#+\s*/, '').trim() || '';
            }
          } catch {
            // Could not parse — skip summary
          }

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  skill: skillName,
                  source: dossierName,
                  version: resolvedVersion || null,
                  location: skillFile,
                  fileSize,
                  summary: summary || null,
                  cached: fromCache,
                  opencode: opencodeResult,
                  opencodeLocation:
                    opencodeResult !== 'off' && opencodeResult !== 'skipped'
                      ? path.join(OPENCODE_SKILLS_DIR, skillName, 'SKILL.md')
                      : null,
                },
                null,
                2
              )
            );
          } else {
            console.log(
              `\n✅ Installed skill '${skillName}'${resolvedVersion ? ` (v${resolvedVersion})` : ''}`
            );
            console.log(`   Location: ${skillFile}`);
            console.log(`   Source: ${dossierName}`);
            console.log(`   Size: ${fileSize} bytes`);
            if (summary) {
              const snippet = summary.length > 80 ? `${summary.slice(0, 80)}...` : summary;
              console.log(`   Summary: ${snippet}`);
            }
            if (opencodeResult === 'created' || opencodeResult === 'updated') {
              console.log(
                `   opencode: ${opencodeResult} at ${path.join(OPENCODE_SKILLS_DIR, skillName, 'SKILL.md')}`
              );
            } else if (opencodeResult === 'unchanged') {
              console.log('   opencode: unchanged (already in sync)');
            } else if (opencodeResult === 'skipped') {
              // Source was YAML-native — opencode reads the claude copy directly.
              console.log('   opencode: source is YAML — no wrapper needed');
            }
            console.log('');
          }
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string };
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: false,
                  error: e.statusCode === 404 ? 'not_found' : 'install_failed',
                  message: e.statusCode === 404 ? `Not found: ${name}` : e.message,
                },
                null,
                2
              )
            );
          } else if (e.statusCode === 404) {
            console.error(`\n❌ Not found in registry: ${name}\n`);
          } else {
            console.error(`\n❌ Install failed: ${e.message}\n`);
          }
          process.exit(1);
        }
      }
    );
}

// Re-export for tests / external tools that want the isDossierFrontmatter check.
export { isDossierFrontmatter };
