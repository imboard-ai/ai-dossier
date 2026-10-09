import { afterEach, expect, it } from 'vitest';
import { createFixtures } from '../../fixtures/retention';
import { contributionEvidence } from './evidence';
import { portableFacts } from './portable';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
it('portable projection excludes internal evidence and filesystem identities', () => {
  const r = rig(),
    facts = contributionEvidence(r.store, r.directory);
  expect(Object.keys(portableFacts(facts)).sort()).toEqual([
    'costTotals',
    'outcome',
    'outcomeSha',
    'pr',
    'upstreamIssue',
    'verifiedSha',
  ]);
});
