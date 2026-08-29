import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHistoryCommand } from '../../commands/history';
import * as runLog from '../../run-log';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../run-log');

describe('history command', () => {
  beforeEach(() => {
    vi.mocked(runLog.readRunLog).mockReset();
    vi.mocked(runLog.clearRunLog).mockReset();
  });

  it('should show "No run history" when log is empty', async () => {
    vi.mocked(runLog.readRunLog).mockReturnValue([]);

    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'history'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith('No run history found.');
  });

  it('should display table output', async () => {
    vi.mocked(runLog.readRunLog).mockReturnValue([
      {
        timestamp: '2026-03-06T15:44:23.000Z',
        dossier: 'imboard-ai/full-cycle-issue',
        resolved_version: '2.1.0',
        source: 'cache',
        verification: 'nested-skip',
        llm: 'auto',
        user: 'test@host',
        cwd: '/home/test',
        nested: true,
      },
    ]);

    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'history'])).rejects.toThrow();

    const logCalls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('TIMESTAMP'))).toBe(true);
    expect(
      logCalls.some((c) => typeof c === 'string' && c.includes('imboard-ai/full-cycle-issue'))
    ).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('2.1.0'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('nested-skip'))).toBe(true);
  });

  it('should display duration, token and cost columns for new-schema entries (#458)', async () => {
    vi.mocked(runLog.readRunLog).mockReturnValue([
      {
        timestamp: '2026-03-06T15:44:23.000Z',
        dossier: 'imboard-ai/full-cycle-issue',
        resolved_version: '2.1.0',
        source: 'cache',
        verification: 'passed',
        llm: 'auto',
        user: 'test@host',
        cwd: '/home/test',
        nested: false,
        duration_ms: 74000,
        spawned_command: 'claude -p --output-format json',
        model: 'claude-opus-4-20250514',
        exit_code: 0,
        input_tokens: 1234,
        output_tokens: 567,
        total_cost_usd: 0.0123,
      },
    ]);

    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'history'])).rejects.toThrow();

    const logCalls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('DURATION'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('TOKENS'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('COST'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('1m 14s'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('1234/567'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('$0.0123'))).toBe(true);
  });

  it('should render mixed old/new schema entries without crashing (#458)', async () => {
    const oldEntry = {
      timestamp: '2026-03-06T14:00:00.000Z',
      dossier: 'org/legacy-run',
      resolved_version: '1.0.0',
      source: 'registry' as const,
      verification: 'nested-skip' as const,
      llm: 'auto',
      user: 'test@host',
      cwd: '/home/test',
      nested: true,
    };
    const newEntry = {
      ...oldEntry,
      timestamp: '2026-03-06T15:00:00.000Z',
      dossier: 'org/new-run',
      duration_ms: 412,
      exit_code: 0,
      input_tokens: 10,
      output_tokens: 20,
      total_cost_usd: 0.0001,
    };
    vi.mocked(runLog.readRunLog).mockReturnValue([newEntry, oldEntry]);

    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'history'])).rejects.toThrow();

    const logCalls = vi.mocked(console.log).mock.calls.map((c) => c[0]);
    // New entry renders sub-second duration, tokens and cost.
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('412ms'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('10/20'))).toBe(true);
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('$0.0001'))).toBe(true);
    // Old entry renders (with dashes for missing fields) alongside the new one.
    expect(logCalls.some((c) => typeof c === 'string' && c.includes('org/legacy-run'))).toBe(true);
    const legacyLine = logCalls.find(
      (c) => typeof c === 'string' && c.includes('org/legacy-run')
    ) as string;
    expect(legacyLine).toContain('-');
  });

  it('should output JSON with --json', async () => {
    const entries = [
      {
        timestamp: '2026-03-06T15:00:00Z',
        dossier: 'org/test',
        resolved_version: '1.0.0',
        source: 'registry' as const,
        verification: 'passed' as const,
        llm: 'auto',
        user: 'test@host',
        cwd: '/tmp',
        nested: false,
      },
    ];
    vi.mocked(runLog.readRunLog).mockReturnValue(entries);

    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'history', '--json'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(JSON.stringify(entries, null, 2));
  });

  it('should pass --dossier filter to readRunLog', async () => {
    vi.mocked(runLog.readRunLog).mockReturnValue([]);

    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'history', '--dossier', 'org/test'])
    ).rejects.toThrow();

    expect(runLog.readRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ dossier: 'org/test' })
    );
  });

  it('should clear log with --clear --yes', async () => {
    vi.mocked(runLog.clearRunLog).mockReturnValue(undefined);

    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'history', '--clear', '--yes'])
    ).rejects.toThrow();

    expect(runLog.clearRunLog).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Run history cleared.');
  });

  it('should require --yes for --clear', async () => {
    const program = createTestProgram();
    registerHistoryCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'history', '--clear'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith('Use --yes to confirm clearing run history');
    expect(runLog.clearRunLog).not.toHaveBeenCalled();
  });
});
