import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import * as config from '../config';
import { detectLlm, REPO_ROOT } from '../helpers';

export function registerCreateCommand(program: Command): void {
  program
    .command('create')
    .description('Create new dossier')
    .argument('[file]', 'Output file path')
    .option('--template <name>', 'Reference template/example to use as pattern')
    .option('--title <title>', 'Dossier title')
    .option('--objective <text>', 'Primary objective')
    .option('--risk <level>', 'Risk level (low, medium, high, critical)')
    .option('--category <category>', 'Category (devops, data-science, development, etc.)')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--llm <name>', 'LLM to use (claude-code, cursor, auto)', 'auto')
    .action(async (file: string | undefined, options: any) => {
      try {
        const llmOption = options.llm || config.getConfig('defaultLlm') || 'auto';
        const llm = detectLlm(llmOption, false);

        if (!llm) {
          process.exit(2);
        }

        const metaDossierPath = path.join(
          REPO_ROOT,
          'examples',
          'authoring',
          'create-dossier.ds.md'
        );

        if (!fs.existsSync(metaDossierPath)) {
          console.error('❌ Error: Meta-dossier not found');
          console.error(`   Expected: ${metaDossierPath}`);
          console.error('\nThis is likely a package installation issue.');
          console.error('Please report this at: https://github.com/imboard-ai/dossier/issues\n');
          process.exit(2);
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
${options.template ? `- **Template reference**: ${options.template}` : '- **Template**: Not specified (use default structure)'}

**Instructions**: Use the values provided above. For any fields marked "Not specified", prompt the user interactively. When all required information is gathered, create the dossier file according to the meta-dossier instructions below.

---

`;

        const metaDossierContent = fs.readFileSync(metaDossierPath, 'utf8');

        const tmpFile = path.join(os.tmpdir(), `dossier-create-${Date.now()}.ds.md`);
        fs.writeFileSync(tmpFile, contextHeader + metaDossierContent, 'utf8');

        console.log('🤖 Launching dossier creation assistant (interactive mode)...\n');

        if (llm !== 'claude-code') {
          console.log(`❌ Unknown LLM: ${llm}\n`);
          console.log('Supported: claude-code, auto\n');
          try {
            fs.unlinkSync(tmpFile);
          } catch {}
          process.exit(2);
        }

        try {
          const result = spawnSync('claude', [tmpFile], { stdio: 'inherit' });
          try {
            fs.unlinkSync(tmpFile);
          } catch {}
          if (result.status !== 0) {
            throw { status: result.status, message: `claude exited with code ${result.status}` };
          }
        } catch (execError) {
          try {
            fs.unlinkSync(tmpFile);
          } catch {}
          throw execError;
        }

        console.log('\n✅ Dossier creation completed');
      } catch (error: any) {
        console.error('\n❌ Dossier creation failed');
        console.error(`   Error: ${error.message}`);
        process.exit(error.status || 2);
      }
    });
}
