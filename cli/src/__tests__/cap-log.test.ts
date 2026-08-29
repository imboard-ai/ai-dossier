import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendCapLog, CAP_LOG_FILE } from '../cap-log';
import * as config from '../config';

vi.mock('node:fs');
vi.mock('../config');

const mockedFs = vi.mocked(fs);

describe('cap-log', () => {
  beforeEach(() => {
    vi.mocked(config.getConfig).mockReset();
    vi.mocked(config.ensureConfigDir).mockReset();
    mockedFs.appendFileSync.mockReset();

    vi.mocked(config.getConfig).mockReturnValue(true);
    vi.mocked(config.ensureConfigDir).mockReturnValue(undefined);
    mockedFs.appendFileSync.mockReturnValue(undefined);
  });

  const makeEntry = (overrides = {}) => ({
    timestamp: '2026-08-29T15:00:00.000Z',
    capability: 'test.focused',
    outcome: 'ok' as const,
    exit_code: 0,
    duration_ms: 842,
    cwd: '/home/test/repo',
    ...overrides,
  });

  describe('appendCapLog', () => {
    it('should write a JSONL line to caps.jsonl with mode 0600', () => {
      const entry = makeEntry();

      appendCapLog(entry);

      expect(mockedFs.appendFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content, opts] = mockedFs.appendFileSync.mock.calls[0];
      expect(filePath).toBe(CAP_LOG_FILE);
      expect(filePath).toContain('caps.jsonl');
      expect(content).toBe(`${JSON.stringify(entry)}\n`);
      expect(opts).toEqual({ mode: 0o600 });
    });

    it('should not write when auditLog is disabled', () => {
      vi.mocked(config.getConfig).mockReturnValue(false);

      appendCapLog(makeEntry());

      expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
    });

    it('should never throw when the append fails', () => {
      mockedFs.appendFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => appendCapLog(makeEntry())).not.toThrow();
    });

    it('should record all four outcome kinds without crashing', () => {
      for (const outcome of ['ok', 'task-failed', 'automation-broken', 'capability-unavailable']) {
        appendCapLog(
          makeEntry({ outcome, exit_code: outcome === 'ok' ? 0 : null, duration_ms: 5 })
        );
      }

      expect(mockedFs.appendFileSync).toHaveBeenCalledTimes(4);
    });
  });
});
