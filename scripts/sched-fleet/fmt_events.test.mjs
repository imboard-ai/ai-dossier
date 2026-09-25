import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = fileURLToPath(new URL('./fmt_events.py', import.meta.url));

function runRaw(input) {
  return execFileSync('python3', [SCRIPT_PATH], { input, encoding: 'utf8' });
}

function run(lines) {
  return runRaw(lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('fmt_events.py', () => {
  it('formats a kept event with tier, reason, and pr', () => {
    const out = run([
      { event: 'unit-failed', issue: 123, tier: 'mid', reason: 'test-timeout', pr: 456 },
    ]);
    expect(out.trim()).toBe('unit-failed #123 tier=mid test-timeout PR#456');
  });

  it('formats a kept event with only the fields present', () => {
    const out = run([{ event: 'spawned', issue: 7 }]);
    expect(out.trim()).toBe('spawned #7');
  });

  it('#810: keeps a member hand-back and a suppressed dissolve (with its detail)', () => {
    const out = run([
      { event: 'member-handed-back', unit: 'batch:b1', issue: 4333, reason: 'needs-input' },
      { event: 'dissolve-suppressed', unit: 'batch:b1', detail: 'kept #4137' },
    ]);
    expect(out.trim().split('\n')).toEqual([
      'member-handed-back #4333 needs-input',
      'dissolve-suppressed batch:b1 kept #4137',
    ]);
  });

  it('#822: keeps a batch resume (with its detail) and a wrong-procedure re-prompt', () => {
    const out = run([
      {
        event: 'batch-resumed',
        unit: 'batch:b1',
        reason: 'dissolve-refused:x',
        detail: 'landed=4137',
      },
      { event: 'member-reprompted', unit: 'batch:b1', issue: 4174, reason: 'wrong-procedure' },
    ]);
    expect(out.trim().split('\n')).toEqual([
      'batch-resumed batch:b1 dissolve-refused:x landed=4137',
      'member-reprompted #4174 wrong-procedure',
    ]);
  });

  it('#844: keeps a SIGKILL escalation and a recovered member advance', () => {
    const out = run([
      { event: 'kill-escalated', unit: 'batch:b1', issue: 885, pid: 4242 },
      { event: 'member-advance-recovered', unit: 'batch:b1', issue: 881 },
    ]);
    expect(out.trim().split('\n')).toEqual([
      'kill-escalated #885',
      'member-advance-recovered #881',
    ]);
  });

  it('#824: keeps an operator attach-pr, naming the PR', () => {
    const out = run([
      { event: 'pr-attached', unit: 'batch:b1', pr: 4270, detail: 'operator attached o/r#4270' },
    ]);
    expect(out.trim()).toBe('pr-attached batch:b1 PR#4270');
  });

  it('reports a missing dispatch profile with its batch and detail', () => {
    const out = run([
      {
        event: 'dispatch-profile-missing',
        unit: 'batch:b-gone',
        detail: "profile 'ghost' is no longer configured",
      },
    ]);
    expect(out.trim()).toBe(
      "dispatch-profile-missing batch:b-gone profile 'ghost' is no longer configured"
    );
  });

  it('drops event types not in the keep set', () => {
    const out = run([
      { event: 'dispatched', issue: 1 },
      { event: 'spawned', issue: 2 },
    ]);
    expect(out.trim()).toBe('spawned #2');
  });

  it('skips unparseable lines without crashing', () => {
    const out = runRaw(`not json\n${JSON.stringify({ event: 'stalled', issue: 9 })}`);
    expect(out.trim()).toBe('stalled #9');
  });

  it('truncates output to at most 8 lines', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ event: 'spawned', issue: i }));
    const out = run(events);
    expect(out.trim().split('\n')).toHaveLength(8);
  });
});
