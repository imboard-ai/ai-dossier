import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// zero-trust-vm.yml runs deliberately hostile fixture code (#1009, AC4). These
// checks fail the moment the workflow could hand that job a secret or a
// writable token, instead of relying on review to notice.
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/zero-trust-vm.yml', import.meta.url));

const text = () => readFileSync(WORKFLOW, 'utf8');
const workflow = () => parse(text());

describe('zero-trust-vm.yml secret isolation', () => {
  it('runs on pull requests touching the package, never on pull_request_target', () => {
    const { on } = workflow();
    expect(Object.keys(on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
    expect(on.pull_request.paths).toContain('packages/zero-trust/**');
  });

  it('references no secrets, no token expression and no secret-derived env', () => {
    expect(text()).not.toMatch(/\bsecrets\s*[.[]/);
    expect(text()).not.toMatch(/github\.token|GITHUB_TOKEN/);
    expect(text()).not.toMatch(/^\s*secrets\s*:/m);
  });

  it('grants only contents: read, at the top and on every job', () => {
    const { permissions, jobs } = workflow();
    expect(permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(jobs)) expect(job.permissions).toEqual({ contents: 'read' });
  });

  it('never persists checkout credentials and pins every action by commit SHA', () => {
    const steps = Object.values(workflow().jobs).flatMap((job) => job.steps);
    const actions = steps.filter((step) => step.uses);
    expect(actions.length).toBeGreaterThan(0);
    for (const step of actions) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    const checkouts = actions.filter((step) => step.uses.startsWith('actions/checkout@'));
    expect(checkouts.length).toBe(Object.keys(workflow().jobs).length);
    for (const step of checkouts) expect(step.with?.['persist-credentials']).toBe(false);
  });

  it('never splices expressions into run scripts', () => {
    const steps = Object.values(workflow().jobs).flatMap((job) => job.steps);
    for (const step of steps) if (step.run) expect(step.run).not.toMatch(/\$\{\{/);
  });
});
