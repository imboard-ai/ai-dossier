import type { IssueCloseTruth } from '../../groundtruth';

/**
 * An `IssueCloseTruth` with every field set: an OPEN issue with no labels,
 * closer or closing references, never reopened, created early in the
 * fixtures' timeline and never closed — `overrides` shape the case under test.
 *
 * One default for every suite that hand-builds the record (#850 review): the
 * type grows a field per anchor-close follow-up (#799 `lastReopenedAt`, #850
 * `closingPrsTruncated`/`createdAt`/`closedAt`), and a copy that misses one
 * silently exercises the unreadable path instead of the case it names — the
 * suites are not typechecked (`tsconfig.json` excludes `src/**\/__tests__`).
 */
export function issueCloseTruth(overrides: Partial<IssueCloseTruth> = {}): IssueCloseTruth {
  return {
    state: 'OPEN',
    stateReason: null,
    labels: [],
    closer: null,
    closingPrs: [],
    closingPrsTruncated: false,
    lastReopenedAt: null,
    createdAt: '2026-09-01T10:00:00Z',
    closedAt: null,
    ...overrides,
  };
}
