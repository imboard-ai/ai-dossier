import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DossierFrontmatter, parseDossierContent } from '@ai-dossier/core';
import type { Command } from 'commander';
import { resolveWriteRegistry } from '../config';
import { isExpired, loadCredentials } from '../credentials';
import { getClientForRegistry } from '../registry-client';

function bumpVersion(current: string, bump: 'minor' | 'major'): string {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    // Can't bump non-semver, return as-is
    return current;
  }
  if (bump === 'major') {
    return `${parts[0] + 1}.0.0`;
  }
  return `${parts[0]}.${parts[1] + 1}.0`;
}

function replaceVersion(content: string, oldVersion: string, newVersion: string): string {
  // Replace version in frontmatter section only (between first --- delimiters)
  const versionPattern = new RegExp(
    `(["']?version["']?\\s*[:=]\\s*["']?)${oldVersion.replace(/\./g, '\\.')}(["']?)`,
    'm'
  );
  return content.replace(versionPattern, `$1${newVersion}$2`);
}

export function registerSkillExportCommand(program: Command): void {
  program
    .command('skill-export')
    .description('Publish a locally installed skill to the registry')
    .argument('<name>', 'Skill name (directory name under ~/.claude/skills/)')
    .option('--namespace <namespace>', 'Registry namespace (default: first org or username)')
    .option('--major', 'Bump major version instead of minor')
    .option('--version <version>', 'Set explicit version (e.g., 2.0.0)')
    .option('--no-bump', 'Publish without version bump')
    .option('--changelog <message>', 'Changelog message')
    .option('--verify', 'Re-install after publish to verify roundtrip')
    .option('--registry <name>', 'Target registry to publish to')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(
      async (
        name: string,
        options: {
          namespace?: string;
          major?: boolean;
          version?: string;
          bump?: boolean;
          changelog?: string;
          verify?: boolean;
          registry?: string;
          yes?: boolean;
          json?: boolean;
        }
      ) => {
        let targetRegistry: import('../config').ResolvedRegistry;
        try {
          targetRegistry = resolveWriteRegistry(options.registry);
        } catch (err: unknown) {
          console.error(`\n❌ ${(err as Error).message}\n`);
          process.exit(1);
        }

        const credentials = loadCredentials(targetRegistry.name);
        if (!credentials) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { exported: false, error: 'Not logged in', code: 'not_logged_in' },
                null,
                2
              )
            );
          } else {
            console.error(
              `\n❌ Not logged in to registry '${targetRegistry.name}'. Run \`dossier login --registry ${targetRegistry.name}\` first.\n`
            );
          }
          process.exit(1);
        }
        if (isExpired(credentials)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { exported: false, error: 'Credentials expired', code: 'expired' },
                null,
                2
              )
            );
          } else {
            console.error('\n❌ Credentials expired. Run `dossier login` to re-authenticate.\n');
          }
          process.exit(1);
        }

        const skillsDir = path.join(os.homedir(), '.claude', 'skills');
        const skillDir = path.join(skillsDir, name);
        const skillFile = path.join(skillDir, 'SKILL.md');

        if (!fs.existsSync(skillFile)) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { exported: false, error: `Skill '${name}' not found`, code: 'not_found' },
                null,
                2
              )
            );
          } else {
            console.error(`\n❌ Skill '${name}' not found at ${skillDir}\n`);
            console.error('   Installed skills:');
            if (fs.existsSync(skillsDir)) {
              const entries = fs
                .readdirSync(skillsDir, { withFileTypes: true })
                .filter(
                  (e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md'))
                );
              for (const e of entries) {
                console.error(`   - ${e.name}`);
              }
            }
            console.error('');
          }
          process.exit(1);
        }

        let content = fs.readFileSync(skillFile, 'utf8');

        let frontmatter: DossierFrontmatter;
        try {
          const parsed = parseDossierContent(content);
          frontmatter = parsed.frontmatter;
        } catch (err: unknown) {
          if (options.json) {
            console.log(
              JSON.stringify(
                { exported: false, error: (err as Error).message, code: 'parse_error' },
                null,
                2
              )
            );
          } else {
            console.error(`\n❌ Failed to parse skill: ${(err as Error).message}\n`);
          }
          process.exit(1);
        }

        const currentVersion = frontmatter.version || '0.0.0';
        let newVersion: string;

        if (options.version) {
          newVersion = options.version;
        } else if (options.bump === false) {
          newVersion = currentVersion;
        } else {
          newVersion = bumpVersion(currentVersion, options.major ? 'major' : 'minor');
        }

        // Update version in content if it changed
        if (newVersion !== currentVersion) {
          content = replaceVersion(content, currentVersion, newVersion);
          // Write back to local file so it stays in sync
          fs.writeFileSync(skillFile, content, 'utf8');
        }

        const namespace =
          options.namespace ||
          (credentials.orgs.length > 0 ? credentials.orgs[0] : credentials.username);

        const dossierName = frontmatter.name || frontmatter.title || name;
        const fullPath = `${namespace}/${dossierName}`;

        if (!options.yes && !options.json) {
          console.log('\n📦 Exporting skill to registry:\n');
          console.log(`   Skill:     ${name}`);
          console.log(`   Registry:  ${fullPath}@${newVersion}`);
          if (newVersion !== currentVersion) {
            console.log(`   Version:   ${currentVersion} → ${newVersion}`);
          }
          if (options.changelog) {
            console.log(`   Changelog: ${options.changelog}`);
          }
          console.log('');
        }

        try {
          const client = getClientForRegistry(targetRegistry.url, credentials.token);
          const result = await client.publishDossier(
            namespace,
            content,
            options.changelog || `Exported from local skill '${name}'`
          );

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  exported: true,
                  skill: name,
                  name: result.name || fullPath,
                  version: newVersion,
                  previousVersion: currentVersion !== newVersion ? currentVersion : undefined,
                  content_url: result.content_url || null,
                },
                null,
                2
              )
            );
          } else {
            console.log(`✅ Exported ${fullPath}@${newVersion}`);
            if (result.content_url) {
              console.log(`   URL: ${result.content_url}`);
            }
          }

          // Verify roundtrip
          if (options.verify) {
            if (!options.json) {
              console.log('\n🔄 Verifying roundtrip...');
            }
            try {
              const downloaded = await client.getDossierContent(fullPath, newVersion);
              if (downloaded.content === content) {
                if (options.json) {
                  // Already printed main JSON above
                } else {
                  console.log('   ✅ Roundtrip verified — registry content matches local');
                }
              } else {
                if (!options.json) {
                  console.log('   ⚠️  Content differs — registry may have normalized the content');
                }
              }
            } catch (verifyErr: unknown) {
              if (!options.json) {
                console.log(`   ⚠️  Verification failed: ${(verifyErr as Error).message}`);
                console.log(
                  `   CDN propagation may take a few seconds. Try: dossier info ${fullPath}`
                );
              }
            }
          }

          if (!options.json) {
            console.log('');
          }
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string; code?: string };
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  exported: false,
                  error: e.message,
                  code: e.code || 'export_failed',
                },
                null,
                2
              )
            );
          } else if (e.statusCode === 401) {
            console.error('\n❌ Session expired. Run `dossier login` to re-authenticate.\n');
          } else if (e.statusCode === 403) {
            console.error(`\n❌ Permission denied: ${e.message}\n`);
          } else if (e.statusCode === 409) {
            console.error(`\n❌ Version conflict: ${fullPath}@${newVersion} — ${e.message}\n`);
          } else {
            console.error(`\n❌ Export failed: ${e.message}\n`);
          }
          process.exit(1);
        }
      }
    );
}
