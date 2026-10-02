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

describe('publish-packages.yml channel contract', () => {
  const workflow = () => parse(readWorkflow());

  it('publishes a complete five-package cohort with a guard for every package', () => {
    const steps = workflow().jobs.publish.steps;
    expect(steps.filter((s) => /\bnpm publish\b/.test(String(s.run ?? '')))).toHaveLength(5);
    expect(steps.filter((s) => /publish-guard\.mjs --dir/.test(String(s.run ?? '')))).toHaveLength(
      5
    );
  });

  it('offers next and stable on workflow_dispatch with next as the default', () => {
    const { on, jobs } = workflow();
    expect(on.workflow_dispatch.inputs.channel).toMatchObject({
      type: 'choice',
      options: ['next', 'stable'],
      default: 'next',
      required: true,
    });
    expect(on.push).toMatchObject({ branches: ['main'], tags: ['v*'] });
    expect(on.release.types).toContain('published');
    expect(jobs.publish.env.PUBLISH_TAG).toContain("inputs.channel == 'stable'");
    expect(jobs.publish.env.PUBLISH_TAG).toContain("'latest' || 'next'");
  });

  it('prepares and publishes next cohorts on the automatic and default-next paths', () => {
    const steps = workflow().jobs.publish.steps;
    const prepare = steps.find((step) => step.name === 'Prepare next release cohort');
    expect(prepare.if).toContain("env.PUBLISH_CHANNEL == 'next'");
    expect(prepare.run).toContain(
      'prepare-next-release.mjs --run-number "$GITHUB_RUN_NUMBER.$GITHUB_RUN_ATTEMPT"'
    );

    const guards = steps.filter((step) => /publish-guard\.mjs --dir/.test(String(step.run ?? '')));
    const publishes = steps.filter((step) => /\bnpm publish\b/.test(String(step.run ?? '')));
    for (const [index, step] of publishes.entries()) {
      expect(String(step.run)).toContain('--tag "$PUBLISH_TAG"');
      expect(step.if).toContain("env.PUBLISH_CHANNEL == 'next'");
      expect(step.if).toContain(`steps.${guards[index].id}.outputs.skip != 'true'`);
    }
  });

  it('uses stable manifests only for stable dispatches and fails closed on guard problems', () => {
    const steps = workflow().jobs.publish.steps;
    expect(steps.find((step) => step.name === 'Require main for stable publishing')?.if).toContain(
      "env.PUBLISH_CHANNEL == 'stable'"
    );
    expect(
      steps.find((step) => step.name === 'Fail on stable publish guard problems')?.run
    ).toContain('--report-collisions "$RUNNER_TEMP/publish-collisions"');
  });

  it('retries registry verification and checks the selected dist-tag', () => {
    const verify = workflow().jobs.verify;
    const step = verify.steps.find(
      (candidate) => candidate.name === 'Verify packages are available under the selected channel'
    );
    expect(verify.env.PUBLISH_TAG).toContain("'latest' || 'next'");
    expect(step.run).toContain('for attempt in 1 2 3 4 5');
    expect(step.run).toContain('sleep "$delay"');
    expect(step.run).toContain(
      'npm view "$package@$PUBLISH_TAG" version --prefer-online 2>"$error_file"'
    );
    expect(step.run).toContain("sed 's/::/: :/g'");
    expect(step.run).toContain('[ "$actual" = "$expected" ]');
  });
});

describe('promote-latest.yml dispatcher contract', () => {
  it('dispatches stable publishing through the existing trusted workflow only', () => {
    const workflow = parse(readFileSync(PROMOTION_WORKFLOW, 'utf8'));
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(workflow.jobs.dispatch.permissions).toEqual({ actions: 'write' });
    const dispatch = workflow.jobs.dispatch.steps.find(
      (step) => step.name === 'Dispatch stable package publish through the trusted workflow'
    );
    expect(dispatch.env).toEqual({ GH_TOKEN: '${' + '{ github.token }}' });
    expect(dispatch.run).toBe(
      'gh workflow run publish-packages.yml --repo imboard-ai/ai-dossier --ref main --field channel=stable'
    );
    expect(JSON.stringify(workflow)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|id-token/);
    expect(dispatch.run).not.toMatch(/(?:^|\s)npm publish\b|npm dist-tag add/);
  });
});
