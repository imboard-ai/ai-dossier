import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunLogEntry } from '@ai-dossier/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSchedCommand } from '../../commands/sched';
import { checkEngineStaleness } from '../../engine-version';
import { readRunLog } from '../../run-log';
import { createTestProgram, execHandles, execReturns } from '../helpers/test-utils';

vi.mock('node:child_process');
// `cli/src/run-log.ts`'s LOG_FILE is computed once at import time from
// `os.homedir()` — this file's `vi.stubEnv('HOME', home)` (below) does not
// retroactively change it, so `sched stats` tests mock `readRunLog` directly
// rather than relying on real disk under the stubbed home (unlike the sched
// package's own state, which resolves `os.homedir()` fresh per call).
vi.mock('../../run-log');
// `engine-version.ts`'s own cache dir is the same "computed once at import
// time from os.homedir()" shape (#537) — mock `checkEngineStaleness`
// directly (like `run-log`) rather than fighting the real path under the
// stubbed home. Keep the real `formatEngineStaleWarning` — it's a pure
// string formatter with no filesystem/network dependency, and an
// auto-mocked version silently returns undefined (an empty rendered line,
// not a thrown error — the kind of failure a test wouldn't defend against
// without this comment as the tripwire).
vi.mock('../../engine-version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine-version')>();
  return { ...actual, checkEngineStaleness: vi.fn() };
});

let home: string;
let logs: string[];

/** Parse sched args against a fresh program, capturing console output. */
async function runSched(args: string[]): Promise<void> {
  const program = createTestProgram();
  registerSchedCommand(program);
  await program.parseAsync(['node', 'dossier', ...args]);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-test-home-'));
  vi.stubEnv('HOME', home);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((msg) => {
    logs.push(String(msg));
  });
  // Default: every enqueue-time label lookup ('gh issue view --json labels') finds no
  // hard-block labels, so existing tests keep their pre-#507 behavior unchanged.
  execReturns('{"labels":[]}');
  // Default: not stale, so every pre-#537 test keeps its old behavior
  // unchanged (no warning line, no journal entry, no auto-upgrade attempt).
  vi.mocked(checkEngineStaleness).mockResolvedValue({
    installed: '0.12.1',
    latest: null,
    stale: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function statePath(): string {
  return path.join(home, '.dossier', 'sched', 'test-proj', 'state.json');
}

function readState(): unknown {
  return JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
}

function journalPath(): string {
  return path.join(home, '.dossier', 'sched', 'test-proj', 'events.jsonl');
}

/** Parsed `events.jsonl` lines, or `[]` if the journal doesn't exist yet. */
function journalEvents(): Array<Record<string, unknown>> {
  if (!fs.existsSync(journalPath())) return [];
  return fs
    .readFileSync(journalPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('ai-dossier sched enqueue', () => {
  it('enqueues issues via flags and persists them', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '101,102',
      '--mode',
      'full',
      '--deps',
      '100',
      '--tier',
      'strong',
      '--project',
      'test-proj',
    ]);
    expect(logs.join('\n')).toContain('Enqueued 2 issue(s)');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]).toMatchObject({
      issue: 101,
      mode: 'full',
      tier: 'strong',
      deps: [100],
      status: 'queued',
    });
  });

  it('enqueues from a manifest file (AC1)', async () => {
    const manifest = path.join(home, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        project: 'test-proj',
        entries: [
          { issue: 1, mode: 'full' },
          { issue: 2, mode: 'slot', batch: 'b1', deps: [1] },
        ],
      })
    );
    await runSched(['sched', 'enqueue', '--from-manifest', manifest, '--project', 'test-proj']);
    expect(logs.join('\n')).toContain('Enqueued 2 issue(s)');
    const state = readState() as { entries: unknown[]; batches: Array<Record<string, unknown>> };
    expect(state.entries).toHaveLength(2);
    expect(state.batches[0]).toMatchObject({ id: 'b1', members: [2] });
  });

  it('--more-members-expected holds a batch open; the next call without it seals (#535 AC1)', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '1',
      '--mode',
      'slot',
      '--batch',
      'b1',
      '--more-members-expected',
      '--project',
      'test-proj',
    ]);
    let state = readState() as { batches: Array<Record<string, unknown>> };
    expect(state.batches[0]).toMatchObject({ id: 'b1', status: 'forming' });

    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '2',
      '--mode',
      'slot',
      '--batch',
      'b1',
      '--project',
      'test-proj',
    ]);
    state = readState() as { batches: Array<Record<string, unknown>> };
    expect(state.batches[0]).toMatchObject({ id: 'b1', status: 'ready', members: [1, 2] });
  });

  it('flags and manifest entries combine into one enqueue', async () => {
    const manifest = path.join(home, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({ entries: [{ issue: 9, mode: 'slot', batch: 'bz' }] })
    );
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '8',
      '--from-manifest',
      manifest,
      '--project',
      'test-proj',
    ]);
    const state = readState() as { entries: number[] };
    expect(state.entries).toHaveLength(2);
  });

  it('--json emits machine-readable output', async () => {
    await runSched(['sched', 'enqueue', '--issues', '5', '--project', 'test-proj', '--json']);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed).toMatchObject({ project: 'test-proj', enqueued: 1, queue_depth: 1 });
  });

  it('rejects slot mode without a batch (state file untouched)', async () => {
    await expect(
      runSched(['sched', 'enqueue', '--issues', '7', '--mode', 'slot', '--project', 'test-proj'])
    ).rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('rejects garbage issue numbers', async () => {
    await expect(
      runSched(['sched', 'enqueue', '--issues', 'abc', '--project', 'test-proj'])
    ).rejects.toThrow('process.exit(1)');
  });

  it('rejects a dependency cycle across two enqueues', async () => {
    await runSched(['sched', 'enqueue', '--issues', '1', '--deps', '2', '--project', 'test-proj']);
    await expect(
      runSched(['sched', 'enqueue', '--issues', '2', '--deps', '1', '--project', 'test-proj'])
    ).rejects.toThrow('process.exit(1)');
  });

  it('#507: an issue carrying a hard-block label lands blocked, not queued', async () => {
    execReturns('{"labels":[{"name":"decision-pending"},{"name":"bug"}]}');
    await runSched(['sched', 'enqueue', '--issues', '9', '--project', 'test-proj']);
    expect(logs.join('\n')).toContain('0 queued, 1 blocked-by-label');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries[0]).toMatchObject({
      issue: 9,
      status: 'blocked',
      reason: 'label:decision-pending',
    });
    expect(journalEvents()).toContainEqual(
      expect.objectContaining({
        event: 'label-blocked',
        issue: 9,
        reason: 'label:decision-pending',
      })
    );
  });

  it('#507: label matching is case-insensitive', async () => {
    execReturns('{"labels":[{"name":"Epic"}]}');
    await runSched(['sched', 'enqueue', '--issues', '13', '--project', 'test-proj']);
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries[0]).toMatchObject({ issue: 13, status: 'blocked', reason: 'label:epic' });
  });

  it('#507: an issue without a hard-block label enqueues as queued, as before', async () => {
    execReturns('{"labels":[{"name":"bug"},{"name":"priority-high"}]}');
    await runSched(['sched', 'enqueue', '--issues', '10', '--project', 'test-proj']);
    expect(logs.join('\n')).toContain('1 queued');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries[0]).toMatchObject({ issue: 10, status: 'queued', reason: null });
  });

  it('#507: a failed gh label lookup fails open — enqueues as queued with a warning, and journals it', async () => {
    execHandles(() => {
      throw Object.assign(new Error('gh: command not found'), { code: 'ENOENT' });
    });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg) => {
      errors.push(String(msg));
    });
    await runSched(['sched', 'enqueue', '--issues', '11', '--project', 'test-proj']);
    expect(errors.join('\n')).toContain('Could not read labels for issue #11');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries[0]).toMatchObject({ issue: 11, status: 'queued', reason: null });
    expect(journalEvents()).toContainEqual(
      expect.objectContaining({ event: 'label-check-failed', issue: 11 })
    );
  });

  it('#507: --json reports blocked_by_label, label_check_failed, and queued alongside queue_depth', async () => {
    execReturns('{"labels":[{"name":"epic"}]}');
    await runSched(['sched', 'enqueue', '--issues', '12', '--project', 'test-proj', '--json']);
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toMatchObject({
      project: 'test-proj',
      enqueued: 1,
      queued: 0,
      blocked_by_label: [{ issue: 12, label: 'epic' }],
      label_check_failed: [],
      queue_depth: 1,
    });
  });

  it('#507: a mixed enqueue reports the correct per-issue split', async () => {
    execHandles((_file, args) =>
      args[2] === '20' ? '{"labels":[{"name":"epic"}]}' : '{"labels":[]}'
    );
    await runSched(['sched', 'enqueue', '--issues', '20,21,22', '--project', 'test-proj']);
    expect(logs.join('\n')).toContain('2 queued, 1 blocked-by-label');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries.find((e) => e.issue === 20)).toMatchObject({ status: 'blocked' });
    expect(state.entries.find((e) => e.issue === 21)).toMatchObject({ status: 'queued' });
    expect(state.entries.find((e) => e.issue === 22)).toMatchObject({ status: 'queued' });
  });

  it('#507: --repo is forwarded to the gh label lookup', async () => {
    const seenArgs: string[][] = [];
    execHandles((_file, args) => {
      seenArgs.push(args);
      return '{"labels":[]}';
    });
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '30',
      '--project',
      'test-proj',
      '--repo',
      'imboard-ai/ai-dossier',
    ]);
    expect(seenArgs).toContainEqual(expect.arrayContaining(['--repo', 'imboard-ai/ai-dossier']));
  });

  it('#507: rejects a malformed --repo before any gh call', async () => {
    await expect(
      runSched([
        'sched',
        'enqueue',
        '--issues',
        '30',
        '--project',
        'test-proj',
        '--repo',
        'not-a-slug',
      ])
    ).rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('#507: caps the manifest-path label pre-screen at MAX_ISSUE_SELECTION (uncapped before #507)', async () => {
    const manifest = path.join(home, 'manifest.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        entries: Array.from({ length: 201 }, (_, i) => ({ issue: i + 1, mode: 'full' })),
      })
    );
    await expect(
      runSched(['sched', 'enqueue', '--from-manifest', manifest, '--project', 'test-proj'])
    ).rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('#565: --priority sets a full-cycle entry priority; omitted defaults to 0', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '101',
      '--priority',
      '7',
      '--project',
      'test-proj',
    ]);
    await runSched(['sched', 'enqueue', '--issues', '102', '--project', 'test-proj']);
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries.find((e) => e.issue === 101)?.priority).toBe(7);
    expect(state.entries.find((e) => e.issue === 102)?.priority).toBe(0);
  });

  it('#565: a --mode slot batch defaults to priority 10, and --priority overrides it', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '201',
      '--mode',
      'slot',
      '--batch',
      'b1',
      '--project',
      'test-proj',
    ]);
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '202',
      '--mode',
      'slot',
      '--batch',
      'b2',
      '--priority',
      '99',
      '--project',
      'test-proj',
    ]);
    const state = readState() as { batches: Array<Record<string, unknown>> };
    expect(state.batches.find((b) => b.id === 'b1')?.priority).toBe(10);
    expect(state.batches.find((b) => b.id === 'b2')?.priority).toBe(99);
  });

  it('#565: --priority rejects a non-integer', async () => {
    await expect(
      runSched([
        'sched',
        'enqueue',
        '--issues',
        '101',
        '--priority',
        'high',
        '--project',
        'test-proj',
      ])
    ).rejects.toThrow('process.exit(1)');
  });

  it('#565: --priority is rejected with --from-manifest (would otherwise be silently discarded)', async () => {
    const manifest = path.join(home, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ entries: [{ issue: 1, mode: 'full' }] }));
    await expect(
      runSched([
        'sched',
        'enqueue',
        '--from-manifest',
        manifest,
        '--priority',
        '5',
        '--project',
        'test-proj',
      ])
    ).rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('#565: a second enqueue call joining an existing batch does not re-point its priority (review regression)', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '201',
      '--mode',
      'slot',
      '--batch',
      'b1',
      '--priority',
      '99',
      '--more-members-expected',
      '--project',
      'test-proj',
    ]);
    // No --priority on the second call — the CLI must NOT inject the
    // configured default (10) here, or enqueue.ts's assertBatchFactsAgree
    // rejects the call as "refusing to re-point" a priority the operator
    // never touched.
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '202',
      '--mode',
      'slot',
      '--batch',
      'b1',
      '--project',
      'test-proj',
    ]);
    const state = readState() as { batches: Array<Record<string, unknown>> };
    expect(state.batches.find((b) => b.id === 'b1')).toMatchObject({
      priority: 99,
      status: 'ready',
      members: [201, 202],
    });
  });

  it('#565: --mode slot --priority sets the batch priority; the member entry keeps the default and status shows "-"', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '201',
      '--mode',
      'slot',
      '--batch',
      'b1',
      '--priority',
      '77',
      '--project',
      'test-proj',
    ]);
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries[0]).toMatchObject({ issue: 201, priority: 0 });

    logs.length = 0;
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const queueSection = logs.join('\n').split('== Batches ==')[0];
    expect(queueSection).toMatch(/#201\s+slot\s+b1\s+-/);
  });
});

describe('ai-dossier sched start (#537: engine-stale detection)', () => {
  it('runs a tick cleanly and journals nothing when the engine is not stale', async () => {
    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);
    expect(journalEvents().some((e) => e.event === 'engine-stale')).toBe(false);
  });

  it('journals engine-stale once when the installed engine is behind npm latest', async () => {
    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.13.0',
      stale: true,
    });

    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);

    const staleEvents = journalEvents().filter((e) => e.event === 'engine-stale');
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]).toMatchObject({ installed_version: '0.12.1', latest_version: '0.13.0' });
  });

  it('does not journal a second engine-stale event for the same (installed, latest) pair', async () => {
    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.13.0',
      stale: true,
    });

    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);
    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);
    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);

    const staleEvents = journalEvents().filter((e) => e.event === 'engine-stale');
    expect(staleEvents).toHaveLength(1);
  });

  it('journals a new engine-stale event once npm latest advances again', async () => {
    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.13.0',
      stale: true,
    });
    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);

    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.14.0',
      stale: true,
    });
    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);

    const staleEvents = journalEvents().filter((e) => e.event === 'engine-stale');
    expect(staleEvents).toHaveLength(2);
    expect(staleEvents[1]).toMatchObject({ latest_version: '0.14.0' });
  });

  it('--auto-upgrade self-upgrades when stale and no unit is mid-dispatch', async () => {
    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.13.0',
      stale: true,
    });
    vi.mocked(execFileSync).mockClear();

    await runSched(['sched', 'start', '--once', '--auto-upgrade', '--project', 'test-proj']);

    const upgradeCalls = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file, args]) => file === 'npm' && (args as string[])[0] === 'i');
    expect(upgradeCalls).toHaveLength(1);
    expect(upgradeCalls[0][1]).toEqual(['i', '-g', '@ai-dossier/cli@latest']);
  });

  it('without --auto-upgrade, stale never triggers an upgrade', async () => {
    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.13.0',
      stale: true,
    });
    vi.mocked(execFileSync).mockClear();

    await runSched(['sched', 'start', '--once', '--project', 'test-proj']);

    const upgradeCalls = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file, args]) => file === 'npm' && (args as string[])[0] === 'i');
    expect(upgradeCalls).toHaveLength(0);
  });

  it('--auto-upgrade does NOT self-upgrade while a unit is mid-dispatch', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    const state = readState() as Record<string, unknown>;
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        ...state,
        slots: [
          {
            id: 1,
            status: 'running',
            unit: 'issue:101',
            pid: null,
            phase: null,
            last_progress_at: null,
            recoveries: 0,
            updated_at: new Date().toISOString(),
          },
        ],
      })
    );
    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.13.0',
      stale: true,
    });
    vi.mocked(execFileSync).mockClear();

    await runSched(['sched', 'start', '--once', '--auto-upgrade', '--project', 'test-proj']);

    const upgradeCalls = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file, args]) => file === 'npm' && (args as string[])[0] === 'i');
    expect(upgradeCalls).toHaveLength(0);
    // The stale signal is still journaled — only the upgrade itself is gated.
    expect(journalEvents().some((e) => e.event === 'engine-stale')).toBe(true);
  });
});

describe('ai-dossier sched status', () => {
  it('renders queue, slots, batches, blocked, and runnable units after enqueue', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101,102', '--project', 'test-proj']);
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    expect(text).toContain('Scheduler [test-proj]');
    expect(text).toContain('Runnable units: issue:101, issue:102');
    expect(text).toContain('== Queue ==');
    expect(text).toContain('#101');
    expect(text).toContain('== Blocked ==');
    expect(text).toContain('(none)');
  });

  it('#544: a label-blocked entry reports when the engine last re-read labels', async () => {
    execReturns('{"labels":[{"name":"decision-pending"}]}');
    await runSched(['sched', 'enqueue', '--issues', '9', '--project', 'test-proj']);
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    // The section delimiter stays a fixed marker; the timestamp is its own line.
    expect(text).toContain('== Blocked ==');
    expect(text).toContain('(labels never checked)');
    expect(text).toContain('#9 [blocked] — label:decision-pending');
  });

  it('#544: a non-label block does not claim anything about labels', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '101',
      '--deps',
      '100',
      '--project',
      'test-proj',
    ]);
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    expect(text).toContain('== Blocked ==');
    expect(text).not.toContain('labels never checked');
    expect(text).not.toContain('labels last checked');
  });

  it('names deps that are not in the queue as blocked, not runnable', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '101',
      '--deps',
      '100',
      '--project',
      'test-proj',
    ]);
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    expect(text).toContain('Runnable units: none');
    expect(text).toContain('#100 is not in the queue');
  });

  it('--json exposes the report', async () => {
    await runSched(['sched', 'enqueue', '--issues', '1', '--project', 'test-proj']);
    logs.length = 0;
    await runSched(['sched', 'status', '--project', 'test-proj', '--json']);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed).toMatchObject({
      project: 'test-proj',
      paused: false,
      max_slots: 3,
      runnable: 1,
      runnable_units: ['issue:1'],
    });
    expect(parsed.queue).toHaveLength(1);
  });

  it('#505: renders a dispatch-health warning when suspect dispatches are recorded', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    const state = readState() as Record<string, unknown>;
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        ...state,
        consecutive_suspect_dispatches: 1,
        last_suspect_dispatch_unit: 'issue:101',
      })
    );

    logs.length = 0;
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    expect(text).toContain('Dispatch health: 1 consecutive suspect-dispatch exit(s)');
    expect(text).toContain('issue:101');
    expect(text).toContain('informational, below the auto-pause threshold');
  });

  it('#505: the dispatch-health warning names the pause as the likely cause once paused', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    const state = readState() as Record<string, unknown>;
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        ...state,
        paused: true,
        consecutive_suspect_dispatches: 2,
        last_suspect_dispatch_unit: 'issue:102',
      })
    );

    logs.length = 0;
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    expect(text).toContain('likely why the scheduler is paused');
  });

  it('#505: sched resume clears the dispatch-health streak', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    const state = readState() as Record<string, unknown>;
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        ...state,
        paused: true,
        consecutive_suspect_dispatches: 2,
        last_suspect_dispatch_unit: 'issue:102',
      })
    );

    await runSched(['sched', 'resume', '--project', 'test-proj']);

    logs.length = 0;
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    expect(text).not.toContain('Dispatch health:');
    const resumed = readState() as Record<string, unknown>;
    expect(resumed.consecutive_suspect_dispatches).toBe(0);
    expect(resumed.last_suspect_dispatch_unit).toBeNull();
  });

  it('renders a corrupt state file as a clean error, not a stack trace', async () => {
    await runSched(['sched', 'enqueue', '--issues', '1', '--project', 'test-proj']);
    fs.writeFileSync(statePath(), '{ not json');
    await expect(runSched(['sched', 'status', '--project', 'test-proj'])).rejects.toThrow(
      'process.exit(1)'
    );
  });

  it('#537: renders an engine-stale warning naming both versions and the upgrade command', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    vi.mocked(checkEngineStaleness).mockResolvedValue({
      installed: '0.12.1',
      latest: '0.13.0',
      stale: true,
    });

    logs.length = 0;
    await runSched(['sched', 'status', '--project', 'test-proj']);
    const text = logs.join('\n');
    expect(text).toContain('Engine stale');
    expect(text).toContain('0.12.1');
    expect(text).toContain('0.13.0');
    expect(text).toContain('npm i -g @ai-dossier/cli@latest');
  });

  it('#537: no engine-stale warning when the installed engine is current', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    // beforeEach's default mock already reports stale: false.

    logs.length = 0;
    await runSched(['sched', 'status', '--project', 'test-proj']);
    expect(logs.join('\n')).not.toContain('Engine stale');
  });
});

describe('ai-dossier sched pause/resume/abandon', () => {
  it('pauses and resumes, persisting the flag', async () => {
    await runSched(['sched', 'pause', '--project', 'test-proj']);
    expect((readState() as { paused: boolean }).paused).toBe(true);
    await runSched(['sched', 'status', '--project', 'test-proj']);
    expect(logs.join('\n')).toContain('PAUSED');

    await runSched(['sched', 'resume', '--project', 'test-proj']);
    expect((readState() as { paused: boolean }).paused).toBe(false);
    expect(logs.join('\n')).toContain('resumed');
  });

  it('pause --json reports project and state', async () => {
    await runSched(['sched', 'pause', '--project', 'test-proj', '--json']);
    expect(JSON.parse(logs.join(''))).toEqual({ project: 'test-proj', paused: true });
  });

  it('abandons an issue, recording the reason', async () => {
    await runSched(['sched', 'enqueue', '--issues', '42', '--project', 'test-proj']);
    await runSched([
      'sched',
      'abandon',
      '--issue',
      '42',
      '--reason',
      'operator test',
      '--project',
      'test-proj',
    ]);
    expect(logs.join('\n')).toContain('Abandoned issue #42');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries[0]).toMatchObject({
      issue: 42,
      status: 'failed',
      reason: 'operator test',
    });
  });

  it('dissolves a batch and requeues members as full-cycle', async () => {
    const manifest = path.join(home, 'm.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        entries: [
          { issue: 1, mode: 'slot', batch: 'bx' },
          { issue: 2, mode: 'slot', batch: 'bx' },
        ],
      })
    );
    await runSched(['sched', 'enqueue', '--from-manifest', manifest, '--project', 'test-proj']);
    await runSched(['sched', 'abandon', '--batch', 'bx', '--project', 'test-proj']);
    expect(logs.join('\n')).toContain('Dissolved batch bx');
    const state = readState() as {
      entries: Array<Record<string, unknown>>;
      batches: Array<Record<string, unknown>>;
    };
    expect(state.batches[0].status).toBe('dissolved');
    expect(state.entries.every((e) => e.mode === 'full')).toBe(true);
  });

  it('rejects abandoning with both --issue and --batch', async () => {
    await expect(
      runSched(['sched', 'abandon', '--issue', '1', '--batch', 'b', '--project', 'test-proj'])
    ).rejects.toThrow('process.exit(1)');
  });

  it('rejects abandoning an unknown issue', async () => {
    await expect(
      runSched(['sched', 'abandon', '--issue', '404', '--project', 'test-proj'])
    ).rejects.toThrow('process.exit(1)');
  });
});

describe('ai-dossier sched reprioritize (#565)', () => {
  it('adjusts a queued issue in place, without abandon/re-enqueue', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    await runSched([
      'sched',
      'reprioritize',
      '--issue',
      '101',
      '--priority',
      '42',
      '--project',
      'test-proj',
    ]);
    expect(logs.join('\n')).toContain('Issue #101 priority set to 42');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries[0]).toMatchObject({ issue: 101, priority: 42, status: 'queued' });
  });

  it('adjusts a batch in place', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '201',
      '--mode',
      'slot',
      '--batch',
      'b1',
      '--project',
      'test-proj',
    ]);
    await runSched([
      'sched',
      'reprioritize',
      '--batch',
      'b1',
      '--priority',
      '99',
      '--project',
      'test-proj',
    ]);
    expect(logs.join('\n')).toContain('Batch b1 priority set to 99');
    const state = readState() as { batches: Array<Record<string, unknown>> };
    expect(state.batches[0]).toMatchObject({ id: 'b1', priority: 99 });
  });

  it('reprioritize --json reports the outcome', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    logs.length = 0;
    await runSched([
      'sched',
      'reprioritize',
      '--issue',
      '101',
      '--priority',
      '5',
      '--project',
      'test-proj',
      '--json',
    ]);
    expect(JSON.parse(logs.join(''))).toEqual({ reprioritized: 'issue:101', priority: 5 });
  });

  it('rejects reprioritizing with both --issue and --batch', async () => {
    await expect(
      runSched([
        'sched',
        'reprioritize',
        '--issue',
        '1',
        '--batch',
        'b',
        '--priority',
        '1',
        '--project',
        'test-proj',
      ])
    ).rejects.toThrow('process.exit(1)');
  });

  it('rejects reprioritizing an unknown issue', async () => {
    await expect(
      runSched([
        'sched',
        'reprioritize',
        '--issue',
        '404',
        '--priority',
        '1',
        '--project',
        'test-proj',
      ])
    ).rejects.toThrow('process.exit(1)');
  });

  it('rejects a non-integer --priority', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    await expect(
      runSched([
        'sched',
        'reprioritize',
        '--issue',
        '101',
        '--priority',
        'high',
        '--project',
        'test-proj',
      ])
    ).rejects.toThrow('process.exit(1)');
  });

  it('requires --priority', async () => {
    await runSched(['sched', 'enqueue', '--issues', '101', '--project', 'test-proj']);
    await expect(
      runSched(['sched', 'reprioritize', '--issue', '101', '--project', 'test-proj'])
    ).rejects.toThrow();
  });

  it('#565 review: rejects a multi-issue --issue selection rather than silently reprioritizing only the first', async () => {
    await runSched(['sched', 'enqueue', '--issues', '4,5', '--project', 'test-proj']);
    await expect(
      runSched([
        'sched',
        'reprioritize',
        '--issue',
        '4,5',
        '--priority',
        '10',
        '--project',
        'test-proj',
      ])
    ).rejects.toThrow('process.exit(1)');
    const state = readState() as { entries: Array<Record<string, unknown>> };
    expect(state.entries.every((e) => e.priority === 0)).toBe(true);
  });

  it('#565 review: journals a reprioritized event with the new and previous priority', async () => {
    await runSched([
      'sched',
      'enqueue',
      '--issues',
      '101',
      '--priority',
      '3',
      '--project',
      'test-proj',
    ]);
    await runSched([
      'sched',
      'reprioritize',
      '--issue',
      '101',
      '--priority',
      '42',
      '--project',
      'test-proj',
    ]);
    const events = fs
      .readFileSync(journalPath(), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = events.find((e) => e.event === 'reprioritized' && e.unit === 'issue:101');
    expect(event).toMatchObject({ priority: 42, detail: 'was 3' });
  });
});

describe('ai-dossier sched stats (#524: per-issue token/cost from runs.jsonl)', () => {
  function mockRunLog(entries: Array<Partial<RunLogEntry>>): void {
    vi.mocked(readRunLog).mockReturnValue(entries as RunLogEntry[]);
  }

  it('aggregates tokens/cost per issue, ignoring entries without a unit', () => {
    mockRunLog([
      {
        timestamp: '2026-09-01T12:00:00Z',
        unit: 'issue:524',
        input_tokens: 1000,
        output_tokens: 200,
        total_cost_usd: 0.01,
        duration_ms: 5000,
      },
      {
        timestamp: '2026-09-01T12:10:00Z',
        unit: 'issue:524',
        input_tokens: 500,
        output_tokens: 100,
        total_cost_usd: 0.005,
        duration_ms: 3000,
      },
      // An ordinary `ai-dossier run` entry — no unit — must be excluded.
      {
        timestamp: '2026-09-01T12:20:00Z',
        dossier: 'imboard-ai/git/gate-issue',
        input_tokens: 999,
      },
      {
        timestamp: '2026-09-01T12:30:00Z',
        unit: 'issue:9',
        input_tokens: 10,
        output_tokens: 2,
      },
    ]);

    return runSched(['sched', 'stats', '--json']).then(() => {
      const report = JSON.parse(logs.join(''));
      expect(report.issues).toEqual([
        {
          issue: 9,
          runs: 1,
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_tokens: null,
          cache_read_tokens: null,
          total_cost_usd: null,
          duration_ms: null,
          model: null,
          tier: null,
          usage: 'ok',
        },
        {
          issue: 524,
          runs: 2,
          input_tokens: 1500,
          output_tokens: 300,
          cache_creation_tokens: null,
          cache_read_tokens: null,
          total_cost_usd: 0.015,
          duration_ms: 8000,
          model: null,
          tier: null,
          usage: 'ok',
        },
      ]);
      expect(report.totals).toMatchObject({ runs: 3, input_tokens: 1510, output_tokens: 302 });
    });
  });

  it('restricts to --issues when given, including a zero-run row for an unrecorded issue', async () => {
    mockRunLog([{ timestamp: '2026-09-01T12:00:00Z', unit: 'issue:524', input_tokens: 100 }]);

    await runSched(['sched', 'stats', '--issues', '524,9', '--json']);

    const report = JSON.parse(logs.join(''));
    // --issues is parsed via parseIssueSelection, which returns issues in
    // ascending order regardless of the flag's input order.
    expect(report.issues.map((r: { issue: number }) => r.issue)).toEqual([9, 524]);
    expect(report.issues[0]).toMatchObject({ issue: 9, runs: 0, input_tokens: null });
  });

  it('prints a table by default and a message when there are no sched entries', async () => {
    mockRunLog([]);
    await runSched(['sched', 'stats']);
    const out = logs.join('\n');
    expect(out).toContain('No sched-dispatched runs.jsonl entries found');
    expect(out).toContain('runs.jsonl'); // the resolved log path, so an operator knows where to look
  });

  it('renders a table with a TOTAL row when not --json', async () => {
    mockRunLog([
      {
        timestamp: '2026-09-01T12:00:00Z',
        unit: 'issue:524',
        input_tokens: 1000,
        output_tokens: 200,
        total_cost_usd: 0.01,
      },
    ]);

    await runSched(['sched', 'stats']);

    const out = logs.join('\n');
    expect(out).toContain('#524');
    expect(out).toContain('TOTAL');
    expect(out).toContain('$0.0100');
  });
});

describe('ai-dossier sched stats --batch (#564: reconstructed directly from raw dispatch logs)', () => {
  function batchRunsDir(project = 'test-proj'): string {
    const dir = path.join(home, '.dossier', 'sched', project, 'runs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function fakeResultJson(costUsd: number, inputTokens: number, outputTokens: number): string {
    return JSON.stringify({
      type: 'result',
      total_cost_usd: costUsd,
      modelUsage: {
        'claude-sonnet-5': { inputTokens, outputTokens, costUSD: costUsd },
      },
    });
  }

  it('reports per-member costs reconstructed from raw logs, plus a batch-overhead line for tail/report', async () => {
    const dir = batchRunsDir();
    fs.writeFileSync(
      path.join(dir, 'batch-b1-m1-540.log'),
      fakeResultJson(2.518, 6_214_824, 47_071)
    );
    fs.writeFileSync(
      path.join(dir, 'batch-b1-m2-542.log'),
      fakeResultJson(2.606, 6_573_453, 49_888)
    );
    fs.writeFileSync(path.join(dir, 'batch-b1-tail.log'), fakeResultJson(0.5, 100_000, 5_000));

    await runSched(['sched', 'stats', '--batch', 'b1', '--project', 'test-proj', '--json']);

    const report = JSON.parse(logs.join(''));
    expect(report.batch).toBe('b1');
    expect(report.project).toBe('test-proj');
    expect(report.issues.map((r: { issue: number }) => r.issue)).toEqual([540, 542]);
    expect(report.issues.find((r: { issue: number }) => r.issue === 540)).toMatchObject({
      total_cost_usd: 2.518,
      input_tokens: 6_214_824,
    });
    expect(report.overhead_runs).toBe(1); // the tail log
    // #564 review: the overhead totals must reflect the tail log's ACTUAL
    // cost, not an all-null row from round-tripping `batch:<id>`-unit
    // entries through `buildSchedCostReport` (which only aggregates
    // `issue:<n>` units and silently zeroes anything else).
    expect(report.overhead).toMatchObject({ runs: 1, total_cost_usd: 0.5, input_tokens: 100_000 });
  });

  it('the table also shows the batch-overhead row with real, non-zero totals (not an all-null round-trip bug)', async () => {
    const dir = batchRunsDir();
    fs.writeFileSync(
      path.join(dir, 'batch-b1-m1-540.log'),
      fakeResultJson(2.518, 6_214_824, 47_071)
    );
    fs.writeFileSync(path.join(dir, 'batch-b1-tail.log'), fakeResultJson(0.5, 100_000, 5_000));

    await runSched(['sched', 'stats', '--batch', 'b1', '--project', 'test-proj']);

    const out = logs.join('\n');
    expect(out).toContain('batch-overhead');
    expect(out).toContain('$0.5000');
    expect(out).toContain('100000');
  });

  it('renders a table with a batch-overhead row and usage=missing for an unparseable log', async () => {
    const dir = batchRunsDir();
    fs.writeFileSync(path.join(dir, 'batch-b1-m1-540.log'), 'plain text, no modelUsage JSON here');

    await runSched(['sched', 'stats', '--batch', 'b1', '--project', 'test-proj']);

    const out = logs.join('\n');
    expect(out).toContain('#540');
    expect(out).toContain('missing');
    expect(out).toContain('TOTAL (members)');
  });

  it('prints a message and no table when no logs exist for the batch', async () => {
    batchRunsDir();
    await runSched(['sched', 'stats', '--batch', 'nonexistent', '--project', 'test-proj']);
    expect(logs.join('\n')).toContain("No dispatch logs found for batch 'nonexistent'");
  });

  it('rejects combining --batch with --issues', async () => {
    await expect(
      runSched(['sched', 'stats', '--batch', 'b1', '--issues', '5', '--project', 'test-proj'])
    ).rejects.toThrow('process.exit(1)');
  });
});
