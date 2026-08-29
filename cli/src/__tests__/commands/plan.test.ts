import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPlanCommand } from '../../commands/plan';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:child_process');

const mockedExec = vi.mocked(execFileSync);

/** Valid plan file content for `post` (five sections). */
const VALID_PLAN_FILE = [
  '# Issue #462: a plan',
  '',
  '## Problem',
  'Triple planning.',
  '',
  '## Acceptance Criteria',
  '- AC1 posted',
  '',
  '## Predicted Files',
  '- `cli/src/plan-artifact.ts` — the module',
  '- `docs/reference/plan-artifact.md` — the spec',
  '',
  '## Approach',
  '1. Build it.',
  '',
  '## Test Scope',
  '- unit tests with mocked gh',
  '',
].join('\n');

/** A posted artifact body the gh stub can serve back for `get`/`validate`. */
const POSTED_ARTIFACT = `<!-- plan:v1 head=abc1234 -->\n\n${VALID_PLAN_FILE}`;

type ExecStub = (file: string, args: string[]) => string;

function execReturns(stdout: string): void {
  mockedExec.mockReturnValue(stdout as unknown as ReturnType<typeof execFileSync>);
}

function execHandles(stub: ExecStub): void {
  mockedExec.mockImplementation(stub as unknown as typeof execFileSync);
}

function ghCommentsJson(bodies: string[], meta = true): string {
  return JSON.stringify({
    comments: bodies.map((body, i) => ({
      body,
      url: `https://github.com/o/r/issues/1#comment-${i}`,
      createdAt: meta ? '2026-08-29T10:00:00Z' : undefined,
    })),
  });
}

async function run(args: string[]): Promise<number | undefined> {
  const program = createTestProgram();
  registerPlanCommand(program);
  try {
    await program.parseAsync(['node', 'dossier', ...args]);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const exit = /^process\.exit\((\d+)\)$/.exec(message);
    if (exit) return Number(exit[1]);
    if (isCommanderError(err)) return undefined;
    throw err;
  }
  return undefined;
}

function isCommanderError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function stdoutWrites(): string[] {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .filter(Boolean);
}

function logged(): string[] {
  return vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .filter((s) => s !== 'undefined');
}

function errored(): string[] {
  return vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
}

/** Calls made to the mocked exec, as `file args…` strings. */
function calls(): string[] {
  return mockedExec.mock.calls.map((c) => [c[0], ...c[1]].join(' '));
}

function planFile(returns: string): void {
  vi.spyOn(fs, 'readFileSync').mockReturnValue(returns as unknown as Buffer);
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // Reset the automock's call history and implementation explicitly — restoreAllMocks
  // in the global setup does not reliably clear automocked module functions.
  mockedExec.mockReset();
  mockedExec.mockImplementation(() => {
    throw Object.assign(new Error('unexpected exec'), { code: 'ENOENT' });
  });
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  });
});

describe('plan post', () => {
  it('posts a comment beginning with the marker, stamped with current HEAD', async () => {
    planFile(VALID_PLAN_FILE);
    execHandles((file, args) => {
      if (file === 'git' && args[0] === 'rev-parse') return 'abc1234';
      if (file === 'gh' && args[0] === 'issue' && args[1] === 'comment')
        return 'https://github.com/o/r/issues/1#comment-9';
      throw new Error(`unexpected call: ${file} ${args.join(' ')}`);
    });

    const code = await run(['plan', 'post', '--issue', '1', '--file', 'plan.md']);
    expect(code).toBeUndefined();

    const commentCall = mockedExec.mock.calls.find((c) => c[0] === 'gh' && c[1][1] === 'comment');
    const argv = commentCall?.[1] ?? [];
    const body = argv[argv.indexOf('--body') + 1] ?? '';
    expect(body.startsWith('<!-- plan:v1 head=abc1234 -->\n')).toBe(true);
    for (const section of [
      '## Problem',
      '## Acceptance Criteria',
      '## Predicted Files',
      '## Approach',
      '## Test Scope',
    ]) {
      expect(body).toContain(section);
    }
    expect(logged()[0]).toMatch(/✅ plan:v1 head=abc1234 → /);
  });

  it('passes --repo through to gh', async () => {
    planFile(VALID_PLAN_FILE);
    execHandles((file) => {
      if (file === 'git') return 'abc1234';
      if (file === 'gh') return 'url';
      throw new Error(`unexpected: ${file}`);
    });
    await run(['plan', 'post', '--issue', '1', '--file', 'plan.md', '--repo', 'o/r']);
    expect(calls().some((c) => c.includes('--repo o/r'))).toBe(true);
  });

  it('refuses a file missing required sections, without calling gh or git', async () => {
    planFile('# Just a title\n\n## Problem\nnothing else\n');
    execHandles(() => {
      throw new Error('must not be called');
    });

    const code = await run(['plan', 'post', '--issue', '1', '--file', 'plan.md']);
    expect(code).toBe(1);
    const errors = errored().join('\n');
    expect(errors).toContain('not a postable plan:v1 artifact');
    expect(errors).toContain('## Predicted Files');
  });

  it('exits 1 when the plan file cannot be read', async () => {
    const code = await run(['plan', 'post', '--issue', '1', '--file', 'missing.md']);
    expect(code).toBe(1);
    expect(errored().join('\n')).toContain("Could not read plan file 'missing.md'");
  });

  it('stamps --head without asking git', async () => {
    planFile(VALID_PLAN_FILE);
    execHandles((file) => {
      if (file === 'gh') return 'url';
      throw new Error(`git must not be called: ${file}`);
    });
    await run(['plan', 'post', '--issue', '1', '--file', 'plan.md', '--head', 'fff0000']);
    expect(calls().some((c) => c.startsWith('git'))).toBe(false);
  });

  it('refuses a plan over the comment cap pre-flight', async () => {
    planFile(`${VALID_PLAN_FILE}\n${'## Approach\npadding\n'.repeat(3000)}`);
    execHandles(() => {
      throw new Error('must not be called');
    });
    const code = await run([
      'plan',
      'post',
      '--issue',
      '1',
      '--file',
      'plan.md',
      '--head',
      'fff0000',
    ]);
    expect(code).toBe(1);
    expect(errored().join('\n')).toContain('characters');
  });

  it('--dry-run prints the exact body and posts nothing', async () => {
    planFile(VALID_PLAN_FILE);
    execHandles((file) => {
      if (file === 'git') return 'abc1234';
      throw new Error(`gh must not be called: ${file}`);
    });

    const code = await run(['plan', 'post', '--issue', '1', '--file', 'plan.md', '--dry-run']);
    expect(code).toBeUndefined();
    expect(stdoutWrites()[0].startsWith('<!-- plan:v1 head=abc1234 -->')).toBe(true);
    expect(calls().some((c) => c.startsWith('gh'))).toBe(false);
  });

  it('names the cause and hands back the body when gh fails to post', async () => {
    planFile(VALID_PLAN_FILE);
    execHandles((file) => {
      if (file === 'git') return 'abc1234';
      throw Object.assign(new Error('gh failed'), { status: 1, stderr: 'gh auth login required' });
    });

    const code = await run(['plan', 'post', '--issue', '1', '--file', 'plan.md']);
    expect(code).toBe(1);
    const errors = errored().join('\n');
    expect(errors).toContain('gh is not authenticated');
    expect(errors).toContain('The plan was NOT posted');
  });
});

describe('plan get', () => {
  it('prints the latest artifact body in text mode', async () => {
    const older = POSTED_ARTIFACT.replace('abc1234', 'aaa1111');
    execReturns(ghCommentsJson(['noise', older, POSTED_ARTIFACT]));

    const code = await run(['plan', 'get', '--issue', '1']);
    expect(code).toBeUndefined();
    const out = stdoutWrites().join('');
    expect(out.startsWith('<!-- plan:v1 head=abc1234 -->')).toBe(true);
  });

  it('prints parsed fields in JSON mode, taking the LAST plan', async () => {
    const older = POSTED_ARTIFACT.replace('abc1234', 'aaa1111');
    execReturns(ghCommentsJson([older, POSTED_ARTIFACT]));

    const code = await run(['plan', 'get', '--issue', '1', '--json']);
    expect(code).toBeUndefined();
    const parsed = JSON.parse(logged()[0]);
    expect(parsed.head).toBe('abc1234');
    expect(parsed.problem).toBe('Triple planning.');
    expect(parsed.approach).toContain('1. Build it.');
    expect(parsed.acceptance_criteria).toContain('AC1 posted');
    expect(parsed.test_scope).toContain('mocked gh');
    expect(parsed.predicted_files).toEqual([
      'cli/src/plan-artifact.ts',
      'docs/reference/plan-artifact.md',
    ]);
    expect(parsed.url).toContain('comment-1');
    expect(parsed.created_at).toBe('2026-08-29T10:00:00Z');
  });

  it('exits 1 distinguishably when no plan exists', async () => {
    execReturns(ghCommentsJson(['a normal comment', '<!-- runstate:v1 -->\nphase=gate']));

    const code = await run(['plan', 'get', '--issue', '1']);
    expect(code).toBe(1);
    expect(errored().join('\n')).toContain('No plan:v1 artifact on issue #1');
  });

  it('exits 1 with the shared taxonomy when gh cannot read the issue', async () => {
    mockedExec.mockImplementation(() => {
      throw Object.assign(new Error('no gh'), { code: 'ENOENT' });
    });
    const code = await run(['plan', 'get', '--issue', '1']);
    expect(code).toBe(1);
    expect(errored().join('\n')).toContain("'gh' is not installed");
  });
});

describe('plan validate', () => {
  /** Stub git: HEAD has the two predicted files; distance configurable. */
  function gitHasFiles(
    distance = '0',
    existing = new Set(['cli/src/plan-artifact.ts', 'docs/reference/plan-artifact.md'])
  ): void {
    execHandles((file, args) => {
      if (file === 'gh') return ghCommentsJson([POSTED_ARTIFACT]);
      if (file === 'git' && args[0] === 'cat-file') {
        const path = args[2].slice('HEAD:'.length);
        if (existing.has(path)) return '';
        const err = new Error('missing') as Error & { status: number; stderr: string };
        err.status = 1;
        err.stderr = '';
        throw err;
      }
      if (file === 'git' && args[0] === 'rev-list') return distance;
      throw new Error(`unexpected: ${file} ${args.join(' ')}`);
    });
  }

  function verdict(): {
    valid: boolean;
    reasons: Array<{ check: string; severity: string; message: string }>;
  } {
    return JSON.parse(logged()[0]);
  }

  it('valid=true with no reasons when everything checks out', async () => {
    gitHasFiles();
    const code = await run(['plan', 'validate', '--issue', '1']);
    expect(code).toBeUndefined();
    expect(verdict()).toEqual({ valid: true, reasons: [] });
  });

  it('valid=false with a missing-file reason when a predicted file is absent at HEAD', async () => {
    gitHasFiles('0', new Set(['cli/src/plan-artifact.ts']));
    const code = await run(['plan', 'validate', '--issue', '1']);
    expect(code).toBe(1);
    const v = verdict();
    expect(v.valid).toBe(false);
    expect(
      v.reasons.some(
        (r) => r.check === 'missing-file' && r.message.includes('docs/reference/plan-artifact.md')
      )
    ).toBe(true);
  });

  it('reports head-distance as info when HEAD moved past the plan head', async () => {
    gitHasFiles('7');
    await run(['plan', 'validate', '--issue', '1']);
    const v = verdict();
    expect(v.valid).toBe(true);
    expect(v.reasons).toContainEqual({
      check: 'head-distance',
      severity: 'info',
      message:
        "7 commit(s) on HEAD since the plan's head=abc1234 — re-check Predicted Files against what changed.",
    });
  });

  it('flags risk-floor paths as info without failing validity', async () => {
    const artifact = POSTED_ARTIFACT.replace(
      '- `cli/src/plan-artifact.ts` — the module',
      '- `src/auth/session.ts` — the module'
    );
    execHandles((file, args) => {
      if (file === 'gh') return ghCommentsJson([artifact]);
      if (file === 'git' && args[0] === 'cat-file') return '';
      if (file === 'git' && args[0] === 'rev-list') return '0';
      throw new Error(`unexpected: ${file}`);
    });

    const code = await run(['plan', 'validate', '--issue', '1']);
    expect(code).toBeUndefined();
    const v = verdict();
    expect(v.valid).toBe(true);
    expect(
      v.reasons.some((r) => r.check === 'risk-floor' && r.message.includes('auth-secrets'))
    ).toBe(true);
  });

  it('valid=false with an artifact reason when no plan exists — no git calls', async () => {
    execReturns(ghCommentsJson(['no plan here']));
    const code = await run(['plan', 'validate', '--issue', '1']);
    expect(code).toBe(1);
    const v = verdict();
    expect(v.valid).toBe(false);
    expect(v.reasons).toEqual([
      {
        check: 'artifact',
        severity: 'error',
        message: "No plan:v1 artifact on issue #1 — post one with 'ai-dossier plan post'.",
      },
    ]);
    expect(calls().some((c) => c.startsWith('git'))).toBe(false);
  });

  it('errors (not crashes) when git is missing entirely', async () => {
    execHandles((file) => {
      if (file === 'gh') return ghCommentsJson([POSTED_ARTIFACT]);
      throw Object.assign(new Error('no git'), { code: 'ENOENT' });
    });
    const code = await run(['plan', 'validate', '--issue', '1']);
    expect(code).toBe(1);
    const v = verdict();
    expect(v.valid).toBe(false);
    expect(
      v.reasons.some((r) => r.check === 'git' && r.message.includes('git is not installed'))
    ).toBe(true);
  });

  it('refuses to pass a flag-like predicted path to git', async () => {
    const artifact = POSTED_ARTIFACT.replace(
      '- `cli/src/plan-artifact.ts` — the module',
      '- `--upload-pack=evil` — injected'
    );
    execHandles((file, args) => {
      if (file === 'gh') return ghCommentsJson([artifact]);
      if (file === 'git' && args[0] === 'cat-file') return '';
      if (file === 'git' && args[0] === 'rev-list') return '0';
      throw new Error(`unexpected: ${file} ${args.join(' ')}`);
    });

    const code = await run(['plan', 'validate', '--issue', '1']);
    expect(code).toBe(1);
    const v = verdict();
    expect(v.valid).toBe(false);
    expect(
      v.reasons.some((r) => r.check === 'git' && r.message.includes('not a usable path'))
    ).toBe(true);
    // The forged value never reached a git argv.
    expect(calls().some((c) => c.includes('--upload-pack'))).toBe(false);
  });

  it('warns when Predicted Files yields no paths', async () => {
    const artifact = POSTED_ARTIFACT.replace(
      /## Predicted Files\n[\s\S]*?## Approach/,
      '## Predicted Files\n(none listed)\n\n## Approach'
    );
    execHandles((file, args) => {
      if (file === 'gh') return ghCommentsJson([artifact]);
      if (file === 'git' && args[0] === 'rev-list') return '0';
      throw new Error(`unexpected: ${file} ${args.join(' ')}`);
    });

    await run(['plan', 'validate', '--issue', '1']);
    const v = verdict();
    expect(v.valid).toBe(true);
    expect(v.reasons.some((r) => r.check === 'sections' && r.severity === 'warn')).toBe(true);
  });
});
