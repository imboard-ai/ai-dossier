/**
 * `ai-dossier doctor` — diagnostic command that checks the user's setup.
 *
 * Reports pass/fail/warning for:
 *   - Node.js version (>=20 required)
 *   - Package installation (@ai-dossier/cli, core, mcp-server)
 *   - MCP configuration (~/.claude/mcp.json has dossier entry)
 *   - Dossier files in the current project (*.ds.md)
 *   - Claude Code CLI availability
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  detail?: string;
}

// ── Individual checks ────────────────────────────────────────────────────────

export function checkNodeVersion(): CheckResult {
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 20) {
    return {
      name: 'Node.js version',
      status: 'pass',
      message: `v${process.versions.node} (>=20 required)`,
    };
  }
  return {
    name: 'Node.js version',
    status: 'fail',
    message: `v${process.versions.node} — Node.js >=20 is required`,
    detail: 'Upgrade Node.js: https://nodejs.org/',
  };
}

/**
 * Check whether an npm package is resolvable from the CLI's own node_modules.
 */
function isPackageInstalled(packageName: string): boolean {
  try {
    require.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to read a package's version from its package.json. Exported for reuse
 * by `engine-version.ts` (#537) — same require.resolve + walk-up-to-package.json
 * logic, no need to duplicate it.
 */
export function getPackageVersion(packageName: string): string | null {
  try {
    const entryPath = require.resolve(packageName);
    // Walk up to find the package.json
    let dir = path.dirname(entryPath);
    for (let i = 0; i < 10; i++) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg.name === packageName) {
          return pkg.version ?? null;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // not installed
  }
  return null;
}

export function checkPackageInstalled(packageName: string): CheckResult {
  const installed = isPackageInstalled(packageName);
  const version = installed ? getPackageVersion(packageName) : null;
  if (installed) {
    return {
      name: packageName,
      status: 'pass',
      message: version ? `v${version} installed` : 'installed',
    };
  }
  return {
    name: packageName,
    status: 'fail',
    message: 'not installed',
    detail: `Install with: npm install -g ${packageName}`,
  };
}

export function checkMcpConfig(): CheckResult {
  const mcpPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.claude',
    'mcp.json'
  );

  if (!fs.existsSync(mcpPath)) {
    return {
      name: 'MCP configuration',
      status: 'warn',
      message: `${mcpPath} not found`,
      detail: 'Run: ai-dossier init',
    };
  }

  try {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (config.mcpServers?.dossier) {
      return {
        name: 'MCP configuration',
        status: 'pass',
        message: 'dossier server configured in mcp.json',
      };
    }
    return {
      name: 'MCP configuration',
      status: 'warn',
      message: 'mcp.json exists but dossier server not configured',
      detail: 'Run: ai-dossier init',
    };
  } catch {
    return {
      name: 'MCP configuration',
      status: 'warn',
      message: 'mcp.json exists but could not be parsed',
      detail: 'Check file for JSON syntax errors',
    };
  }
}

export function checkDossierFiles(cwd: string): CheckResult {
  const files = findDsMdFiles(cwd);
  if (files.length > 0) {
    const noun = files.length === 1 ? 'dossier file' : 'dossier files';
    return {
      name: 'Dossier files',
      status: 'pass',
      message: `${files.length} ${noun} found in current project`,
    };
  }
  return {
    name: 'Dossier files',
    status: 'warn',
    message: 'no .ds.md files found in current directory',
    detail: 'Create one with: ai-dossier create my-task',
  };
}

/**
 * Non-recursive search for .ds.md files in a directory (skips node_modules and dot-dirs).
 */
function findDsMdFiles(dir: string, maxDepth = 3, currentDepth = 0): string[] {
  if (currentDepth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.ds.md')) {
        results.push(fullPath);
      } else if (entry.isDirectory() && currentDepth < maxDepth) {
        results.push(...findDsMdFiles(fullPath, maxDepth, currentDepth + 1));
      }
    }
  } catch {
    // permission error or similar — skip silently
  }
  return results;
}

export function checkClaudeCli(): CheckResult {
  try {
    execFileSync('which', ['claude'], { stdio: 'pipe' });
    return {
      name: 'Claude Code CLI',
      status: 'pass',
      message: 'claude command found on PATH',
    };
  } catch {
    return {
      name: 'Claude Code CLI',
      status: 'warn',
      message: 'claude command not found on PATH',
      detail: 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code',
    };
  }
}

// ── Main runner ──────────────────────────────────────────────────────────────

export function runAllChecks(cwd: string): CheckResult[] {
  return [
    checkNodeVersion(),
    checkPackageInstalled('@ai-dossier/cli'),
    checkPackageInstalled('@ai-dossier/core'),
    checkPackageInstalled('@ai-dossier/mcp-server'),
    checkMcpConfig(),
    checkDossierFiles(cwd),
    checkClaudeCli(),
  ];
}

function statusIcon(status: CheckResult['status']): string {
  switch (status) {
    case 'pass':
      return '\u2713'; // checkmark
    case 'fail':
      return '\u2717'; // cross
    case 'warn':
      return '!'; // exclamation
  }
}

function statusLabel(status: CheckResult['status']): string {
  switch (status) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'FAIL';
    case 'warn':
      return 'warn';
  }
}

export function formatResults(results: CheckResult[]): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('ai-dossier doctor');
  lines.push('');

  for (const r of results) {
    lines.push(`  ${statusIcon(r.status)} [${statusLabel(r.status)}] ${r.name}: ${r.message}`);
    if (r.detail) {
      lines.push(`           ${r.detail}`);
    }
  }

  const passes = results.filter((r) => r.status === 'pass').length;
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;

  lines.push('');
  lines.push(`${passes} passed, ${warns} warnings, ${fails} failed`);

  if (fails > 0) {
    lines.push('');
    lines.push('Fix the failures above to ensure ai-dossier works correctly.');
  }

  lines.push('');

  return lines.join('\n');
}

// ── Command registration ────────────────────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check your environment for common ai-dossier setup issues')
    .option('--json', 'Output results as JSON')
    .action((options: { json?: boolean }) => {
      const results = runAllChecks(process.cwd());

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(formatResults(results));
      }

      const hasFails = results.some((r) => r.status === 'fail');
      if (hasFails) {
        process.exit(1);
      }
    });
}
