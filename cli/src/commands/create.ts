import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import * as config from '../config';
import { detectLlm } from '../helpers';
import { multiRegistryGetContent, multiRegistryGetDossier } from '../multi-registry';
import { parseNameVersion } from '../registry-client';

const DEFAULT_CREATE_TEMPLATE = 'imboard-ai/meta/create-dossier';

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

          // Fetch template from registry
          const [dossierName, version] = parseNameVersion(options.template);
          let metaDossierContent = '';

          // Check cache first
          const cacheDir = path.join(os.homedir(), '.dossier', 'cache');
          const dossierCacheDir = path.join(cacheDir, ...dossierName.split('/'));
          let cached = false;

          if (fs.existsSync(dossierCacheDir)) {
            const metaFiles = fs
              .readdirSync(dossierCacheDir)
              .filter((f: string) => f.endsWith('.meta.json'));
            for (const mf of metaFiles) {
              const ver = mf.replace('.meta.json', '');
              if (version && ver !== version) continue;
              const contentFile = path.join(dossierCacheDir, `${ver}.ds.md`);
              if (fs.existsSync(contentFile)) {
                metaDossierContent = fs.readFileSync(contentFile, 'utf8');
                cached = true;
                console.log(`📦 Using cached template: ${dossierName}@${ver}\n`);
                break;
              }
            }
          }

          if (!cached) {
            try {
              let resolvedVersion = version;
              if (!resolvedVersion) {
                const meta = await multiRegistryGetDossier(dossierName);
                resolvedVersion = meta?.version || 'latest';
              }
              const result = await multiRegistryGetContent(dossierName, resolvedVersion);
              if (!result) {
                console.error(`❌ Template not found: ${options.template}`);
                console.error(
                  '   Check the template name or use --template to specify a different one\n'
                );
                process.exit(2);
              }
              metaDossierContent = result.content;
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
${options.template !== DEFAULT_CREATE_TEMPLATE ? `- **Template reference**: ${options.template}` : '- **Template**: Default (create-dossier)'}

**Instructions**: Use the values provided above. For any fields marked "Not specified", prompt the user interactively. When all required information is gathered, create the dossier file according to the meta-dossier instructions below.

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
