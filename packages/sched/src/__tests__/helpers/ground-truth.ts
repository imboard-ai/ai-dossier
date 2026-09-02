import type { GroundTruth } from '../../index';

/**
 * A `GroundTruth` whose every method is inert, with the ones a test cares
 * about spread over it.
 *
 * `GroundTruth` grows a method roughly once per engine feature (#468 added
 * `prState`/`setupInfo`, #544 `issueLabels`), and every hand-rolled fake in
 * this suite then needs the same filler stub added by hand — a change that
 * touches three unrelated test files and says nothing. The inert defaults are
 * the "nothing to see" answer for each signal, deliberately NOT the
 * unreachable one: `undefined` means "the poll failed" and would put callers
 * on their degraded paths, which is a behavior a test must opt into.
 */
export function stubGroundTruth(overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    latestMilestone: () => null,
    issueClosed: () => false,
    branchHead: () => null,
    prState: () => undefined,
    setupInfo: () => null,
    issueLabels: () => [],
    ...overrides,
  };
}
