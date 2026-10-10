import { describe, expect, it } from 'vitest';
import { createRun, ReasonCode, transitionRun } from '../state';
import { lifecycleTimes, publicationWaitTime } from './lifecycle-times';

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
describe('publication wait accounting', () => {
  const event = (operation: string, sessionId: string, at: number) => ({
    v: 1,
    type: 'publication_wait',
    runId: 'r',
    operation,
    sessionId,
    at: new Date(at).toISOString(),
  });
  it('projects completed and current waits only for the selected session', () => {
    expect(
      publicationWaitTime(
        [event('begin', 's1', 0), event('end', 's1', 1000), event('begin', 's2', 2000)],
        's2',
        3000
      )
    ).toBe(1000);
    expect(
      publicationWaitTime([event('begin', 's1', 0), event('end', 's1', 1000)], 's2', 3000)
    ).toBe(0);
  });
  it.each([
    [event('end', 's1', 0)],
    [event('begin', 's1', 1000), event('end', 's2', 2000)],
    [event('begin', 's1', 1000), event('begin', 's1', 2000)],
    [event('begin', 's1', 2000), event('end', 's1', 1000)],
    [event('other', 's1', 1000)],
    [{ ...event('begin', 's1', 0), at: 'bad' }],
    [event('begin', 's1', 4000)],
  ])('refuses contradictory/torn publication intervals', (...events) => {
    expect(() => publicationWaitTime(events, 's1', 3000)).toThrow('invalid_journal');
  });
});
