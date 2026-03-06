import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DossierFrontmatter, parseDossierContent } from '@ai-dossier/core';
import type { Command } from 'commander';
import * as config from '../config';
import {
  buildLlmCommand,
  detectLlm,
  downloadUrlToTempFile,
  runVerification,
  safeDossierPath,
} from '../helpers';
import { multiRegistryGetContent, multiRegistryGetDossier } from '../multi-registry';
import { parseNameVersion } from '../registry-client';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Verify, audit, and execute dossier')
    .argument('<file>', 'Dossier file, URL, or registry name to run')
    .option('--llm <name>', 'LLM to use (claude-code, auto)')
    .option('--headless', 'Run in headless mode (non-interactive, for CI/CD)')
    .option('--dry-run', 'Show plan without executing')
    .option('--force', 'Skip risk warnings')
    .option('--no-prompt', "Don't ask for confirmation")
    .option('--fresh', 'Skip cache, fetch fresh from registry')
    .option('--pull', 'Update cache before running')
    .option('--skip-checksum', 'Skip checksum verification (DANGEROUS)')
    .option('--skip-all-checks', 'Skip ALL verifications (VERY DANGEROUS)')
    .action(
      async (
        file: string,
        options: {
          llm?: string;
          headless?: boolean;
          dryRun?: boolean;
          force?: boolean;
          noPrompt?: boolean;
          fresh?: boolean;
          pull?: boolean;
          skipChecksum?: boolean;
          skipAllChecks?: boolean;
        }
      ) => {
        let resolvedFile = file;
        const isUrl = file.startsWith('http://') || file.startsWith('https://');
        const isLocalFile = !isUrl && fs.existsSync(path.resolve(file));
        const isNested = process.env.CLAUDE_CODE === '1' || process.env.CLAUDECODE === '1';
        const log = isNested
          ? (...args: unknown[]) => console.error(...args)
          : (...args: unknown[]) => console.log(...args);

        // If not a URL or local file, treat as a registry name
        if (!isUrl && !isLocalFile) {
          const [dossierName, version] = parseNameVersion(file);

          const cacheDir = path.join(os.homedir(), '.dossier', 'cache');
          let cached = false;

          if (!options.fresh) {
            const dossierCacheDir = safeDossierPath(cacheDir, dossierName);
            if (fs.existsSync(dossierCacheDir)) {
              const metaFiles = fs
                .readdirSync(dossierCacheDir)
                .filter((f: string) => f.endsWith('.meta.json'));
              for (const mf of metaFiles) {
                const ver = mf.replace('.meta.json', '');
                if (version && ver !== version) continue;
                const contentFile = path.join(dossierCacheDir, `${ver}.ds.md`);
                if (fs.existsSync(contentFile)) {
                  if (!options.pull) {
                    resolvedFile = contentFile;
                    cached = true;
                    log(`📦 Using cached: ${dossierName}@${ver}\n`);
                    break;
                  }
                }
              }
            }
          }

          if (!cached) {
            try {
              let resolvedVersion = version;
              if (!resolvedVersion) {
                const meta = await multiRegistryGetDossier(dossierName);
                if (!meta) {
                  console.error(`\n❌ Not found: ${file}`);
                  console.error('   Not a local file and not found in any registry\n');
                  process.exit(1);
                }
                resolvedVersion = meta.version || 'latest';
              }
              const result = await multiRegistryGetContent(dossierName, resolvedVersion);
              if (!result) {
                console.error(`\n❌ Not found: ${file}`);
                console.error('   Not a local file and not found in any registry\n');
                process.exit(1);
              }

              if (!options.fresh) {
                const dossierCacheDir = safeDossierPath(cacheDir, dossierName);
                fs.mkdirSync(dossierCacheDir, { recursive: true, mode: 0o700 });
                const contentFile = path.join(dossierCacheDir, `${resolvedVersion}.ds.md`);
                fs.writeFileSync(contentFile, result.content, 'utf8');
                fs.writeFileSync(
                  path.join(dossierCacheDir, `${resolvedVersion}.meta.json`),
                  JSON.stringify(
                    {
                      cached_at: new Date().toISOString(),
                      version: resolvedVersion,
                      source_registry: result._registry,
                    },
                    null,
                    2
                  ),
                  'utf8'
                );
                resolvedFile = contentFile;
                log(`📥 Fetched: ${dossierName}@${resolvedVersion}\n`);
              } else {
                const tmpFile = path.join(os.tmpdir(), `dossier-${Date.now()}.ds.md`);
                fs.writeFileSync(tmpFile, result.content, 'utf8');
                resolvedFile = tmpFile;
                log(`📥 Fetched: ${dossierName}@${resolvedVersion} (not cached)\n`);
              }
            } catch (err: unknown) {
              const e = err as { statusCode?: number; message: string };
              if (e.statusCode === 404) {
                console.error(`\n❌ Not found: ${file}`);
                console.error('   Not a local file and not found in registry\n');
              } else {
                console.error(`\n❌ Failed to fetch: ${e.message}\n`);
              }
              process.exit(1);
            }
          }
        }

        // If resolvedFile is still a URL, download it first
        if (resolvedFile.startsWith('http://') || resolvedFile.startsWith('https://')) {
          try {
            resolvedFile = downloadUrlToTempFile(resolvedFile);
          } catch (err: unknown) {
            console.error(`\n❌ Failed to download: ${(err as Error).message}\n`);
            process.exit(1);
          }
        }

        // TOCTOU mitigation: read the file once and create a private copy.
        // This prevents an attacker from swapping the file between verification
        // and execution (threat T13).
        let dossierContent: string;
        try {
          dossierContent = fs.readFileSync(path.resolve(resolvedFile), 'utf8');
        } catch (err: unknown) {
          console.error(`\n❌ Failed to read dossier: ${(err as Error).message}\n`);
          process.exit(1);
        }

        const secureTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-run-'));
        const secureTmpFile = path.join(secureTmpDir, path.basename(resolvedFile));
        fs.writeFileSync(secureTmpFile, dossierContent, { mode: 0o600 });
        resolvedFile = secureTmpFile;

        // Show metadata summary
        try {
          let fm: DossierFrontmatter | null = null;

          try {
            const parsed = parseDossierContent(dossierContent);
            fm = parsed.frontmatter;
          } catch (err) {
            process.stderr.write(
              `Warning: failed to parse dossier metadata: ${(err as Error).message}\n`
            );
          }

          if (fm && (fm.title || fm.risk_level || fm.objective)) {
            log('📄 Dossier Summary:');
            if (fm.title) log(`   Title:      ${fm.title}`);
            if (fm.version) log(`   Version:    ${fm.version}`);
            if (fm.risk_level) log(`   Risk Level: ${fm.risk_level}`);
            if (fm.objective || fm.description) {
              const obj = (fm.objective || fm.description) as string;
              const snippet = obj.length > 100 ? `${obj.slice(0, 100)}...` : obj;
              log(`   Objective:  ${snippet}`);
            }
            log('');
          }
        } catch (err) {
          process.stderr.write(
            `Warning: failed to read dossier summary: ${(err as Error).message}\n`
          );
        }

        // Nested session detection
        if (process.env.CLAUDE_CODE === '1' || process.env.CLAUDECODE === '1') {
          console.error('ℹ️  Running inside Claude Code — outputting dossier content\n');
          process.stdout.write(dossierContent);
          fs.unlinkSync(secureTmpFile);
          fs.rmdirSync(secureTmpDir);
          process.exit(0);
        }

        const result = await runVerification(resolvedFile, options);

        if (!result.passed) {
          console.log('❌ Verification failed - cannot execute\n');
          fs.unlinkSync(secureTmpFile);
          fs.rmdirSync(secureTmpDir);
          process.exit(1);
        }

        const llmOption =
          options.llm || (config.getConfig('defaultLlm') as string | undefined) || 'auto';

        console.log('📝 Audit Log:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`   Timestamp:   ${new Date().toISOString()}`);
        console.log(`   Dossier:     ${file}`);
        console.log(`   User:        ${process.env.USER}@${os.hostname()}`);
        console.log(`   LLM:         ${llmOption}`);
        console.log(`   Action:      RUN`);
        console.log('   Status:      VERIFIED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        if (options.dryRun) {
          console.log('🧪 DRY RUN MODE - No execution\n');
          console.log('Would execute:');
          console.log(`   File: ${resolvedFile}`);
          console.log(`   LLM: ${llmOption}`);

          const llmToUse = detectLlm(llmOption as string, true);
          console.log(
            `   Command: ${llmToUse ? `claude "${resolvedFile}"` : 'No LLM detected - would show error'}\n`
          );
          console.log('✅ All verifications passed - ready to execute');
          fs.unlinkSync(secureTmpFile);
          fs.rmdirSync(secureTmpDir);
          process.exit(0);
        }

        const cleanupSecureTmp = () => {
          try {
            fs.unlinkSync(secureTmpFile);
          } catch {
            /* already cleaned */
          }
          try {
            fs.rmdirSync(secureTmpDir);
          } catch {
            /* already cleaned */
          }
        };

        console.log('🤖 Executing Dossier...\n');

        const llmToUse = detectLlm(llmOption as string);
        if (!llmToUse) {
          cleanupSecureTmp();
          process.exit(2);
        }

        const descriptor = buildLlmCommand(llmToUse, resolvedFile, options.headless);
        if (!descriptor) {
          console.log(`❌ Unknown LLM: ${llmToUse}\n`);
          console.log('Supported: claude-code, auto\n');
          cleanupSecureTmp();
          process.exit(2);
        }

        try {
          const mode = options.headless ? 'headless' : 'interactive';
          console.log(`   Mode: ${mode}`);
          console.log(`   Executing: ${descriptor.description}\n`);
          const result = spawnSync(descriptor.cmd, descriptor.args, {
            stdio: descriptor.stdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
            input: descriptor.stdin,
          });
          if (result.status !== 0) {
            throw { status: result.status };
          }
          console.log('\n✅ Execution completed');
        } catch (error: unknown) {
          console.log('\n❌ Execution failed');
          cleanupSecureTmp();
          process.exit((error as { status?: number }).status || 2);
        }
        cleanupSecureTmp();
      }
    );
}
