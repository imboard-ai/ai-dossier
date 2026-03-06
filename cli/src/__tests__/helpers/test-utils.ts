/**
 * Shared test utilities and factories for CLI tests.
 */

import { Command } from 'commander';

/**
 * Build a valid dossier content string with JSON frontmatter.
 */
export function makeDossier(overrides: Record<string, unknown> = {}): string {
  const frontmatter = {
    dossier_schema_version: '1.0',
    title: 'Test Dossier',
    version: '1.0.0',
    objective: 'Test objective',
    risk_level: 'low',
    status: 'Draft',
    category: ['testing'],
    ...overrides,
  };
  return `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n# Test Dossier\n\nBody content here.\n`;
}

/**
 * Build a YAML frontmatter dossier string.
 */
export function makeDossierYaml(fields: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    title: 'Test Dossier',
    version: '1.0.0',
    risk_level: 'low',
    status: 'Draft',
    ...fields,
  };
  const yaml = Object.entries(defaults)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${yaml}\n---\n\n# Test Dossier\n\nBody content here.\n`;
}

/**
 * Build mock credential objects.
 */
export function makeCredentials(overrides: Record<string, unknown> = {}) {
  return {
    token: 'test-token-abc123',
    username: 'testuser',
    orgs: ['test-org'],
    expiresAt: null as string | null,
    ...overrides,
  };
}

/**
 * Create a Commander program with exitOverride for testing commands.
 * Throws CommanderError instead of calling process.exit.
 */
export function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride();
  // Suppress commander help/error output during tests
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  return program;
}

/**
 * Run a command registered on a test program.
 * Returns output captured in console spies.
 */
export async function runCommand(
  registerFn: (program: Command) => void,
  args: string[]
): Promise<void> {
  const program = createTestProgram();
  registerFn(program);
  await program.parseAsync(['node', 'dossier', ...args]);
}

/**
 * Reusable parseNameVersion mock implementation.
 * Mirrors the real implementation — use with vi.mocked().
 */
export const parseNameVersionImpl = (name: string): [string, string | null] => {
  if (name.includes('@')) {
    const idx = name.lastIndexOf('@');
    return [name.slice(0, idx), name.slice(idx + 1)];
  }
  return [name, null];
};
