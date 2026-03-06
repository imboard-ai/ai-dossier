/**
 * Dossier CLI - Main entry point (TypeScript)
 * Sets up Commander program and registers all commands.
 */

import { program } from 'commander';

// Package info
const pkg = require('../package.json');

import { registerCacheCommand } from './commands/cache';
import { registerChecksumCommand } from './commands/checksum';
import { registerCommandsCommand } from './commands/commands';
import { registerConfigCommand } from './commands/config-cmd';
import { registerCreateCommand } from './commands/create';
import { registerExportCommand } from './commands/export';
import { registerFormatCommand } from './commands/format';
import { registerFromFileCommand } from './commands/from-file';
import { registerGetCommand } from './commands/get';
import { registerInfoCommand } from './commands/info';
import { registerInitCommand } from './commands/init';
import { registerInstallSkillCommand } from './commands/install-skill';
import { registerKeysCommand } from './commands/keys';
import { registerLintCommand } from './commands/lint';
import { registerListCommand } from './commands/list';
import { registerLoginCommand } from './commands/login';
import { registerLogoutCommand } from './commands/logout';
import { registerPromptHookCommand } from './commands/prompt-hook';
import { registerPublishCommand } from './commands/publish';
import { registerPullCommand } from './commands/pull';
import { registerRemoveCommand } from './commands/remove';
import { registerResetHooksCommand } from './commands/reset-hooks';
import { registerRunCommand } from './commands/run';
import { registerSearchCommand } from './commands/search';
import { registerSignCommand } from './commands/sign';
import { registerSkillExportCommand } from './commands/skill-export';
import { registerValidateCommand } from './commands/validate';
// Import command registrations
import { registerVerifyCommand } from './commands/verify';
import { registerWhoamiCommand } from './commands/whoami';

// Setup program
program
  .name('ai-dossier')
  .description('CLI tool for creating, verifying, and executing dossiers')
  .version(pkg.version)
  .option('--agent', 'Output machine-readable capability manifest for agent discovery')
  .addHelpText(
    'after',
    '\nAgent-friendly: Run `ai-dossier --agent` for machine-readable capabilities.'
  );

// Register all commands
registerVerifyCommand(program);
registerRunCommand(program);
registerCreateCommand(program);
registerConfigCommand(program);
registerListCommand(program);
registerSearchCommand(program);
registerInfoCommand(program);
registerSignCommand(program);
registerPublishCommand(program);
registerRemoveCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerChecksumCommand(program);
registerValidateCommand(program);
registerInitCommand(program);
registerResetHooksCommand(program);
registerPromptHookCommand(program);
registerPullCommand(program);
registerExportCommand(program);
registerCacheCommand(program);
registerInstallSkillCommand(program);
registerSkillExportCommand(program);
registerKeysCommand(program);
registerLintCommand(program);
registerFormatCommand(program);
registerFromFileCommand(program);
registerGetCommand(program);
registerCommandsCommand(program);

// Handle --agent flag before normal parsing
if (process.argv.includes('--agent')) {
  const manifest = {
    agent_protocol: '1.0',
    cli: 'ai-dossier',
    version: pkg.version,
    discovery_command: 'ai-dossier commands',
    capabilities: {
      json_output: '--json',
      skip_prompts: '-y / --yes',
      non_tty_safe: true,
      machine_errors: true,
      multi_registry: true,
    },
    registry: {
      description:
        'Supports multiple registries queried in parallel. Configure via config command, .dossierrc.json, or DOSSIER_REGISTRY_URL env var.',
      commands: {
        configure: 'ai-dossier config --add-registry <name> --url <url>',
        list_registries: 'ai-dossier config --list-registries --json',
        set_default: 'ai-dossier config --set-default-registry <name>',
      },
      env_vars: [
        'DOSSIER_REGISTRY_URL',
        'DOSSIER_REGISTRY_TOKEN',
        'DOSSIER_REGISTRY_USER',
        'DOSSIER_REGISTRY_ORGS',
      ],
      project_config: '.dossierrc.json',
    },
    quick_start: [
      'ai-dossier commands                    # discover all commands and flags',
      'ai-dossier whoami --json               # check auth status',
      'ai-dossier search <query> --json       # find dossiers',
      'ai-dossier list --json --source registry  # list all registry dossiers',
      'ai-dossier config --list-registries --json  # list configured registries',
      'ai-dossier config --add-registry internal --url https://dossier.company.com  # add registry',
    ],
  };
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

// Parse and execute
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
