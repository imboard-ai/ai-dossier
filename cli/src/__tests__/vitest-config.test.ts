import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

// #696: the vitest DEFAULT testTimeout (5000ms) flaked on the publish gate's
// shared CI runner — the fs-heavy sched auto-upgrade tests sit at ~1s locally
// but exceeded 5s once, silently skipping an npm release. This pins the
// headroom so the override cannot silently regress to the default.
describe('vitest config', () => {
  it('keeps testTimeout well above the 5000ms default (#696 publish-gate flake)', () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(30_000);
  });
});
