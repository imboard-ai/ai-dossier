import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSchedCommand } from '../../commands/sched';
import { createTestProgram, execHandles, execReturns } from '../helpers/test-utils';

vi.mock('node:child_process');

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
    const journalPath = path.join(home, '.dossier', 'sched', 'test-proj', 'events.jsonl');
    const events = fs
      .readFileSync(journalPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
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
    const journalPath = path.join(home, '.dossier', 'sched', 'test-proj', 'events.jsonl');
    const events = fs
      .readFileSync(journalPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
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
