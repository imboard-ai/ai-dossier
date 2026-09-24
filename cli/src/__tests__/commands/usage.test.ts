/**
 * `ai-dossier usage` command wiring (#769): the parent command's own
 * `--batch`/`--issue` action and the `window`/`watch` subcommands both route.
 * Inputs are chosen to be rejected before any store is read, so these never
 * touch the operator's real ~/.claude or opencode.db. Report content is
 * covered against fixture stores in `usage-ledger.test.ts`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  it('window honours --json/--provider given after the subcommand (not swallowed by the parent)', async () => {
    // Point every store at an empty temp home — never the operator's real data.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cmd-'));
    const env = { ...process.env };
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
    process.env.OPENCODE_DB = path.join(home, 'none.db');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program().parseAsync([
        'node',
        'dossier',
        'usage',
        'window',
        '--last',
        '1h',
        '--json',
        '--provider',
        'openai',
      ]);
      const report = JSON.parse(String(log.mock.calls[0][0]));
      expect(report.totals.messages).toBe(0);
      expect(report.collectors.map((c: { source: string }) => c.source)).toContain('opencode');
    } finally {
      process.env = env;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
