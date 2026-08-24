import { describe, expect, it } from 'vitest';
import { formatAge, formatDuration, formatDurationCell } from '../duration';

describe('formatDuration', () => {
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('renders minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(303)).toBe('5m 3s');
    expect(formatDuration(3599)).toBe('59m 59s');
  });

  it('renders hours and minutes', () => {
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(7500)).toBe('2h 5m');
  });

  it('renders days and hours', () => {
    expect(formatDuration(86400)).toBe('1d 0h');
    expect(formatDuration(97200)).toBe('1d 3h');
  });

  it('renders a negative duration with a leading sign', () => {
    expect(formatDuration(-90)).toBe('-1m 30s');
    expect(formatDuration(-300)).toBe('-5m 0s');
  });
});

describe('formatDurationCell', () => {
  it('pairs the human form with raw seconds', () => {
    expect(formatDurationCell(303)).toBe('5m 3s (303s)');
  });

  it('renders null as a dash', () => {
    expect(formatDurationCell(null)).toBe('-');
  });

  it('keeps a negative span readable', () => {
    expect(formatDurationCell(-300)).toBe('-5m 0s (-300s)');
  });
});

describe('formatAge', () => {
  it('renders a single rounded unit', () => {
    expect(formatAge(45_000)).toBe('45s');
    expect(formatAge(180_000)).toBe('3m');
    expect(formatAge(7_200_000)).toBe('2h');
    expect(formatAge(777_600_000)).toBe('9d');
  });

  it('appends a suffix when given one', () => {
    expect(formatAge(45_000, ' ago')).toBe('45s ago');
    expect(formatAge(777_600_000, ' ago')).toBe('9d ago');
  });

  it('rounds at each unit boundary', () => {
    expect(formatAge(59_000)).toBe('59s');
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(3_600_000)).toBe('1h');
    expect(formatAge(86_400_000)).toBe('1d');
  });
});
