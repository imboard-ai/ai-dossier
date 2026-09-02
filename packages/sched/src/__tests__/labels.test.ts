import { describe, expect, it } from 'vitest';
import {
  HARD_BLOCK_LABELS,
  LABEL_BLOCK_REASON_PREFIX,
  labelBlockReason,
  labelOfBlockReason,
  pickHardBlockLabel,
} from '../index';

describe('HARD_BLOCK_LABELS', () => {
  it('is the four-label triage/hand-off set, in match order', () => {
    // Order is significant: the FIRST match is the reason that gets recorded,
    // so this assertion is the guard against a silent reorder.
    expect([...HARD_BLOCK_LABELS]).toEqual([
      'decision-pending',
      'needs-clarification',
      'epic',
      'decomposed',
    ]);
  });

  it('does not include batch-epic — a batch-anchor concern, not a per-issue screen', () => {
    expect(HARD_BLOCK_LABELS).not.toContain('batch-epic');
  });
});

describe('pickHardBlockLabel', () => {
  it('returns the first matching label in policy order, not issue order', () => {
    expect(pickHardBlockLabel(['epic', 'decision-pending'])).toBe('decision-pending');
  });

  it('matches case-insensitively', () => {
    expect(pickHardBlockLabel(['Decision-Pending'])).toBe('decision-pending');
  });

  it('returns null when no hard-block label is present', () => {
    expect(pickHardBlockLabel(['bug', 'orchestration'])).toBeNull();
    expect(pickHardBlockLabel([])).toBeNull();
  });
});

describe('labelOfBlockReason (#544)', () => {
  it('round-trips labelBlockReason', () => {
    expect(labelOfBlockReason(labelBlockReason('decision-pending'))).toBe('decision-pending');
  });

  it('ignores reasons that are not label blocks', () => {
    expect(labelOfBlockReason('dep-failed:100')).toBeNull();
    expect(labelOfBlockReason('auto-merge-blocked')).toBeNull();
    expect(labelOfBlockReason(null)).toBeNull();
  });

  it('treats a bare prefix as malformed, not a match', () => {
    expect(labelOfBlockReason(LABEL_BLOCK_REASON_PREFIX)).toBeNull();
  });
});
