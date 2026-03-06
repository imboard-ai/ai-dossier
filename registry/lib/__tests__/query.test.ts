import { describe, expect, it } from 'vitest';
import { queryString } from '../query';

describe('queryString', () => {
  it('returns undefined for undefined input', () => {
    expect(queryString(undefined)).toBeUndefined();
  });

  it('returns the string when given a single string', () => {
    expect(queryString('hello')).toBe('hello');
  });

  it('returns the first element when given an array', () => {
    expect(queryString(['first', 'second'])).toBe('first');
  });

  it('returns empty string when given empty string', () => {
    expect(queryString('')).toBe('');
  });

  it('returns the first element when given a single-element array', () => {
    expect(queryString(['only'])).toBe('only');
  });
});
