import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW = fileURLToPath(
  new URL('../.github/workflows/publish-packages.yml', import.meta.url)
);
const PROMOTION_WORKFLOW = fileURLToPath(
  new URL('../.github/workflows/promote-latest.yml', import.meta.url)
);

const readWorkflow = () => readFileSync(WORKFLOW, 'utf8');

describe('publish-packages.yml next-channel contract', () => {
  it('publishes a complete five-package cohort', () => {
    const steps = parse(readWorkflow()).jobs.publish.steps;
    expect(steps.filter((s) => /\bnpm publish\b/.test(String(s.run ?? '')))).toHaveLength(5);
    expect(steps.filter((s) => /publish-guard\.mjs/.test(String(s.run ?? '')))).toHaveLength(5);
  });

  it('prepares unique next versions and publishes every package under next', () => {
    const steps = parse(readWorkflow()).jobs.publish.steps;
    expect(steps.find((step) => step.name === 'Prepare next release cohort')?.run).toContain(
      'prepare-next-release.mjs --run-number "$GITHUB_RUN_NUMBER.$GITHUB_RUN_ATTEMPT"'
    );
    for (const step of steps.filter((step) => /\bnpm publish\b/.test(String(step.run ?? '')))) {
      expect(String(step.run)).toContain('--tag next');
    }
  });

  it('only promotes latest through the manually dispatched promotion workflow', () => {
    const workflow = parse(readFileSync(PROMOTION_WORKFLOW, 'utf8'));
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    const promote = workflow.jobs.promote.steps.find(
      (step) => step.name === 'Promote the current next cohort'
    );
    expect(promote.env).toEqual({ NODE_AUTH_TOKEN: '${' + '{ secrets.NPM_TOKEN }}' });
    expect(promote.run).toContain('npm dist-tag add "$package@$version" latest');
    expect(promote.run).toContain('npm view "$package@next" version --prefer-online');
  });
});
