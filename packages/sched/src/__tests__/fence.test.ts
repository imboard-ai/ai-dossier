import { describe, expect, it } from 'vitest';
import { createExecRunFencer, parseFenceGeneration } from '../index';
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
