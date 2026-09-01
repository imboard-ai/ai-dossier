/**
 * A recording `ExecFn` for the suites that assert on the argv this package shells.
 *
 * Every module that reaches the outside world here injects an `ExecFn` (teardown's git
 * and pool commands, recovery's milestone poster, the run fencer), so every one of their
 * suites needs the same fake: capture the call, answer from a script. One definition, so
 * a change to the `ExecFn` contract lands in one place instead of three.
 */

import type { ExecFn } from '../../project';

/** One captured invocation. */
export interface RecordedCall {
  file: string;
  args: string[];
  cwd?: string;
}

export interface RecordingExec {
  exec: ExecFn;
  calls: RecordedCall[];
}

/**
 * Build a recording exec. `script` decides what each call returns — `null` is the
 * `ExecFn` contract's "the command failed", never a throw.
 */
export function recording(script: (file: string, args: string[]) => string | null): RecordingExec {
  const calls: RecordedCall[] = [];
  return {
    calls,
    // `args` is copied: a caller that mutates its own argv array after the call must not
    // retroactively rewrite what the assertion sees.
    exec: (file, args, cwd) => {
      calls.push({ file, args: [...args], cwd });
      return script(file, args);
    },
  };
}

/** A recording exec whose every call answers with the same `stdout`. */
export function recordingReturns(stdout: string | null): RecordingExec {
  return recording(() => stdout);
}
