import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRunstateCommand } from '../../commands/runstate';
import { buildMilestone, RUNSTATE_MARKER } from '../../runstate';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:child_process');

const mockedExec = vi.mocked(execFileSync);

/**
 * `execFileSync` is overloaded, and the overload `vi.mocked` resolves to returns a Buffer
 * — but every call site under test passes `encoding: 'utf8'` and therefore gets a string.
 * Stubs go through these two helpers so the one unavoidable cast lives in a single place
 * instead of an `as never` at every `mockReturnValue`.
 */
type ExecStub = (file: string, args: string[]) => string;

/** Every command invocation returns `stdout`. */
function execReturns(stdout: string): void {
  mockedExec.mockReturnValue(stdout as unknown as ReturnType<typeof execFileSync>);
}

/** Dispatch on the command being run — throw from `stub` to simulate a non-zero exit. */
function execHandles(stub: ExecStub): void {
  mockedExec.mockImplementation(stub as unknown as typeof execFileSync);
}

/**
 * Run the command tree and return the exit code the action asked for.
 *
 * The shared test setup replaces `process.exit` with a throw of
 * `process.exit(<code>)`, and `createTestProgram` puts commander in exitOverride mode —
 * so both kinds of exit surface here as exceptions rather than killing the runner.
 */
async function run(args: string[]): Promise<number | undefined> {
  const program = createTestProgram();
  registerRunstateCommand(program);
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

/** Commander's exitOverride throws a CommanderError, which carries a `code` string. */
function isCommanderError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err;
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

function stdoutWrites(): string[] {
  return vi
    .mocked(process.stdout.write)
    .mock.calls.map((c) => String(c[0]))
    .filter(Boolean);
}

/**
 * Capture stderr writes with `isTTY` forced either way — progress output is TTY-only, so
 * both branches need driving.
 */
function captureStderrWrites(isTty: boolean): string[] {
  const writes: string[] = [];
  Object.defineProperty(process.stderr, 'isTTY', { value: isTty, configurable: true });
  vi.mocked(process.stderr.write).mockImplementation(((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write);
  return writes;
}

/** Build a `gh issue view --json comments` payload. */
function commentsPayload(bodies: string[]): string {
  return JSON.stringify({ comments: bodies.map((body) => ({ body })) });
}

/**
 * One milestone comment body, built by the same function `runstate post` uses — so a
 * fixture cannot drift from the wire format it is supposed to represent. Extra
 * `key=value` pairs let a fixture carry `model=` or `pr=` without a second builder.
 */
function milestoneBody(
  phase: string,
  status: string,
  run: string,
  at: string,
  keys: Record<string, string> = {},
  next = 'done'
): string {
  return buildMilestone({ phase, status, run, at, keys: Object.entries(keys), next });
}

const GATE_MILESTONE = milestoneBody(
  'gate',
  'done',
  'r-440-ab56',
  '2026-08-24T10:00:00Z',
  { base_branch: 'main', warnings: '0' },
  'setup'
);

describe('runstate command', () => {
  beforeEach(() => {
    mockedExec.mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  describe('post', () => {
    it('posts a validated milestone through gh issue comment', async () => {
      mockedExec.mockReturnValue('https://github.com/o/r/issues/440#issuecomment-1\n');

      await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'base_branch=main',
        '--kv',
        'warnings=0',
      ]);

      expect(mockedExec).toHaveBeenCalledTimes(1);
      const [file, args] = mockedExec.mock.calls[0];
      expect(file).toBe('gh');
      expect(args?.slice(0, 3)).toEqual(['issue', 'comment', '440']);
      const body = (args as string[])[4];
      expect(body).toContain(RUNSTATE_MARKER);
      expect(body).toContain('phase=gate status=done run=r-440-ab56');
      expect(body).toContain('base_branch=main');
      expect(body).toContain('next=setup');
      expect(logged().some((l) => l.includes('issuecomment-1'))).toBe(true);
    });

    it('forwards --repo to gh', async () => {
      execReturns('url\n');

      await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'base_branch=main',
        '--kv',
        'warnings=0',
        '--repo',
        'imboard-ai/ai-dossier',
      ]);

      expect(mockedExec.mock.calls[0][1]).toContain('--repo');
      expect(mockedExec.mock.calls[0][1]).toContain('imboard-ai/ai-dossier');
    });

    it('refuses an unknown phase with one actionable line and posts nothing', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'deploy',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      const lines = errored();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("Unknown phase 'deploy'");
    });

    it('refuses an unknown status and posts nothing', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'finished',
        '--run',
        'r-440-ab56',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().some((l) => l.includes("Unknown status 'finished'"))).toBe(true);
    });

    it('refuses missing required keys and posts nothing', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'setup',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'branch=feature/440',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      const lines = errored();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('worktree=');
      expect(lines[0]).toContain('pool_claimed=');
      expect(lines[0]).toContain('base_branch=');
    });

    it('refuses a malformed --kv pair', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'base_branch',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().some((l) => l.includes("Malformed --kv 'base_branch'"))).toBe(true);
    });

    it('posts a classify verdict with all eight keys (#461)', async () => {
      execReturns('url\n');

      await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'classify',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'mode=slot',
        '--kv',
        'risk=low',
        '--kv',
        'est_files=3',
        '--kv',
        'est_diff=120',
        '--kv',
        'areas=cli,docs',
        '--kv',
        'test_scope=focused',
        '--kv',
        'deps=none',
        '--kv',
        'confidence=0.85',
      ]);

      const body = mockedExec.mock.calls[0][1]?.[4] ?? '';
      expect(body).toContain('phase=classify status=done run=r-440-ab56');
      expect(body).toContain('mode=slot');
      expect(body).toContain('confidence=0.85');
      expect(body).toContain('next=done');
    });

    it('posts a batch-ship awaiting-merge milestone (#461)', async () => {
      execReturns('url\n');

      await run([
        'runstate',
        'post',
        '--issue',
        '480',
        '--phase',
        'batch-ship',
        '--status',
        'awaiting-merge',
        '--run',
        'r-480-cd12',
        '--kv',
        'batch=b-2026-08-29-01',
      ]);

      const body = mockedExec.mock.calls[0][1]?.[4] ?? '';
      expect(body).toContain('phase=batch-ship status=awaiting-merge');
      expect(body).toContain('next=batch-ship');
    });

    it('refuses a malformed verdict value with an actionable line and posts nothing (#461)', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'classify',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'mode=full',
        '--kv',
        'risk=extreme',
        '--kv',
        'est_files=2',
        '--kv',
        'est_diff=50',
        '--kv',
        'areas=cli',
        '--kv',
        'test_scope=unknown',
        '--kv',
        'deps=none',
        '--kv',
        'confidence=0.9',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored()).toHaveLength(1);
      expect(errored()[0]).toContain(
        "Key 'risk' has an invalid value 'extreme' — expected one of: low, med, high"
      );
    });

    it('prints the body without posting under --dry-run', async () => {
      await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'base_branch=main',
        '--kv',
        'warnings=0',
        '--dry-run',
      ]);

      expect(mockedExec).not.toHaveBeenCalled();
      expect(stdoutWrites().join('')).toContain(RUNSTATE_MARKER);
    });

    it('exits 1 when gh fails to post', async () => {
      mockedExec.mockImplementation(() => {
        throw new Error('gh: not authenticated');
      });

      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'base_branch=main',
        '--kv',
        'warnings=0',
      ]);

      expect(code).toBe(1);
      expect(errored().some((l) => l.includes('Failed to post'))).toBe(true);
    });

    it('emits JSON with --json', async () => {
      execReturns('https://example/comment\n');

      await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'report',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'pr=441',
        '--kv',
        'traps_added=1',
        '--json',
      ]);

      const parsed = JSON.parse(logged()[0]);
      expect(parsed.posted).toBe(true);
      expect(parsed.url).toBe('https://example/comment');
      expect(parsed.body).toContain('phase=report');
    });
  });

  describe('last', () => {
    it('prints the parsed key=value lines of the last milestone', async () => {
      execReturns(commentsPayload(['plain comment', GATE_MILESTONE]));

      await run(['runstate', 'last', '--issue', '440']);

      const out = logged();
      expect(out).toContain('phase=gate');
      expect(out).toContain('base_branch=main');
    });

    it('takes the LAST milestone when several exist', async () => {
      const setup = [
        RUNSTATE_MARKER,
        'phase=setup status=done run=r-440-ab56 at=2026-08-24T10:01:00Z',
        'branch=feature/440',
        'next=plan',
        '',
      ].join('\n');
      execReturns(commentsPayload([GATE_MILESTONE, setup]));

      await run(['runstate', 'last', '--issue', '440', '--json']);

      const parsed = JSON.parse(logged()[0]);
      expect(parsed.phase).toBe('setup');
      expect(parsed.branch).toBe('feature/440');
    });

    it('reports when an issue has no milestones', async () => {
      execReturns(commentsPayload(['just a comment']));

      await run(['runstate', 'last', '--issue', '440']);

      expect(logged().some((l) => l.includes('No runstate milestones'))).toBe(true);
    });

    it('prints null JSON when there are no milestones and --json is set', async () => {
      execReturns(commentsPayload([]));

      await run(['runstate', 'last', '--issue', '440', '--json']);

      expect(logged()[0]).toBe('null');
    });

    it('never writes: only gh issue view is invoked', async () => {
      execReturns(commentsPayload([GATE_MILESTONE]));

      await run(['runstate', 'last', '--issue', '440']);

      for (const [file, args] of mockedExec.mock.calls) {
        expect(file).toBe('gh');
        expect(args?.slice(0, 2)).toEqual(['issue', 'view']);
      }
    });

    it('exits 1 with an actionable line when gh cannot read the issue', async () => {
      mockedExec.mockImplementation(() => {
        throw new Error('no such issue');
      });

      const code = await run(['runstate', 'last', '--issue', '440']);

      expect(code).toBe(1);
      expect(errored().some((l) => l.includes('Could not read issue #440'))).toBe(true);
    });
  });

  describe('verify', () => {
    it('reports a fresh run when the issue has no milestones', async () => {
      execReturns(commentsPayload([]));

      await run(['runstate', 'verify', '--issue', '440']);

      expect(logged()).toContain('resume_from=none');
      expect(logged()).toContain('run_id=none');
    });

    it('resumes at setup after a gate milestone', async () => {
      execReturns(commentsPayload([GATE_MILESTONE]));

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      const parsed = JSON.parse(logged()[0]);
      expect(parsed.resume_from).toBe('setup');
      expect(parsed.run_id).toBe('r-440-ab56');
      expect(parsed.resume_context.base_branch).toBe('main');
    });

    it('verifies a setup milestone against git and the filesystem', async () => {
      const setup = [
        RUNSTATE_MARKER,
        'phase=setup status=done run=r-440-ab56 at=2026-08-24T10:01:00Z',
        'branch=feature/440',
        'worktree=/definitely/not/a/real/path/for/tests',
        'pool_claimed=false',
        'base_branch=main',
        'next=plan',
        '',
      ].join('\n');

      execHandles((file, args) => {
        if (file === 'gh' && args[0] === 'issue') return commentsPayload([GATE_MILESTONE, setup]);
        if (file === 'git' && args[0] === 'ls-remote') return '';
        throw new Error(`unexpected ${file}`);
      });

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      // Branch verifies (ls-remote succeeds) but the worktree path does not exist,
      // so the run must fall back to setup rather than trusting the comment.
      const parsed = JSON.parse(logged()[0]);
      expect(parsed.resume_from).toBe('setup');
      expect(parsed.verified).toEqual(['branch']);
    });

    it('surfaces a resume-loop hard block', async () => {
      const blocked = [
        RUNSTATE_MARKER,
        'phase=plan status=blocked run=r-440-ab56 at=2026-08-24T10:02:00Z',
        'reason=vague',
        'next=done',
        '',
      ].join('\n');
      execReturns(commentsPayload([blocked, blocked, blocked]));

      await run(['runstate', 'verify', '--issue', '440']);

      expect(logged()).toContain('hard_block=resume-loop');
    });

    it('reports slot_trail=present for a slot-mode member trail (#461)', async () => {
      const slotImplement = [
        RUNSTATE_MARKER,
        'phase=implement status=done run=r-440-ab56 at=2026-08-24T10:03:00Z',
        'head=abc1234',
        'mode=slot',
        'batch=b-2026-08-29-01',
        'next=x',
        '',
      ].join('\n');
      execReturns(commentsPayload([slotImplement]));

      await run(['runstate', 'verify', '--issue', '440']);

      expect(logged()).toContain('resume_from=none');
      expect(logged()).toContain('slot_trail=present');
      expect(logged().some((l) => l.startsWith('note=slot-mode trail'))).toBe(true);
    });

    it('reports slot_trail in --json for a slot-mode member trail (#461)', async () => {
      const classifySlot = [
        RUNSTATE_MARKER,
        'phase=classify status=done run=r-440-ab56 at=2026-08-24T09:00:00Z',
        'mode=slot',
        'risk=low',
        'est_files=3',
        'est_diff=120',
        'areas=cli',
        'test_scope=focused',
        'deps=none',
        'confidence=0.85',
        'next=done',
        '',
      ].join('\n');
      execReturns(commentsPayload([classifySlot]));

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      const parsed = JSON.parse(logged()[0]);
      expect(parsed.resume_from).toBe('none');
      expect(parsed.slot_trail).toBe(true);
      expect(parsed.note).toContain('classify');
    });

    it('treats a batch anchor trail as not-a-full-cycle-run (#461)', async () => {
      const batchShip = [
        RUNSTATE_MARKER,
        'phase=batch-ship status=awaiting-merge run=r-480-cd12 at=2026-08-24T10:05:00Z',
        'batch=b-2026-08-29-01',
        'next=batch-ship',
        '',
      ].join('\n');
      execReturns(commentsPayload([batchShip]));

      await run(['runstate', 'verify', '--issue', '480']);

      expect(logged()).toContain('resume_from=none');
      expect(logged().some((l) => l.startsWith('note=batch anchor trail'))).toBe(true);
      expect(logged()).not.toContain('slot_trail=present');
    });

    it('only ever runs read-only commands', async () => {
      execReturns(commentsPayload([GATE_MILESTONE]));

      await run(['runstate', 'verify', '--issue', '440']);

      for (const [file, args] of mockedExec.mock.calls) {
        const argv = (args ?? []) as string[];
        expect(['gh', 'git']).toContain(file);
        expect(argv).not.toContain('comment');
        expect(argv).not.toContain('edit');
        expect(argv).not.toContain('push');
      }
    });
  });

  describe('mint', () => {
    it('prints a run id for the issue', async () => {
      await run(['runstate', 'mint', '--issue', '440']);

      expect(logged()[0]).toMatch(/^r-440-[0-9a-f]{4}$/);
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe('mint rejects a bad --issue', () => {
    it('refuses a non-numeric issue instead of minting r-<garbage>-<hex>', async () => {
      const code = await run(['runstate', 'mint', '--issue', 'not-a-number']);

      expect(code).toBe(1);
      expect(logged()).toHaveLength(0);
      const out = errored().join('\n');
      expect(out).toContain("Invalid --issue 'not-a-number'");
      expect(out).toContain('--issue 440');
    });

    it('refuses a pasted issue URL', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        'https://github.com/o/r/issues/440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join('\n')).toContain('Invalid --issue');
    });
  });

  describe('subprocess failures name the real cause', () => {
    /** Make every mocked exec throw the error shape `execFileSync` really throws. */
    function ghThrows(props: Record<string, unknown>): void {
      mockedExec.mockImplementation(() => {
        throw Object.assign(new Error('Command failed'), props);
      });
    }

    it('distinguishes a missing gh binary from an auth or issue problem', async () => {
      ghThrows({ code: 'ENOENT' });

      const code = await run(['runstate', 'last', '--issue', '440']);

      expect(code).toBe(1);
      const out = errored().join('\n');
      expect(out).toContain("'gh' is not installed");
      expect(out).toContain('https://cli.github.com');
      expect(out).not.toContain('gh auth login');
    });

    it('distinguishes an unauthenticated gh and prints the login command', async () => {
      ghThrows({
        status: 4,
        stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
      });

      const code = await run(['runstate', 'last', '--issue', '440']);

      expect(code).toBe(1);
      const out = errored().join('\n');
      expect(out).toContain('gh is not authenticated');
      expect(out).toContain('gh auth login');
      expect(out).not.toContain('is not installed');
    });

    it('distinguishes an issue that does not exist', async () => {
      ghThrows({
        status: 1,
        stderr:
          'GraphQL: Could not resolve to an Issue with the number of 999999. (repository.issue)',
      });

      const code = await run(['runstate', 'last', '--issue', '999999']);

      expect(code).toBe(1);
      const out = errored().join('\n');
      expect(out).toContain('could not find it');
      expect(out).toContain('--repo');
      expect(out).not.toContain('not authenticated');
    });

    it('never swallows gh stderr, even for a cause it cannot classify', async () => {
      ghThrows({ status: 1, stderr: 'x509: certificate signed by unknown authority' });

      await run(['runstate', 'last', '--issue', '440']);

      expect(errored().join('\n')).toContain('x509: certificate signed by unknown authority');
    });

    it('explains gh output that is not JSON', async () => {
      execReturns('unknown flag: --json\n');

      const code = await run(['runstate', 'last', '--issue', '440']);

      expect(code).toBe(1);
      const out = errored().join('\n');
      expect(out).toContain('did not print JSON');
      expect(out).toContain('unknown flag: --json');
    });

    it('fails rather than reporting "no milestones" when comments is missing', async () => {
      execReturns(JSON.stringify({ title: 'something else' }));

      const code = await run(['runstate', 'last', '--issue', '440']);

      expect(code).toBe(1);
      expect(logged().some((l) => l.includes('No runstate milestones'))).toBe(false);
      expect(errored().join('\n')).toContain('no "comments" array');
    });

    it('hands back the unposted body when gh cannot post it', async () => {
      ghThrows({ status: 1, stderr: 'HTTP 403: Resource not accessible by integration' });

      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'base_branch=main',
        '--kv',
        'warnings=0',
      ]);

      expect(code).toBe(1);
      const out = errored().join('\n');
      expect(out).toContain('Failed to post');
      expect(out).toContain('lacks access');
      expect(out).toContain('was NOT posted');
      expect(out).toContain('gh issue comment 440');
      expect(out).toContain(RUNSTATE_MARKER);
    });
  });

  describe('verify degrades loudly, not silently', () => {
    const SHIP = [
      RUNSTATE_MARKER,
      'phase=ship status=awaiting-merge run=r-440-ab56 at=2026-08-24T10:05:00Z',
      'pr=441',
      'head=abc1234',
      'ci_fix_attempts=0',
      'next=ship',
      '',
    ].join('\n');

    it('warns on stderr when a probe could not answer, and still exits 0', async () => {
      execHandles((file, args) => {
        if (file === 'gh' && args[0] === 'issue') return commentsPayload([SHIP]);
        throw Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: 'GraphQL: Could not resolve to a PullRequest',
        });
      });

      const code = await run(['runstate', 'verify', '--issue', '440']);

      expect(code).toBeUndefined();
      expect(logged()).toContain('resume_from=ship');
      const warned = errored().join('\n');
      expect(warned).toContain('could not check everything');
      expect(warned).toContain('PR 441');
      expect(warned).toContain('Could not resolve to a PullRequest');
    });

    it('reports the same warnings in --json without disturbing stdout', async () => {
      execHandles((file, args) => {
        if (file === 'gh' && args[0] === 'issue') return commentsPayload([SHIP]);
        throw Object.assign(new Error('Command failed'), { status: 1, stderr: 'boom' });
      });

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      const parsed = JSON.parse(logged()[0]);
      expect(parsed.resume_from).toBe('ship');
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0]).toContain('PR 441');
    });

    it('adds no warnings when every probe answers', async () => {
      execReturns(commentsPayload([GATE_MILESTONE]));

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      expect(JSON.parse(logged()[0]).warnings).toBeUndefined();
      expect(errored()).toHaveLength(0);
    });
  });
  // Milestone values come back off a GitHub issue, where anyone with an account can post
  // a `<!-- runstate:v1 -->` comment. They are never shell-interpolated, but they do
  // become argv entries, where a leading `-` is read as a flag rather than as data.
  describe('untrusted milestone values', () => {
    it('refuses a forged pr= that would be read by gh as a flag', async () => {
      const ship = [
        RUNSTATE_MARKER,
        'phase=ship status=awaiting-merge run=r-440-ab56 at=2026-08-24T10:05:00Z',
        'pr=--repo=attacker/repo',
        'head=abc1234',
        'ci_fix_attempts=0',
        'next=ship',
        '',
      ].join('\n');
      execReturns(commentsPayload([ship]));

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      // gh was asked about the issue, never about a PR called `--repo=attacker/repo`.
      for (const [, args] of mockedExec.mock.calls) {
        expect((args ?? []) as string[]).not.toContain('--repo=attacker/repo');
        expect(((args ?? []) as string[])[0]).not.toBe('pr');
      }
      const parsed = JSON.parse(logged()[0]);
      expect(parsed.resume_from).toBe('ship');
      expect(parsed.warnings.join(' ')).toContain('refusing to pass it to gh');
    });

    it('refuses a forged branch= that would be read by git as a flag', async () => {
      const setup = [
        RUNSTATE_MARKER,
        'phase=setup status=done run=r-440-ab56 at=2026-08-24T10:01:00Z',
        'branch=--upload-pack=touch-pwned',
        'worktree=/definitely/not/a/real/path/for/tests',
        'pool_claimed=false',
        'base_branch=main',
        'next=plan',
        '',
      ].join('\n');
      execReturns(commentsPayload([setup]));

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      for (const [, args] of mockedExec.mock.calls) {
        expect((args ?? []) as string[]).not.toContain('--upload-pack=touch-pwned');
      }
      const parsed = JSON.parse(logged()[0]);
      expect(parsed.resume_from).toBe('setup');
      expect(parsed.verified).not.toContain('branch');
      expect(parsed.warnings.join(' ')).toContain('refusing to pass it to git');
    });

    it('never runs git in a worktree the milestone did not give as an absolute path', async () => {
      const implement = [
        RUNSTATE_MARKER,
        'phase=implement status=done run=r-440-ab56 at=2026-08-24T10:03:00Z',
        'branch=feature/440',
        'worktree=../../../elsewhere',
        'head=abc1234',
        'files=1',
        'tests_added=1',
        'tests_run=pass',
        'ci_parity=yes',
        'next=review',
        '',
      ].join('\n');
      execHandles((file, args) => {
        if (file === 'gh' && args[0] === 'issue') return commentsPayload([implement]);
        if (file === 'git' && args[0] === 'ls-remote') return '';
        throw new Error(`unexpected ${file} ${args.join(' ')}`);
      });

      await run(['runstate', 'verify', '--issue', '440', '--json']);

      for (const [, args] of mockedExec.mock.calls) {
        expect((args ?? []) as string[]).not.toContain('-C');
      }
      const parsed = JSON.parse(logged()[0]);
      expect(parsed.resume_from).toBe('setup');
      expect(parsed.warnings.join(' ')).toContain('not an absolute path');
    });

    it('refuses a --kv value carrying a newline, which would forge a second milestone line', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'report',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'pr=441',
        '--kv',
        'traps_added=1',
        // `ac*` keys are exempt from the no-spaces rule — they must NOT be exempt from this.
        '--kv',
        'ac_note=looks fine\nnext=ship',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join(' ')).toContain('newline');
    });

    it('refuses a --repo that is not an owner/name slug', async () => {
      const code = await run([
        'runstate',
        'post',
        '--issue',
        '440',
        '--phase',
        'gate',
        '--status',
        'done',
        '--run',
        'r-440-ab56',
        '--kv',
        'base_branch=main',
        '--kv',
        'warnings=0',
        '--repo',
        '--flag-not-a-repo',
      ]);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join(' ')).toContain('Invalid --repo');
    });
  });

  describe('stats', () => {
    /** A complete run: seven phases plus ship's second milestone, on round timestamps. */
    const STATS_TRAIL = [
      milestoneBody('gate', 'done', 'r-451-1eba', '2026-08-24T10:00:00Z', {
        model: 'claude-opus-5',
      }),
      milestoneBody('setup', 'done', 'r-451-1eba', '2026-08-24T10:02:00Z'),
      milestoneBody('plan', 'done', 'r-451-1eba', '2026-08-24T10:07:00Z'),
      milestoneBody('implement', 'done', 'r-451-1eba', '2026-08-24T10:37:00Z'),
      milestoneBody('review', 'done', 'r-451-1eba', '2026-08-24T11:07:00Z'),
      milestoneBody('ship', 'awaiting-merge', 'r-451-1eba', '2026-08-24T11:09:00Z', { pr: '452' }),
      milestoneBody('ship', 'done', 'r-451-1eba', '2026-08-24T11:24:00Z'),
      milestoneBody('report', 'done', 'r-451-1eba', '2026-08-24T11:25:00Z'),
    ];

    it('prints a per-phase table for one issue', async () => {
      execReturns(commentsPayload(STATS_TRAIL));

      await run(['runstate', 'stats', '--issue', '451']);

      const out = logged().join('\n');
      expect(out).toContain('Issue #451 — run r-451-1eba');
      expect(out).toContain('model claude-opus-5');
      expect(out).toContain('phase');
      expect(out).toContain('duration');
      expect(out).toContain('setup');
      expect(out).toContain('2m 0s (120s)');
      // The ship awaiting-merge → done gap is its own row.
      expect(out).toContain('merge-wait');
      expect(out).toContain('15m 0s (900s)');
      // Whole-run total.
      expect(out).toContain('1h 25m (5100s)');
    });

    it('aligns the phase table into columns', async () => {
      execReturns(commentsPayload(STATS_TRAIL));

      await run(['runstate', 'stats', '--issue', '451']);

      // The fixture is fully deterministic, so assert the rendered rows verbatim — every
      // column of every row, rather than re-deriving column offsets from the output.
      const table = logged()
        .join('\n')
        .split('\n')
        .filter((l) => l.startsWith('  '));
      expect(table).toEqual([
        '  phase       status          started               ended                       duration',
        '  gate        done            -                     2026-08-24T10:00:00Z               -',
        '  setup       done            2026-08-24T10:00:00Z  2026-08-24T10:02:00Z    2m 0s (120s)',
        '  plan        done            2026-08-24T10:02:00Z  2026-08-24T10:07:00Z    5m 0s (300s)',
        '  implement   done            2026-08-24T10:07:00Z  2026-08-24T10:37:00Z  30m 0s (1800s)',
        '  review      done            2026-08-24T10:37:00Z  2026-08-24T11:07:00Z  30m 0s (1800s)',
        '  ship        awaiting-merge  2026-08-24T11:07:00Z  2026-08-24T11:09:00Z    2m 0s (120s)',
        '  merge-wait  done            2026-08-24T11:09:00Z  2026-08-24T11:24:00Z   15m 0s (900s)',
        '  report      done            2026-08-24T11:24:00Z  2026-08-24T11:25:00Z     1m 0s (60s)',
      ]);
    });

    it('reads the trail with a single read-only gh issue view', async () => {
      execReturns(commentsPayload(STATS_TRAIL));

      await run(['runstate', 'stats', '--issue', '451']);

      expect(mockedExec).toHaveBeenCalledTimes(1);
      const [file, args] = mockedExec.mock.calls[0];
      expect(file).toBe('gh');
      expect(args).toEqual(['issue', 'view', '451', '--json', 'comments']);
    });

    it('forwards --repo to gh', async () => {
      execReturns(commentsPayload(STATS_TRAIL));

      await run(['runstate', 'stats', '--issue', '451', '--repo', 'imboard-ai/ai-dossier']);

      const [, args] = mockedExec.mock.calls[0];
      expect(args).toEqual([
        'issue',
        'view',
        '451',
        '--json',
        'comments',
        '--repo',
        'imboard-ai/ai-dossier',
      ]);
    });

    it('emits per-run phases and aggregates as JSON', async () => {
      execReturns(commentsPayload(STATS_TRAIL));

      await run(['runstate', 'stats', '--issue', '451', '--json']);

      const report = JSON.parse(logged().join('\n'));
      expect(report.issues).toEqual([451]);
      expect(report.runs).toHaveLength(1);
      expect(report.runs[0].run).toBe('r-451-1eba');
      expect(report.runs[0].model).toBe('claude-opus-5');
      expect(report.runs[0].total_seconds).toBe(5100);
      expect(report.runs[0].phases).toHaveLength(8);
      expect(report.runs[0].phases[1]).toEqual({
        phase: 'setup',
        status: 'done',
        started_at: '2026-08-24T10:00:00Z',
        ended_at: '2026-08-24T10:02:00Z',
        seconds: 120,
      });
      expect(report.aggregates.phases.map((p: { phase: string }) => p.phase)).toContain(
        'merge-wait'
      );
      expect(report.aggregates.models[0]).toMatchObject({ model: 'claude-opus-5', runs: 1 });
      expect(report.warnings).toEqual([]);
      expect(report.issues_without_trail).toEqual([]);
    });

    it('aggregates across an issue list without printing every phase table', async () => {
      execHandles((_file, args) => {
        const issue = args[2];
        return commentsPayload(
          STATS_TRAIL.map((body) => body.replace(/r-451-1eba/g, `r-${issue}-aaaa`))
        );
      });

      await run(['runstate', 'stats', '--issues', '451,452']);

      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(mockedExec.mock.calls.map((c) => c[1]?.[2])).toEqual(['451', '452']);
      const out = logged().join('\n');
      expect(out).toContain('Per-phase duration across 2 run(s)');
      expect(out).toContain('Per-run total');
      expect(out).toContain('By model');
      // Per-run phase tables are suppressed for a multi-issue selection.
      expect(out).not.toContain('Issue #451 — run');
    });

    it('expands a range in --issues', async () => {
      execHandles(() => commentsPayload([]));

      await run(['runstate', 'stats', '--issues', '10..12']);

      expect(mockedExec.mock.calls.map((c) => c[1]?.[2])).toEqual(['10', '11', '12']);
    });

    it('omits the aggregate tables for a single run, which would restate its own table', async () => {
      execReturns(commentsPayload(STATS_TRAIL));

      await run(['runstate', 'stats', '--issue', '451']);

      const out = logged().join('\n');
      expect(out).toContain('Issue #451 — run r-451-1eba');
      expect(out).not.toContain('Per-phase duration across');
      expect(out).not.toContain('By model');
    });

    it('prints the aggregate tables when one issue carries more than one run', async () => {
      execReturns(
        commentsPayload([
          ...STATS_TRAIL,
          milestoneBody('gate', 'done', 'r-451-2222', '2026-08-24T12:00:00Z'),
          milestoneBody('setup', 'done', 'r-451-2222', '2026-08-24T12:03:00Z'),
        ])
      );

      await run(['runstate', 'stats', '--issue', '451']);

      const out = logged().join('\n');
      expect(out).toContain('Issue #451 — run r-451-1eba');
      expect(out).toContain('Issue #451 — run r-451-2222');
      expect(out).toContain('Per-phase duration across 2 run(s)');
      // setup now has two samples with a real spread.
      expect(out).toContain('3m 0s (180s)');
    });

    it('says so and exits 0 when the issue has no runstate comments', async () => {
      execReturns(commentsPayload(['a plain comment', 'another one']));

      const code = await run(['runstate', 'stats', '--issue', '451']);

      expect(code).toBeUndefined();
      expect(logged().join('\n')).toContain('has no runstate milestones');
    });

    it('warns on stderr about an unusable at= and still exits 0', async () => {
      execReturns(
        commentsPayload([
          milestoneBody('gate', 'done', 'r-451-1eba', '$(date -u +%Y-%m-%dT%H:%M:%SZ)'),
          milestoneBody('setup', 'done', 'r-451-1eba', '2026-08-24T10:02:00Z'),
          milestoneBody('plan', 'done', 'r-451-1eba', '2026-08-24T10:07:00Z'),
        ])
      );

      const code = await run(['runstate', 'stats', '--issue', '451']);

      expect(code).toBeUndefined();
      expect(errored().join(' ')).toContain('unusable at=');
      // stdout stays a parseable table.
      expect(logged().join('\n')).toContain('plan');
    });

    it('still reports the one run a multi-issue selection found', async () => {
      // The regression this guards: per-run tables are suppressed for a multi-issue
      // selection, so gating the aggregates on `runs.length > 1` printed NOTHING about
      // the only run that was actually measured — silently, exit 0.
      execHandles((_file, args) =>
        commentsPayload(args[2] === '451' ? STATS_TRAIL : ['a plain comment'])
      );

      await run(['runstate', 'stats', '--issues', '451,452']);

      const out = logged().join('\n');
      expect(out).toContain('Issue #452 has no runstate milestones');
      expect(out).toContain('Per-run total');
      expect(out).toContain('r-451-1eba');
      expect(out).toContain('1h 25m (5100s)');
    });

    it('reports how far each run got, so an in-flight run is not read as a fast one', async () => {
      execHandles((_file, args) =>
        commentsPayload(args[2] === '451' ? STATS_TRAIL : ['a plain comment'])
      );

      await run(['runstate', 'stats', '--issues', '451,452']);

      const totals = logged()
        .join('\n')
        .split('\n')
        .find((l) => l.includes('r-451-1eba'));
      expect(totals).toContain('report/done');
    });

    it('keeps going past an issue it cannot read, and says which it left out', async () => {
      execHandles((_file, args) => {
        if (args[2] === '452') {
          const err = new Error('gh failed') as Error & { status: number; stderr: string };
          err.status = 1;
          err.stderr = 'gh: Could not resolve to an Issue with the number of 452.';
          throw err;
        }
        return commentsPayload(STATS_TRAIL);
      });

      const code = await run(['runstate', 'stats', '--issues', '451,452,453']);

      // All three were attempted — one bad issue must not cancel the rest.
      expect(code).toBeUndefined();
      expect(mockedExec.mock.calls.map((c) => c[1]?.[2])).toEqual(['451', '452', '453']);
      expect(logged().join('\n')).toContain('Per-run total');
      const errors = errored().join(' ');
      expect(errors).toContain('could not read issue #452');
      expect(errors).toContain('left it out of the report');
    });

    it('records the failed issues in the JSON report', async () => {
      execHandles((_file, args) => {
        if (args[2] === '452') {
          const err = new Error('gh failed') as Error & { status: number; stderr: string };
          err.status = 1;
          err.stderr = 'gh: Could not resolve to an Issue with the number of 452.';
          throw err;
        }
        return commentsPayload(STATS_TRAIL);
      });

      await run(['runstate', 'stats', '--issues', '451,452', '--json']);

      const report = JSON.parse(logged().join('\n'));
      expect(report.issues_failed).toHaveLength(1);
      expect(report.issues_failed[0].issue).toBe(452);
      expect(report.issues).toEqual([451]);
    });

    it('fails when every issue in the selection is unreadable', async () => {
      execHandles(() => {
        const err = new Error('gh failed') as Error & { status: number; stderr: string };
        err.status = 1;
        err.stderr = 'gh: Could not resolve to an Issue.';
        throw err;
      });

      const code = await run(['runstate', 'stats', '--issues', '451,452']);

      // Nothing to report is a real failure, not a degraded read.
      expect(code).toBe(1);
    });

    it('emits warnings on stderr under --json too, matching verify', async () => {
      execReturns(
        commentsPayload([
          milestoneBody('gate', 'done', 'r-451-1eba', '$(date -u +%Y-%m-%dT%H:%M:%SZ)'),
          milestoneBody('setup', 'done', 'r-451-1eba', '2026-08-24T10:02:00Z'),
          milestoneBody('plan', 'done', 'r-451-1eba', '2026-08-24T10:07:00Z'),
        ])
      );

      await run(['runstate', 'stats', '--issue', '451', '--json']);

      // stdout stays pure JSON; stderr still says the report is degraded.
      expect(() => JSON.parse(logged().join('\n'))).not.toThrow();
      expect(errored().join(' ')).toContain('stats could not measure everything');
    });

    it('names its source in warnings, so a fleet log stays readable', async () => {
      execReturns(
        commentsPayload([
          milestoneBody('gate', 'done', 'r-451-1eba', '$(date -u)'),
          milestoneBody('setup', 'done', 'r-451-1eba', '2026-08-24T10:02:00Z'),
          milestoneBody('plan', 'done', 'r-451-1eba', '2026-08-24T10:07:00Z'),
        ])
      );

      await run(['runstate', 'stats', '--issue', '451', '--repo', 'imboard-ai/ai-dossier']);

      expect(errored().join(' ')).toContain('stats could not measure everything');
      expect(errored().join(' ')).toContain('imboard-ai/ai-dossier#451');
    });

    it('marks an aggregate row whose samples include a clock-skewed span', async () => {
      execHandles((_file, args) =>
        commentsPayload(
          args[2] === '451'
            ? [
                milestoneBody('gate', 'done', 'r-451-aaaa', '2026-08-24T10:05:00Z'),
                milestoneBody('setup', 'done', 'r-451-aaaa', '2026-08-24T10:00:00Z'),
              ]
            : [
                milestoneBody('gate', 'done', 'r-452-bbbb', '2026-08-24T10:00:00Z'),
                milestoneBody('setup', 'done', 'r-452-bbbb', '2026-08-24T10:02:00Z'),
              ]
        )
      );

      await run(['runstate', 'stats', '--issues', '451,452']);

      const setupRow = logged()
        .join('\n')
        .split('\n')
        .find((l) => l.trimStart().startsWith('setup'));
      expect(setupRow).toContain('1 skewed');
    });

    it('sanitises a forged milestone rather than letting it repaint the table', async () => {
      execReturns(
        commentsPayload([
          milestoneBody('gate', 'done', 'r-451-1eba', '2026-08-24T10:00:00Z', {
            model: 'claude\u001b[2K-spoofed',
          }),
          milestoneBody('setup', 'done', 'r-451-1eba', '2026-08-24T10:02:00Z'),
        ])
      );

      await run(['runstate', 'stats', '--issue', '451']);

      const out = logged().join('\n');
      expect(out).toContain('claude');
      expect(out).not.toContain('\u001b[2K');
    });

    it('writes fan-out progress to a stderr TTY, keeping stdout a clean table', async () => {
      execHandles(() => commentsPayload(STATS_TRAIL));
      const writes = captureStderrWrites(true);

      await run(['runstate', 'stats', '--issues', '451,452']);

      expect(writes.join('')).toContain('reading issue #451 (1/2)');
      expect(logged().join('\n')).not.toContain('reading issue');
    });

    it('writes no progress when stderr is redirected, where it would be escape noise', async () => {
      execHandles(() => commentsPayload(STATS_TRAIL));
      const writes = captureStderrWrites(false);

      await run(['runstate', 'stats', '--issues', '451,452']);

      expect(writes.join('')).toBe('');
    });

    it('refuses --issue and --issues together', async () => {
      const code = await run(['runstate', 'stats', '--issue', '451', '--issues', '451,452']);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join(' ')).toContain('not both');
    });

    it('refuses neither --issue nor --issues', async () => {
      const code = await run(['runstate', 'stats']);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join(' ')).toContain('Missing --issue or --issues');
    });

    it('refuses a malformed --issues selection before calling gh', async () => {
      const code = await run(['runstate', 'stats', '--issues', '1,abc']);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join(' ')).toContain("Invalid issue 'abc'");
    });

    it('refuses a non-numeric --issue before calling gh', async () => {
      const code = await run(['runstate', 'stats', '--issue', 'main']);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join(' ')).toContain('Invalid --issue');
    });

    it('refuses a --repo that is not an owner/name slug on a --issues run', async () => {
      const code = await run(['runstate', 'stats', '--issues', '1,2', '--repo', '--flag']);

      expect(code).toBe(1);
      expect(mockedExec).not.toHaveBeenCalled();
      expect(errored().join(' ')).toContain('Invalid --repo');
    });

    it('reports a gh failure with its cause rather than an empty table', async () => {
      execHandles(() => {
        const err = new Error('gh failed') as Error & { status: number; stderr: string };
        err.status = 1;
        err.stderr = 'gh: Could not resolve to an Issue with the number of 99999.';
        throw err;
      });

      const code = await run(['runstate', 'stats', '--issue', '99999']);

      expect(code).toBe(1);
      expect(errored().join(' ')).toContain('could not find it');
    });
  });
});
