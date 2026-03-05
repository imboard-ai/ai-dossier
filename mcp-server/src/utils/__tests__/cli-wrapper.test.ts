import { describe, expect, it, vi } from 'vitest';
import { CliExecutionError, CliNotFoundError } from '../cli-wrapper';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('CliNotFoundError', () => {
  it('should have correct name and message', () => {
    const err = new CliNotFoundError();
    expect(err.name).toBe('CliNotFoundError');
    expect(err.message).toContain('ai-dossier CLI not found');
  });
});

describe('CliExecutionError', () => {
  it('should include command and exit code in message', () => {
    const err = new CliExecutionError('verify', 1, 'some error');
    expect(err.name).toBe('CliExecutionError');
    expect(err.message).toContain('verify');
    expect(err.command).toBe('verify');
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe('some error');
  });

  it('should handle null exit code', () => {
    const err = new CliExecutionError('list', null, '');
    expect(err.exitCode).toBeNull();
  });
});
