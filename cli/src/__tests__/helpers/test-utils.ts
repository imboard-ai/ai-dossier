/**
 * Shared test utilities and factories for CLI tests.
 */

import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { vi } from 'vitest';

const mockedExec = vi.mocked(execFileSync);

/**
 * `execFileSync` is overloaded, and the overload `vi.mocked` resolves to returns a Buffer
 * — but every call site under test passes `encoding: 'utf8'` and therefore gets a string.
 * Stubs go through these two helpers so the one unavoidable cast lives in a single place
 * instead of an `as never` at every `mockReturnValue`. (The test file must still call
 * `vi.mock('node:child_process')` — the mock is file-scoped.)
 */
export type ExecStub = (file: string, args: string[]) => string;

/** Every command invocation returns `stdout`. */
export function execReturns(stdout: string): void {
  mockedExec.mockReturnValue(stdout as unknown as ReturnType<typeof execFileSync>);
}

/** Dispatch on the command being run — throw from `stub` to simulate a non-zero exit. */
export function execHandles(stub: ExecStub): void {
  mockedExec.mockImplementation(stub as unknown as typeof execFileSync);
}

/** Commander's exitOverride throws a CommanderError, which carries a `code` string. */
function isCommanderError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/**
 * Run a command tree and return the exit code the action asked for.
 *
 * The shared test setup replaces `process.exit` with a throw of
 * `process.exit(<code>)`, and `createTestProgram` puts commander in exitOverride mode —
 * so both kinds of exit surface here as exceptions rather than killing the runner.
 */
export async function runCommandTree(
  register: (program: Command) => void,
  args: string[]
): Promise<number | undefined> {
  const program = createTestProgram();
  register(program);
  try {
    await program.parseAsync(['node', 'dossier', ...args]);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const exit = /^process\.exit\((\d+)\)$/.exec(message);
    if (exit) return Number(exit[1]);
    if (isCommanderError(err)) return undefined;
    throw err;
  }
  return undefined;
}

/** console.log lines captured by the shared setup's spies. */
export function logged(): string[] {
  return vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .filter((s) => s !== 'undefined');
}

/** console.error lines captured by the shared setup's spies. */
export function errored(): string[] {
  return vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
}

/** process.stdout.write calls (commands print raw bodies this way). */
export function stdoutWrites(): string[] {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .filter(Boolean);
}

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
