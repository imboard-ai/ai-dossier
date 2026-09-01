import { describe, expect, it, vi } from 'vitest';
import { registerClassifyCommand } from '../../commands/classify';
import { errored, execHandles, logged, runCommandTree } from '../helpers/test-utils';

vi.mock('node:child_process');

function issueMetaJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'A small fix',
    body: 'Nothing special here.',
    labels: [],
    state: 'OPEN',
    ...overrides,
  });
}

/** Parse the single JSON object `classify prescreen` printed to stdout. */
function loggedJson(): Record<string, unknown> {
  const lines = logged();
  return JSON.parse(lines[lines.length - 1] ?? '{}');
}

describe('classify prescreen', () => {
  it('a clean issue comes back candidate with no warnings and degraded=false', async () => {
    execHandles((file, args) => {
      if (file === 'gh' && args[1] === 'view' && args[4] === 'title,body,labels,state') {
        return issueMetaJson();
      }
      if (file === 'gh' && args[1] === 'view' && args[4] === 'comments') {
        return JSON.stringify({ comments: [] });
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });

    const code = await runCommandTree(registerClassifyCommand, [
      'classify',
      'prescreen',
      '--issue',
      '538',
    ]);

    expect(code).toBeUndefined();
    const out = loggedJson();
    expect(out).toMatchObject({
      issue: 538,
      state: 'OPEN',
      verdict: 'candidate',
      reasons: [],
      plan_artifact: 'absent',
      degraded: false,
      warnings: [],
    });
  });

  it('an obvious floor hit comes back full with a reason', async () => {
    execHandles((file, args) => {
      if (file === 'gh' && args[4] === 'title,body,labels,state') {
        return issueMetaJson({ title: 'fix: terraform plan job' });
      }
      if (file === 'gh' && args[4] === 'comments') return JSON.stringify({ comments: [] });
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });

    await runCommandTree(registerClassifyCommand, ['classify', 'prescreen', '--issue', '538']);

    const out = loggedJson();
    expect(out.verdict).toBe('full');
    expect(out.reasons).toEqual([expect.objectContaining({ check: 'text-floor' })]);
  });

  it('a total issue-metadata fetch failure fails open: candidate, degraded=true, the gh error in warnings, no state', async () => {
    execHandles((file, args) => {
      if (file === 'gh' && args[4] === 'title,body,labels,state') {
        throw new Error('gh: could not resolve to an Issue');
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });

    const code = await runCommandTree(registerClassifyCommand, [
      'classify',
      'prescreen',
      '--issue',
      '538',
    ]);

    expect(code).toBeUndefined();
    const out = loggedJson();
    expect(out.verdict).toBe('candidate');
    expect(out.state).toBeNull();
    expect(out.degraded).toBe(true);
    expect((out.warnings as string[])[0]).toMatch(/could not find it|gh|Could not read issue/i);
    expect(errored().length).toBeGreaterThan(0);
  });

  it('a comments-fetch failure (plan:v1 lookup) is distinguishable from "no plan artifact": plan_artifact=unreadable, degraded=true, a warning — never silently absent', async () => {
    execHandles((file, args) => {
      if (file === 'gh' && args[4] === 'title,body,labels,state') return issueMetaJson();
      if (file === 'gh' && args[4] === 'comments') {
        throw new Error('gh: rate limited');
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });

    await runCommandTree(registerClassifyCommand, ['classify', 'prescreen', '--issue', '538']);

    const out = loggedJson();
    expect(out.plan_artifact).toBe('unreadable');
    expect(out.degraded).toBe(true);
    expect((out.warnings as string[]).some((w) => /plan:v1|comments/i.test(w))).toBe(true);
    // The path-floor/file-count checks were skipped, not silently passed — verdict still
    // reflects whatever the title/body/labels alone produced (candidate here).
    expect(out.verdict).toBe('candidate');
  });

  it('a dependency whose open/closed state cannot be resolved is reported as a warning, not silently dropped', async () => {
    execHandles((file, args) => {
      if (file === 'gh' && args[4] === 'title,body,labels,state') {
        return issueMetaJson({ body: 'Depends on #999' });
      }
      if (file === 'gh' && args[4] === 'comments') return JSON.stringify({ comments: [] });
      if (file === 'gh' && args[4] === 'state') {
        throw new Error('gh: secondary rate limit');
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });

    await runCommandTree(registerClassifyCommand, ['classify', 'prescreen', '--issue', '538']);

    const out = loggedJson();
    expect(out.degraded).toBe(true);
    expect((out.warnings as string[]).some((w) => /#999/.test(w))).toBe(true);
    // Fails open: an unresolved dependency is not counted as an open rule-9 hit.
    expect(out.verdict).toBe('candidate');
  });

  it('--submitted-set exempts an in-set open dependency from the rule-9 check', async () => {
    execHandles((file, args) => {
      if (file === 'gh' && args[4] === 'title,body,labels,state') {
        return issueMetaJson({ body: 'Depends on #101' });
      }
      if (file === 'gh' && args[4] === 'comments') return JSON.stringify({ comments: [] });
      if (file === 'gh' && args[4] === 'state') {
        throw new Error('should not be called for an in-set dependency');
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });

    await runCommandTree(registerClassifyCommand, [
      'classify',
      'prescreen',
      '--issue',
      '538',
      '--submitted-set',
      '100..105',
    ]);

    const out = loggedJson();
    expect(out.verdict).toBe('candidate');
    expect(out.reasons).toEqual([]);
  });

  it('an open dependency outside the submitted set still counts', async () => {
    execHandles((file, args) => {
      if (file === 'gh' && args[4] === 'title,body,labels,state') {
        return issueMetaJson({ body: 'Depends on #999' });
      }
      if (file === 'gh' && args[4] === 'comments') return JSON.stringify({ comments: [] });
      if (file === 'gh' && args[4] === 'state') return JSON.stringify({ state: 'OPEN' });
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    });

    await runCommandTree(registerClassifyCommand, [
      'classify',
      'prescreen',
      '--issue',
      '538',
      '--submitted-set',
      '100..105',
    ]);

    const out = loggedJson();
    expect(out.verdict).toBe('full');
    expect(out.reasons).toEqual([expect.objectContaining({ check: 'open-dependency' })]);
  });

  it('an invalid --submitted-set exits 1 with a message, before any gh call', async () => {
    execHandles((file, args) => {
      throw new Error(`should not call exec: ${file} ${args.join(' ')}`);
    });

    const code = await runCommandTree(registerClassifyCommand, [
      'classify',
      'prescreen',
      '--issue',
      '538',
      '--submitted-set',
      'not-a-selection',
    ]);

    expect(code).toBe(1);
    expect(errored().some((line) => line.includes('--submitted-set'))).toBe(true);
  });
});
