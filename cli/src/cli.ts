/**
 * Dossier CLI - Main entry point (TypeScript)
 * Sets up Commander program and registers all commands.
 */

import { program } from 'commander';

// Package info
const pkg = require('../package.json');

import { registerCacheCommand } from './commands/cache';
import { registerChecksumCommand } from './commands/checksum';
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
import { registerValidateCommand } from './commands/validate';
// Import command registrations
import { registerVerifyCommand } from './commands/verify';
import { registerWhoamiCommand } from './commands/whoami';

// Setup program
program
  .name('dossier')
  .description('CLI tool for creating, verifying, and executing dossiers')
  .version(pkg.version);

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
registerKeysCommand(program);
registerLintCommand(program);
registerFormatCommand(program);
registerFromFileCommand(program);
registerGetCommand(program);

// Parse and execute
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
