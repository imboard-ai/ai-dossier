import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = fileURLToPath(new URL('./fmt_events.py', import.meta.url));

function run(lines) {
  return execFileSync('python3', [SCRIPT_PATH], {
    input: lines.map((l) => JSON.stringify(l)).join('\n'),
    encoding: 'utf8',
  });
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

  it('drops event types not in the keep set', () => {
    const out = run([
      { event: 'dispatched', issue: 1 },
      { event: 'spawned', issue: 2 },
    ]);
    expect(out.trim()).toBe('spawned #2');
  });

  it('skips unparseable lines without crashing', () => {
    const out = execFileSync('python3', [SCRIPT_PATH], {
      input: 'not json\n' + JSON.stringify({ event: 'stalled', issue: 9 }),
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('stalled #9');
  });

  it('truncates output to at most 8 lines', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ event: 'spawned', issue: i }));
    const out = run(events);
    expect(out.trim().split('\n')).toHaveLength(8);
  });
});
