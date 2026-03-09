/**
 * Global test setup for CLI tests.
 * Captures console output for assertions and mocks process.exit
 * to throw a predictable error message for test assertions.
 */
import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code ?? 0})`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
