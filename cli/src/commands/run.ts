import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DossierFrontmatter, parseDossierContent } from '@ai-dossier/core';
import type { Command } from 'commander';
import {
  cachedContentPath,
  parseMaxAgeOption,
  type ResolutionSource,
  resolveCachedVersion,
  writeCachedContent,
} from '../cache-resolver';
import * as config from '../config';
import {
  buildLlmCommand,
  detectLlm,
  downloadUrlToTempFile,
  printRegistryNotFoundError,
  runVerification,
} from '../helpers';
import { multiRegistryGetContent } from '../multi-registry';
import { parseNameVersion } from '../registry-client';
import { appendRunLog } from '../run-log';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description(
      'Verify, audit, and execute dossier. Registry names are resolved across all configured registries.'
    )
    .argument('<file>', 'Dossier file, URL, or registry name to run')
    .option('--llm <name>', 'LLM to use (claude-code, auto)')
    .option('--headless', 'Run in headless mode (non-interactive, for CI/CD)')
    .option('--model <name>', 'Model alias/name (forwarded to claude --model)')
    .option(
      '--budget <usd>',
      'Max USD budget (headless only; forwarded to claude --max-budget-usd)',
      parseFloat
    )
    .option(
      '--permission-mode <mode>',
      'Permission mode (headless only; forwarded to claude --permission-mode)'
    )
    .option(
      '--allowed-tools <list>',
      'Comma- or space-separated allowed tools (headless only; forwarded to claude --allowedTools)'
    )
    .option('--dry-run', 'Show plan without executing')
    .option('--force', 'Skip risk warnings')
    .option('--no-prompt', "Don't ask for confirmation")
    .option('--fresh', 'Skip cache, fetch fresh from registry')
    .option('--pull', 'Update cache before running')
    .option(
      '--max-age <seconds>',
      'Max age of cached version resolution before re-checking the registry (default: 300, 0 = always check)'
    )
    .option('--skip-checksum', 'Skip checksum verification (DANGEROUS)')
    .option('--skip-all-checks', 'Skip ALL verifications (VERY DANGEROUS)')
    .action(
      async (
        file: string,
        options: {
          llm?: string;
          headless?: boolean;
          model?: string;
          budget?: number;
          permissionMode?: string;
          allowedTools?: string;
          dryRun?: boolean;
          force?: boolean;
          noPrompt?: boolean;
          fresh?: boolean;
          pull?: boolean;
          maxAge?: string;
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

        const runContext = {
          dossierArg: file,
          resolvedVersion: 'unknown',
          source: 'local' as 'cache' | 'registry' | 'local' | 'url',
          registry: undefined as string | undefined,
          resolutionSource: undefined as
            | 'cache'
            | 'registry'
            | 'stale-cache'
            | 'pinned'
            | undefined,
        };

        // If not a URL or local file, treat as a registry name
        if (!isUrl && !isLocalFile) {
          const [dossierName, pinnedVersion] = parseNameVersion(file);

          // resolvedVersion starts as pinnedVersion (string | null); when null, the
          // resolver below populates it. After that block it's guaranteed non-null.
          let resolvedVersion: string | null = pinnedVersion;
          let resolvedRegistry: string | undefined;
          // `'pinned'` is added locally for name@version requests that bypass the resolver.
          let resolutionSource: ResolutionSource | 'pinned' = 'pinned';

          // For versionless requests: resolve which version to use via the TTL'd resolver.
          // Pinned versions skip resolution — they're content-addressable.
          if (!pinnedVersion) {
            let maxAgeSeconds: number | undefined;
            try {
              maxAgeSeconds = parseMaxAgeOption(options.maxAge);
            } catch (err: unknown) {
              console.error(`\n❌ ${(err as Error).message}\n`);
              process.exit(1);
            }
            try {
              const resolved = await resolveCachedVersion(dossierName, {
                fresh: options.fresh || options.pull,
                maxAgeSeconds,
              });
              resolvedVersion = resolved.version;
              resolvedRegistry = resolved.registry;
              resolutionSource = resolved.source;
            } catch (err: unknown) {
              console.error(`\n❌ ${(err as Error).message}\n`);
              process.exit(1);
            }
          }

          const contentFile = cachedContentPath(dossierName, resolvedVersion as string);
          const haveCachedContent = !options.fresh && !options.pull && fs.existsSync(contentFile);

          runContext.resolutionSource = resolutionSource;

          if (haveCachedContent) {
            resolvedFile = contentFile;
            runContext.source = 'cache';
            runContext.resolvedVersion = resolvedVersion as string;
            runContext.registry = resolvedRegistry;
            // Make the resolution path explicit so users can tell:
            //   - "cache hit, fresh resolution" (resolver hit registry, content already on disk)
            //   - "cache hit, TTL'd resolution" (resolver served from resolution cache)
            //   - "cache hit, STALE resolution" (registry was unreachable; resolver fell back)
            //   - "pinned version" (no resolution involved)
            let suffix = '';
            if (resolutionSource === 'stale-cache') {
              suffix = ' (version resolution is STALE — registry was unreachable)';
            } else if (resolutionSource === 'cache') {
              suffix = ' (version resolution from TTL cache; pass --max-age 0 to recheck)';
            } else if (resolutionSource === 'registry') {
              suffix = ' (version freshly resolved from registry)';
            }
            log(`📦 Using cached: ${dossierName}@${resolvedVersion}${suffix}\n`);
          } else {
            try {
              const { result, errors: contentErrors } = await multiRegistryGetContent(
                dossierName,
                resolvedVersion
              );
              if (!result) {
                printRegistryNotFoundError(file, contentErrors);
                process.exit(1);
              }

              if (!options.fresh) {
                writeCachedContent(
                  dossierName,
                  resolvedVersion as string,
                  result.content,
                  result._registry,
                  { throwOnError: true }
                );
                resolvedFile = contentFile;
                // "Refreshed" earlier was misleading: resolver served from cache, but the *content*
                // was newly downloaded. Be explicit about both axes.
                if (resolutionSource === 'cache') {
                  log(
                    `📥 Fetched content for ${dossierName}@${resolvedVersion} (version resolution from TTL cache)\n`
                  );
                } else {
                  log(`📥 Fetched: ${dossierName}@${resolvedVersion}\n`);
                }
              } else {
                const tmpFile = path.join(os.tmpdir(), `dossier-${Date.now()}.ds.md`);
                fs.writeFileSync(tmpFile, result.content, 'utf8');
                resolvedFile = tmpFile;
                log(`📥 Fetched: ${dossierName}@${resolvedVersion} (not cached)\n`);
              }
              runContext.source = 'registry';
              runContext.resolvedVersion = resolvedVersion as string;
              runContext.registry = result._registry;
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
          runContext.source = 'url';
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

          const llmOption =
            options.llm || (config.getConfig('defaultLlm') as string | undefined) || 'auto';
          appendRunLog({
            timestamp: new Date().toISOString(),
            dossier: file,
            resolved_version: runContext.resolvedVersion,
            source: runContext.source,
            registry: runContext.registry,
            resolution_source: runContext.resolutionSource,
            verification: 'nested-skip',
            llm: llmOption,
            user: `${process.env.USER || 'unknown'}@${os.hostname()}`,
            cwd: process.cwd(),
            nested: true,
          });

          process.stdout.write(dossierContent);
          fs.unlinkSync(secureTmpFile);
          fs.rmdirSync(secureTmpDir);
          process.exit(0);
        }

        const result = await runVerification(resolvedFile, options);

        const llmOption =
          options.llm || (config.getConfig('defaultLlm') as string | undefined) || 'auto';

        if (!result.passed) {
          console.log('❌ Verification failed - cannot execute\n');
          appendRunLog({
            timestamp: new Date().toISOString(),
            dossier: file,
            resolved_version: runContext.resolvedVersion,
            source: runContext.source,
            registry: runContext.registry,
            resolution_source: runContext.resolutionSource,
            verification: 'failed',
            llm: llmOption,
            user: `${process.env.USER || 'unknown'}@${os.hostname()}`,
            cwd: process.cwd(),
            nested: false,
          });
          fs.unlinkSync(secureTmpFile);
          fs.rmdirSync(secureTmpDir);
          process.exit(1);
        }

        appendRunLog({
          timestamp: new Date().toISOString(),
          dossier: file,
          resolved_version: runContext.resolvedVersion,
          source: runContext.source,
          registry: runContext.registry,
          resolution_source: runContext.resolutionSource,
          verification: options.skipAllChecks ? 'skipped' : 'passed',
          llm: llmOption,
          user: `${process.env.USER || 'unknown'}@${os.hostname()}`,
          cwd: process.cwd(),
          nested: false,
        });

        console.log('📝 Audit Log:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`   Timestamp:   ${new Date().toISOString()}`);
        console.log(`   Dossier:     ${file}`);
        console.log(`   User:        ${process.env.USER}@${os.hostname()}`);
        console.log(`   LLM:         ${llmOption}`);
        console.log(`   Action:      RUN`);
        console.log('   Status:      VERIFIED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        if (
          !options.headless &&
          (options.budget != null || options.permissionMode || options.allowedTools)
        ) {
          process.stderr.write(
            'Warning: --budget, --permission-mode, and --allowed-tools require --headless (claude -p) and will be ignored in interactive mode.\n'
          );
        }

        if (options.dryRun) {
          console.log('🧪 DRY RUN MODE - No execution\n');
          console.log('Would execute:');
          console.log(`   File: ${resolvedFile}`);
          console.log(`   LLM: ${llmOption}`);

          const llmToUse = detectLlm(llmOption as string, true);
          const passthrough = {
            model: options.model,
            budget: options.budget,
            permissionMode: options.permissionMode,
            allowedTools: options.allowedTools,
          };
          const descriptor = llmToUse
            ? buildLlmCommand(llmToUse, resolvedFile, options.headless, passthrough)
            : null;
          console.log(
            `   Command: ${
              descriptor ? descriptor.description : 'No LLM detected - would show error'
            }\n`
          );
          console.log('✅ All verifications passed - ready to execute');
          fs.unlinkSync(secureTmpFile);
          fs.rmdirSync(secureTmpDir);
          process.exit(0);
        }

        const cleanupSecureTmp = () => {
          try {
            fs.unlinkSync(secureTmpFile);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              process.stderr.write(
                `Warning: failed to clean up secure temp file: ${String((err as Error).message || err)}\n`
              );
            }
          }
          try {
            fs.rmdirSync(secureTmpDir);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              process.stderr.write(
                `Warning: failed to clean up secure temp dir: ${String((err as Error).message || err)}\n`
              );
            }
          }
        };

        console.log('🤖 Executing Dossier...\n');

        const llmToUse = detectLlm(llmOption as string);
        if (!llmToUse) {
          cleanupSecureTmp();
          process.exit(2);
        }

        const descriptor = buildLlmCommand(llmToUse, resolvedFile, options.headless, {
          model: options.model,
          budget: options.budget,
          permissionMode: options.permissionMode,
          allowedTools: options.allowedTools,
        });
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
