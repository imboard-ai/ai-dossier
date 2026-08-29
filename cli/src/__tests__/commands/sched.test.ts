import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSchedCommand } from '../../commands/sched';
import { createTestProgram } from '../helpers/test-utils';

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
