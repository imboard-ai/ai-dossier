import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ParsedDossier,
  parseDossierContent,
  renderSpecDossier,
  withSkillIdentity,
} from '@ai-dossier/core';
import type { Command } from 'commander';
import { getClientForRegistry } from '../registry-client';
import { writeSourceSidecar } from '../skill-collision';
import { handleRegistryWriteError, requireWriteAuth } from '../write-auth';

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
        const { targetRegistry, credentials } = requireWriteAuth({
          registryFlag: options.registry,
          json: options.json,
          jsonResultKey: 'exported',
        });

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

        let parsed: ParsedDossier;
        try {
          parsed = parseDossierContent(content);
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

        let frontmatter: Record<string, unknown> = parsed.frontmatter;
        const currentVersion = (frontmatter.version as string | undefined) || '0.0.0';
        let newVersion: string;

        if (options.version) {
          newVersion = options.version;
        } else if (options.bump === false) {
          newVersion = currentVersion;
        } else {
          newVersion = bumpVersion(currentVersion, options.major ? 'major' : 'minor');
        }

        // Publish the bytes as they are when nothing needs changing and they are
        // either spec-shaped already or signed (a rewrite would drop the signature).
        // Otherwise write the Agent Skills layout with the new version; a signature
        // covered the old bytes, so it is dropped rather than shipped stale.
        const bumped = newVersion !== currentVersion;
        let droppedSignature = false;
        if (bumped || (parsed.shape === 'legacy' && !frontmatter.signature)) {
          const { x_source: installedFrom, signature, ...unsigned } = frontmatter;
          droppedSignature = signature !== undefined;
          frontmatter = withSkillIdentity({ ...unsigned, version: newVersion }, name);
          try {
            content = renderSpecDossier(frontmatter, parsed.body, parsed);
          } catch (err: unknown) {
            const message = `Cannot write the Agent Skills layout: ${(err as Error).message}`;
            if (options.json) {
              console.log(
                JSON.stringify({ exported: false, error: message, code: 'parse_error' }, null, 2)
              );
            } else {
              console.error(`\n❌ ${message}\n`);
            }
            process.exit(1);
          }
          // Write back to local file so it stays in sync; provenance moves beside it.
          fs.writeFileSync(skillFile, content, 'utf8');
          if (typeof installedFrom === 'string') {
            writeSourceSidecar(skillDir, installedFrom);
          }
        }

        const namespace =
          options.namespace ||
          (credentials.orgs.length > 0 ? credentials.orgs[0] : credentials.username);

        const dossierName = (frontmatter.name as string) || (frontmatter.title as string) || name;
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
        if (droppedSignature && !options.json) {
          console.log(
            "⚠️  Signature dropped: it covered the previous content. Re-sign with 'ai-dossier sign' and publish to ship a signed version.\n"
          );
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
                  signatureDropped: droppedSignature || undefined,
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
          handleRegistryWriteError(err, {
            json: options.json,
            jsonResultKey: 'exported',
            actionLabel: 'Export',
          });
        }
      }
    );
}
