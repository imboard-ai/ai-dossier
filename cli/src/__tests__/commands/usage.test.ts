/**
 * `ai-dossier usage` command wiring (#769): the parent command's own
 * `--batch`/`--issue` action and the `window`/`watch` subcommands both route.
 * Inputs are chosen to be rejected before any store is read, so these never
 * touch the operator's real ~/.claude or opencode.db. Report content is
 * covered against fixture stores in `usage-ledger.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerUsageCommand } from '../../commands/usage';
import { createTestProgram } from '../helpers/test-utils';

afterEach(() => {
  vi.restoreAllMocks();
});

function program() {
  const p = createTestProgram();
  registerUsageCommand(p);
  return p;
}

describe('usage command', () => {
  it('prints help when neither --batch nor --issue is given', async () => {
    let out = '';
    const p = createTestProgram();
    p.configureOutput({
      writeOut: (s) => {
        out += s;
      },
      writeErr: () => {},
    });
    registerUsageCommand(p);
    await p.parseAsync(['node', 'dossier', 'usage']);
    expect(out).toContain('window');
    expect(out).toContain('--batch');
  });

  it('routes --batch to the scope report (rejects a bad --since before reading stores)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      program().parseAsync(['node', 'dossier', 'usage', '--batch', 'b1', '--since', 'bogus'])
    ).rejects.toThrow('process.exit(1)');
    expect(err.mock.calls.flat().join(' ')).toContain('--since');
  });

  it('routes --issue and validates it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      program().parseAsync(['node', 'dossier', 'usage', '--issue', 'abc'])
    ).rejects.toThrow('process.exit(1)');
    expect(err.mock.calls.flat().join(' ')).toContain('--issue');
  });

  it('routes the window subcommand', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      program().parseAsync(['node', 'dossier', 'usage', 'window', '--last', 'forever'])
    ).rejects.toThrow('process.exit(1)');
    expect(err.mock.calls.flat().join(' ')).toContain('--last');
  });

  it('routes the watch subcommand', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      program().parseAsync(['node', 'dossier', 'usage', 'watch', '--interval', 'soon'])
    ).rejects.toThrow('process.exit(1)');
    expect(err.mock.calls.flat().join(' ')).toContain('--interval');
  });
});
