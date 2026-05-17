import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import {
  parseMaxAgeOption,
  readCachedContent,
  resolveCachedVersion,
  writeCachedContent,
} from '../cache-resolver';
import * as config from '../config';
import { detectLlm, printRegistryErrors } from '../helpers';
import { multiRegistryGetContent } from '../multi-registry';
import { parseNameVersion } from '../registry-client';

const DEFAULT_CREATE_TEMPLATE = 'imboard-ai/meta/create-dossier-and-skill';

export function registerCreateCommand(program: Command): void {
  program
    .command('create')
    .description('Create new dossier')
    .argument('[file]', 'Output file path')
    .option('--template <name>', 'Registry template dossier to use', DEFAULT_CREATE_TEMPLATE)
    .option('--title <title>', 'Dossier title')
    .option('--objective <text>', 'Primary objective')
    .option('--risk <level>', 'Risk level (low, medium, high, critical)')
    .option('--category <category>', 'Category (devops, data-science, development, etc.)')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--llm <name>', 'LLM to use (claude-code, auto)', 'auto')
    .option(
      '--max-age <seconds>',
      'Max age of cached version resolution before re-checking the registry (default: 300, 0 = always check)'
    )
    .option('--fresh', 'Skip cache, fetch fresh from registry')
    .action(
      async (
        file: string | undefined,
        options: {
          template: string;
          title?: string;
          objective?: string;
          risk?: string;
          category?: string;
          tags?: string;
          llm?: string;
          maxAge?: string;
          fresh?: boolean;
        }
      ) => {
        try {
          const llmOption =
            options.llm || (config.getConfig('defaultLlm') as string | undefined) || 'auto';
          const llm = detectLlm(llmOption, false);

          if (!llm) {
            process.exit(2);
          }

          if (llm !== 'claude-code') {
            console.error(`❌ Unknown LLM: ${llm}\n`);
            console.error('Supported: claude-code, auto\n');
            process.exit(2);
          }

          // Fetch template from registry (with TTL'd version resolution for versionless names)
          const [dossierName, pinnedVersion] = parseNameVersion(options.template);

          let resolvedVersion = pinnedVersion;
          if (!pinnedVersion) {
            let maxAgeSeconds: number | undefined;
            try {
              maxAgeSeconds = parseMaxAgeOption(options.maxAge);
            } catch (err: unknown) {
              console.error(`\n❌ ${(err as Error).message}\n`);
              process.exit(2);
            }
            try {
              const resolved = await resolveCachedVersion(dossierName, {
                fresh: options.fresh,
                maxAgeSeconds,
              });
              resolvedVersion = resolved.version;
            } catch (err: unknown) {
              console.error(`\n❌ ${(err as Error).message}\n`);
              process.exit(2);
            }
          }

          let metaDossierContent = '';
          const cachedContent = !options.fresh
            ? readCachedContent(dossierName, resolvedVersion as string)
            : null;

          if (cachedContent !== null) {
            metaDossierContent = cachedContent;
            console.log(`📦 Using cached template: ${dossierName}@${resolvedVersion}\n`);
          } else {
            try {
              const { result, errors: contentErrors } = await multiRegistryGetContent(
                dossierName,
                resolvedVersion
              );
              if (!result) {
                console.error(`❌ Template not found: ${options.template}`);
                console.error(
                  '   Check the template name or use --template to specify a different one'
                );
                printRegistryErrors(contentErrors);
                console.error('');
                process.exit(2);
              }
              metaDossierContent = result.content;
              if (!options.fresh) {
                writeCachedContent(
                  dossierName,
                  resolvedVersion as string,
                  result.content,
                  result._registry
                );
              }
              console.log(`📥 Fetched template: ${dossierName}@${resolvedVersion}\n`);
            } catch (err: unknown) {
              const e = err as { statusCode?: number; message: string };
              if (e.statusCode === 404) {
                console.error(`❌ Template not found: ${options.template}`);
                console.error(
                  '   Check the template name or use --template to specify a different one\n'
                );
              } else {
                console.error(`❌ Failed to fetch template: ${e.message}\n`);
              }
              process.exit(2);
            }
          }

          const contextHeader = `
# USER-PROVIDED CONTEXT

The user ran the dossier create command with the following parameters:

${file ? `- **Output file**: ${file}` : '- **Output file**: Not specified (prompt user)'}
${options.title ? `- **Title**: ${options.title}` : '- **Title**: Not specified (prompt user)'}
${options.objective ? `- **Objective**: ${options.objective}` : '- **Objective**: Not specified (prompt user)'}
${options.risk ? `- **Risk level**: ${options.risk}` : '- **Risk level**: Not specified (prompt user)'}
${options.category ? `- **Category**: ${options.category}` : '- **Category**: Not specified (prompt user)'}
${options.tags ? `- **Tags**: ${options.tags}` : '- **Tags**: Not specified (optional)'}
${options.template !== DEFAULT_CREATE_TEMPLATE ? `- **Template reference**: ${options.template}` : '- **Template**: Default (create-dossier-and-skill)'}

**Instructions**: Use the values provided above. For any fields marked "Not specified", prompt the user interactively. When all required information is gathered, create both the dossier file and its companion Claude Code skill according to the meta-dossier instructions below.

---

`;

          const tmpFile = path.join(os.tmpdir(), `dossier-create-${Date.now()}.ds.md`);
          fs.writeFileSync(tmpFile, contextHeader + metaDossierContent, 'utf8');

          console.log('🤖 Launching dossier creation assistant (interactive mode)...\n');

          try {
            const result = spawnSync('claude', [tmpFile], { stdio: 'inherit' });
            try {
              fs.unlinkSync(tmpFile);
            } catch (cleanupErr) {
              process.stderr.write(
                `Warning: failed to clean up temp file ${tmpFile}: ${(cleanupErr as Error).message}\n`
              );
            }
            if (result.status !== 0) {
              throw { status: result.status, message: `claude exited with code ${result.status}` };
            }
          } catch (execError) {
            try {
              fs.unlinkSync(tmpFile);
            } catch (cleanupErr) {
              process.stderr.write(
                `Warning: failed to clean up temp file ${tmpFile}: ${(cleanupErr as Error).message}\n`
              );
            }
            throw execError;
          }

          console.log('\n✅ Dossier creation completed');
        } catch (error: unknown) {
          const e = error as { message?: string; status?: number };
          console.error('\n❌ Dossier creation failed');
          console.error(`   Error: ${e.message}`);
          process.exit(e.status || 2);
        }
      }
    );
}
