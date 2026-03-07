/**
 * Global test setup for CLI tests.
 * Captures console output for assertions.
 *
 * Note: vitest v4 has built-in process.exit interception that throws
 * "process.exit unexpectedly called with <code>". Tests should use
 * .rejects.toThrow() without matching a specific message.
 */
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
