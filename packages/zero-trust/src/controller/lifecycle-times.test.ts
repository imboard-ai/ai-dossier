import { describe, expect, it } from 'vitest';
import { createRun, ReasonCode, transitionRun } from '../state';
import { lifecycleTimes } from './lifecycle-times';

describe('shared lifecycle interval policy', () => {
  const start = '2026-10-05T00:00:00.000Z';
  const run = createRun(
    { runId: 'r', upstreamIssue: 'https://github.com/owner/repo/issues/1', contributor: 'user' },
    start
  );
  it('includes the current active interval and no terminal interval', () => {
    expect(lifecycleTimes(run, Date.parse(start) + 1000).activeMs).toBe(1000);
    const ended = transitionRun(
      run,
      ReasonCode.PolicyBlocked,
      new Date(Date.parse(start) + 1000).toISOString()
    );
    expect(lifecycleTimes(ended, Date.parse(start) + 10000).activeMs).toBe(1000);
  });
  it('refuses invalid or backwards time', () => {
    for (const now of [NaN, Infinity, Date.parse(start) - 1])
      expect(() => lifecycleTimes(run, now)).toThrow();
  });
});
