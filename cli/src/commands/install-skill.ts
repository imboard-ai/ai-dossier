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
import { parseNameVersion } from '../registry-client';

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
          json?: boolean;
        }
      ) => {
        const skillsDir = path.join(os.homedir(), '.claude', 'skills');

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

            console.log(`  ${e.name}`);
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
          if (!fs.existsSync(skillDir)) {
            console.error(`\n❌ Skill not found: ${options.remove}\n`);
            process.exit(1);
          }
          fs.rmSync(skillDir, { recursive: true, force: true });
          console.log(`\n✅ Removed skill: ${options.remove}\n`);
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

          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(skillFile, content, 'utf8');

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
