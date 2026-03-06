import type { Command } from 'commander';
import * as hooks from '../hooks';

export function registerResetHooksCommand(program: Command): void {
  program
    .command('reset-hooks', { hidden: true })
    .description('Remove the Claude Code discovery hook')
    .action(() => {
      const removed = hooks.removeClaudeHook();
      if (removed) {
        console.log('\n✅ Claude Code discovery hook removed\n');
      } else {
        console.log('\nℹ️  No Dossier hook found in Claude Code settings\n');
      }
    });
}
