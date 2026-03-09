import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import * as config from '../config';
import * as hooks from '../hooks';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize ~/.dossier/ directory, install Claude Code hook and MCP server')
    .option('--skip-hooks', 'Skip installing the Claude Code hook')
    .option('--skip-mcp', 'Skip configuring the MCP server for Claude Code')
    .action((options: { skipHooks?: boolean; skipMcp?: boolean }) => {
      const dossierDir = config.CONFIG_DIR;
      const cacheDir = path.join(dossierDir, 'cache');
      const trustedKeysPath = path.join(dossierDir, 'trusted-keys.txt');

      console.log('\n🔧 Initializing Dossier\n');

      if (fs.existsSync(dossierDir)) {
        console.log(`   ✓ ${dossierDir} already exists`);
      } else {
        fs.mkdirSync(dossierDir, { recursive: true, mode: 0o700 });
        console.log(`   ✓ Created ${dossierDir}`);
      }

      if (fs.existsSync(cacheDir)) {
        console.log(`   ✓ ${cacheDir} already exists`);
      } else {
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        console.log(`   ✓ Created ${cacheDir}`);
      }

      const configFile = config.CONFIG_FILE;
      if (fs.existsSync(configFile)) {
        console.log(`   ✓ ${configFile} already exists`);
      } else {
        config.saveConfig(config.DEFAULT_CONFIG);
        console.log(`   ✓ Created ${configFile}`);
      }

      if (fs.existsSync(trustedKeysPath)) {
        console.log(`   ✓ ${trustedKeysPath} already exists`);
      } else {
        fs.writeFileSync(trustedKeysPath, '', { mode: 0o600 });
        console.log(`   ✓ Created ${trustedKeysPath}`);
      }

      if (options.skipHooks) {
        console.log('   - Skipped Claude Code hook (--skip-hooks)');
      } else {
        const installed = hooks.installClaudeHook();
        if (installed) {
          console.log('   ✓ Installed Claude Code discovery hook');
        } else {
          console.log('   ✓ Claude Code discovery hook already installed');
        }
      }

      if (options.skipMcp) {
        console.log('   - Skipped MCP server configuration (--skip-mcp)');
      } else {
        const result = hooks.installMcpServer();
        if (result === 'installed') {
          console.log('   ✓ Configured MCP server for Claude Code');
        } else if (result === 'already') {
          console.log('   ✓ MCP server already configured');
        } else {
          console.log('   ⚠ Could not configure MCP server automatically');
          console.log('     Run manually: claude mcp add dossier -- npx @ai-dossier/mcp-server');
        }
      }

      console.log('\n✅ Dossier initialized successfully\n');

      // What's next? summary
      console.log("📋 What's next?\n");
      console.log('   Try these commands:');
      console.log('   $ ai-dossier search deploy      Search for dossiers');
      console.log('   $ ai-dossier list                List local dossiers');
      console.log('   $ ai-dossier create my-task      Create a new dossier');
      console.log('');
      if (!options.skipMcp) {
        console.log('   Claude Code can now discover and run dossiers automatically.');
        console.log('   Start a Claude Code session and ask it to list available dossiers.\n');
      }
    });
}
