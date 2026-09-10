import { describe, expect, it } from 'vitest';
import {
  createExecRunFenceBinder,
  createExecRunFenceReleaser,
  createExecRunFencer,
  parseFenceGeneration,
  takeoverLabelFor,
} from '../index';
import { recordingReturns as recordingExec } from './helpers/recording-exec';

describe('parseFenceGeneration', () => {
  it('reads the generation off the human success line', () => {
    expect(
      parseFenceGeneration('✅ fenced r-504-fc02 gen=3 takeover=slot-2-r3 → https://x/1\n')
    ).toBe(3);
  });

  it('reads a generation printed on its own line', () => {
    expect(parseFenceGeneration('gen=1')).toBe(1);
  });

  it('reads generation 0', () => {
    expect(parseFenceGeneration('gen=0')).toBe(0);
  });

  it('reports null when the command produced no output at all', () => {
    // The `ExecFn` contract: a failed subprocess is null, never a throw.
    expect(parseFenceGeneration(null)).toBeNull();
  });

  it('reports null when the output carries no generation', () => {
    expect(parseFenceGeneration('❌ Invalid run id')).toBeNull();
    expect(parseFenceGeneration('gen=')).toBeNull();
    expect(parseFenceGeneration('generation=2')).toBeNull();
  });
});

describe('createExecRunFencer', () => {
  it('shells the runstate fence subcommand with the run, phase, and takeover', () => {
    const { exec, calls } = recordingExec('✅ fenced r-504-fc02 gen=1 takeover=slot-2-r1 → url\n');
    const fencer = createExecRunFencer(exec, { repoDir: '/repo' });

    expect(fencer(504, 'r-504-fc02', 'implement', 'slot-2-r1')).toEqual({ ok: true, gen: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('ai-dossier');
    expect(calls[0].args).toEqual([
      'runstate',
      'fence',
      '--issue',
      '504',
      '--run',
      'r-504-fc02',
      '--phase',
      'implement',
      '--takeover',
      'slot-2-r1',
      // Read the CLI's machine contract, not its display string: a reworded success
      // line must never silently stop the ladder from fencing.
      '--json',
    ]);
    expect(calls[0].cwd).toBe('/repo');
  });

  it('honours a custom binary', () => {
    const { exec, calls } = recordingExec('gen=1');
    createExecRunFencer(exec, { bin: '/opt/ai-dossier' })(1, 'r-1-a', 'gate', 't');
    expect(calls[0].file).toBe('/opt/ai-dossier');
  });

  it('reports WHY it could not fence, rather than guessing a generation', () => {
    // A guessed generation is worse than none: the takeover would post at a generation
    // its own fence never installed and be locked out by the CLI.
    const { exec } = recordingExec(null);
    const outcome = createExecRunFencer(exec)(504, 'r-504-fc02', 'implement', 'slot-2-r1');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('produced no output');
  });

  it('reads the generation out of the --json payload', () => {
    const { exec } = recordingExec(JSON.stringify({ posted: true, gen: 4, run: 'r-504-fc02' }));
    expect(createExecRunFencer(exec)(504, 'r-504-fc02', 'implement', 'slot-2-r4')).toEqual({
      ok: true,
      gen: 4,
    });
  });

  it('warns that the fence MAY have landed when the output carries no generation', () => {
    // The fencer times out AFTER `gh issue comment` returns: the trail is fenced but the
    // engine cannot know it. Asserting "unfenced" there would be a lie in the journal.
    const { exec } = recordingExec('some unexpected output');
    const outcome = createExecRunFencer(exec)(504, 'r-504-fc02', 'implement', 'slot-2-r1');
    expect(outcome.ok === false && outcome.reason).toContain('MAY still have landed');
  });
});

describe('takeoverLabelFor (#683 AC7 — one spelling of the label)', () => {
  it('spells slot N, recovery r', () => {
    expect(takeoverLabelFor(3, 1)).toBe('slot-3-r1');
  });

  it('agrees with every reader of the same dispatch: the fence announces it, the bind and release name it', () => {
    // writeFence computes `recoveries + 1` (the bump has not landed yet); the spawn-path
    // bind and the exit-path release read the BUMPED counter. Same numbers, same label —
    // a drift here would leave a fence, its bind, and its release naming different
    // records on the trail.
    expect(takeoverLabelFor(1, 2 + 1)).toBe(takeoverLabelFor(1, 3));
  });
});

describe('createExecRunFenceBinder (#683 AC2 — liveness witness for the fence)', () => {
  it('shells fence-bind with the fence coordinates and the owner pid identity', () => {
    const { exec, calls } = recordingExec('✅ bound r-504-fc02 gen=1 owner pid=4242 → url\n');
    const binder = createExecRunFenceBinder(exec, { repoDir: '/repo' });

    expect(binder(504, 'r-504-fc02', 'implement', 'slot-2-r1', 1, 4242, 987654)).toEqual({
      ok: true,
      gen: 1,
    });
    expect(calls[0].args).toEqual([
      'runstate',
      'fence-bind',
      '--issue',
      '504',
      '--run',
      'r-504-fc02',
      '--phase',
      'implement',
      '--takeover',
      'slot-2-r1',
      '--gen',
      '1',
      '--pid',
      '4242',
      // The start-time is the pid-identity half: without it a reused pid reads as a
      // live owner (#472).
      '--pid-start',
      '987654',
      '--json',
    ]);
  });

  it('omits --pid-start only when the engine itself could not read it', () => {
    const { exec, calls } = recordingExec('gen=1');
    createExecRunFenceBinder(exec)(504, 'r-504-fc02', 'gate', 'slot-1-r1', 1, 4242, null);
    expect(calls[0].args).not.toContain('--pid-start');
  });

  it('refuses to claim a bind that did not land at the requested generation', () => {
    const { exec } = recordingExec('✅ bound r-504-fc02 gen=2 owner pid=4242 → url\n');
    const outcome = createExecRunFenceBinder(exec)(
      504,
      'r-504-fc02',
      'gate',
      'slot-1-r1',
      1,
      4242,
      null
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('did not land at gen=1');
  });

  it('reports a silent failure instead of inventing success', () => {
    const { exec } = recordingExec(null);
    const outcome = createExecRunFenceBinder(exec)(
      504,
      'r-504-fc02',
      'gate',
      'slot-1-r1',
      1,
      4242,
      null
    );
    expect(outcome.ok === false && outcome.reason).toContain('produced no output');
  });
});

describe('createExecRunFenceReleaser (#683 AC1 — the exit-detected release)', () => {
  it('shells fence --release with the generation the owner held', () => {
    const { exec, calls } = recordingExec('✅ released r-504-fc02 fences up to gen=1 → url\n');
    const releaser = createExecRunFenceReleaser(exec, { repoDir: '/repo' });

    expect(releaser(504, 'r-504-fc02', 'implement', 'slot-2-r1', 1)).toEqual({ ok: true, gen: 1 });
    expect(calls[0].args).toEqual([
      'runstate',
      'fence',
      '--release',
      '--issue',
      '504',
      '--run',
      'r-504-fc02',
      '--phase',
      'implement',
      '--takeover',
      'slot-2-r1',
      '--gen',
      '1',
      '--json',
    ]);
  });

  it('refuses a release that did not land at the requested generation', () => {
    const { exec } = recordingExec('gen=9');
    const outcome = createExecRunFenceReleaser(exec)(504, 'r-504-fc02', 'gate', 'slot-1-r1', 1);
    expect(outcome.ok === false && outcome.reason).toContain('did not land at gen=1');
  });

  it('reports a silent failure instead of claiming the fence is gone', () => {
    // A false "released" would leave successors reading a live trail as fenced; the
    // stale-on-read backstop handles the real ghost, never this lie.
    const { exec } = recordingExec(null);
    const outcome = createExecRunFenceReleaser(exec)(504, 'r-504-fc02', 'gate', 'slot-1-r1', 1);
    expect(outcome.ok === false && outcome.reason).toContain('produced no output');
  });
});
