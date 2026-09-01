import { describe, expect, it } from 'vitest';
import { createExecRunFencer, parseFenceGeneration } from '../index';
import type { ExecFn } from '../project';

/** Records every exec call and answers with a scripted stdout. */
function recordingExec(answer: string | null): {
  exec: ExecFn;
  calls: Array<{ file: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  return {
    calls,
    exec: (file, args, cwd) => {
      calls.push({ file, args: [...args], cwd });
      return answer;
    },
  };
}

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

    expect(fencer(504, 'r-504-fc02', 'implement', 'slot-2-r1')).toBe(1);
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
    ]);
    expect(calls[0].cwd).toBe('/repo');
  });

  it('honours a custom binary', () => {
    const { exec, calls } = recordingExec('gen=1');
    createExecRunFencer(exec, { bin: '/opt/ai-dossier' })(1, 'r-1-a', 'gate', 't');
    expect(calls[0].file).toBe('/opt/ai-dossier');
  });

  it('reports null when the CLI could not fence, rather than guessing a generation', () => {
    // A guessed generation is worse than none: the takeover would post at a generation
    // its own fence never installed and be locked out by the CLI.
    const { exec } = recordingExec(null);
    expect(createExecRunFencer(exec)(504, 'r-504-fc02', 'implement', 'slot-2-r1')).toBeNull();
  });
});
