import { describe, expect, it } from 'vitest';
import { decideRiskConfirmation } from '../risk-prompt';

const high = { risk_level: 'high', risk_factors: ['modifies_cloud_resources'] };

describe('decideRiskConfirmation', () => {
  it('does nothing for low/medium risk', () => {
    expect(decideRiskConfirmation({ risk_level: 'medium' }, {}, true).action).toBe('none');
  });

  it('asks on an interactive terminal', () => {
    const d = decideRiskConfirmation(high, {}, true);
    expect(d.action).toBe('confirm');
    expect(d.action !== 'none' && d.lines.join('\n')).toContain('modifies cloud resources');
  });

  it.each([
    ['--force', { force: true }, '--force'],
    ['--no-prompt', { prompt: false }, '--no-prompt'],
    ['--headless', { headless: true }, '--headless'],
    ['--dry-run', { dryRun: true }, '--dry-run'],
  ])('proceeds without asking for %s', (_n, opts, reason) => {
    const d = decideRiskConfirmation(high, opts, true);
    expect(d).toMatchObject({ action: 'proceed', reason });
  });

  it('never hangs when non-interactive', () => {
    expect(decideRiskConfirmation(high, {}, false)).toMatchObject({
      action: 'proceed',
      reason: 'non-interactive session',
    });
  });
});
