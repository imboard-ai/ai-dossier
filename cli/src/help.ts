/**
 * Custom grouped help formatter for Commander.
 * Groups commands by category instead of a flat list.
 */

import type { Command, Help } from 'commander';

const CATEGORIES: Array<{ name: string; commands: string[] }> = [
  { name: 'Getting Started', commands: ['init', 'create', 'from-file'] },
  { name: 'Verify & Run', commands: ['verify', 'run', 'validate', 'lint', 'format'] },
  {
    name: 'Registry',
    commands: ['search', 'list', 'info', 'get', 'pull', 'export', 'publish', 'remove'],
  },
  { name: 'Skills', commands: ['install-skill', 'skill-export'] },
  { name: 'Security', commands: ['sign', 'checksum', 'keys'] },
  { name: 'Auth & Config', commands: ['login', 'logout', 'whoami', 'config', 'cache'] },
];

export function formatHelpGrouped(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth || 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2;

  function formatItem(term: string, description: string): string {
    if (description) {
      const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
      return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
    }
    return term;
  }

  function formatList(items: string[]): string {
    return items.join('\n').replace(/^/gm, ' '.repeat(itemIndentWidth));
  }

  let output = '';

  // Usage
  output += `Usage: ${helper.commandUsage(cmd)}\n\n`;

  // Description
  const desc = helper.commandDescription(cmd);
  if (desc) {
    output += `${desc}\n\n`;
  }

  // Build command map from visible commands
  const visibleCommands = helper.visibleCommands(cmd);
  const commandMap = new Map<string, Command>();
  for (const sub of visibleCommands) {
    commandMap.set(sub.name(), sub);
  }

  // Grouped commands by category
  const categorized = new Set<string>();
  for (const category of CATEGORIES) {
    const items: string[] = [];
    for (const name of category.commands) {
      const sub = commandMap.get(name);
      if (sub) {
        items.push(formatItem(helper.subcommandTerm(sub), helper.subcommandDescription(sub)));
        categorized.add(name);
      }
    }
    if (items.length > 0) {
      output += `${category.name}:\n`;
      output += `${formatList(items)}\n\n`;
    }
  }

  // "Other" catch-all for uncategorized visible commands (e.g. help)
  const otherItems: string[] = [];
  for (const sub of visibleCommands) {
    if (!categorized.has(sub.name())) {
      otherItems.push(formatItem(helper.subcommandTerm(sub), helper.subcommandDescription(sub)));
    }
  }
  if (otherItems.length > 0) {
    output += 'Other:\n';
    output += `${formatList(otherItems)}\n\n`;
  }

  // Options
  const optionItems: string[] = [];
  for (const opt of helper.visibleOptions(cmd)) {
    optionItems.push(formatItem(helper.optionTerm(opt), helper.optionDescription(opt)));
  }
  if (optionItems.length > 0) {
    output += 'Options:\n';
    output += `${formatList(optionItems)}\n\n`;
  }

  return output;
}
