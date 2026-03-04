import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { safeDossierPath } from '../helpers';
import { getClient, parseNameVersion } from '../registry-client';

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install a registry dossier as a Claude Code skill')
    .argument('[name]', 'Dossier name to install (use name@version for specific version)')
    .option('--force', 'Overwrite if skill already exists')
    .option('--list', 'List currently installed skills')
    .option('--remove <skill>', 'Remove an installed skill')
    .action(
      async (
        name: string | undefined,
        options: { force?: boolean; list?: boolean; remove?: string }
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
                description.length > 80 ? description.slice(0, 80) + '...' : description;
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
        const skillName = dossierName.split('/').pop()!;
        const skillDir = path.join(skillsDir, skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');

        if (!options.force && fs.existsSync(skillFile)) {
          console.error(`\n❌ Skill '${skillName}' already installed at ${skillDir}`);
          console.error('   Use --force to overwrite\n');
          process.exit(1);
        }

        try {
          const cacheDir = path.join(os.homedir(), '.dossier', 'cache');
          let content: string | null = null;
          let resolvedVersion = version;

          if (!version) {
            const dossierCacheDir = safeDossierPath(cacheDir, dossierName);
            if (fs.existsSync(dossierCacheDir)) {
              const metaFiles = fs
                .readdirSync(dossierCacheDir)
                .filter((f) => f.endsWith('.meta.json'));
              if (metaFiles.length > 0) {
                const ver = metaFiles[0].replace('.meta.json', '');
                const contentFile = path.join(dossierCacheDir, `${ver}.ds.md`);
                if (fs.existsSync(contentFile)) {
                  content = fs.readFileSync(contentFile, 'utf8');
                  resolvedVersion = ver;
                }
              }
            }
          } else {
            const contentFile = path.join(
              safeDossierPath(cacheDir, dossierName),
              `${version}.ds.md`
            );
            if (fs.existsSync(contentFile)) {
              content = fs.readFileSync(contentFile, 'utf8');
              resolvedVersion = version;
            }
          }

          if (!content) {
            const client = getClient();
            if (!resolvedVersion) {
              const meta = (await client.getDossier(dossierName)) as any;
              resolvedVersion = meta.version || 'latest';
            }
            const result = await client.getDossierContent(dossierName, resolvedVersion);
            content = result.content;
          }

          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(skillFile, content, 'utf8');

          console.log(
            `\n✅ Installed skill '${skillName}'${resolvedVersion ? ' (v' + resolvedVersion + ')' : ''}`
          );
          console.log(`   Location: ${skillFile}`);
          console.log(`   Source: ${dossierName}\n`);
        } catch (err: any) {
          if (err.statusCode === 404) {
            console.error(`\n❌ Not found in registry: ${name}\n`);
          } else {
            console.error(`\n❌ Install failed: ${err.message}\n`);
          }
          process.exit(1);
        }
      }
    );
}
