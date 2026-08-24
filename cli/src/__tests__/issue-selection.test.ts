import { describe, expect, it } from 'vitest';
import { MAX_ISSUE_SELECTION, parseIssueSelection } from '../issue-selection';

describe('parseIssueSelection', () => {
  it('expands an explicit list', () => {
    expect(parseIssueSelection('1,2,3')).toEqual([1, 2, 3]);
  });

  it('expands an inclusive range', () => {
    expect(parseIssueSelection('1..9')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('expands a mixed list and range', () => {
    expect(parseIssueSelection('1,2,5..8')).toEqual([1, 2, 5, 6, 7, 8]);
  });

  it('de-duplicates and sorts ascending', () => {
    expect(parseIssueSelection('9,1,5..7,6,1')).toEqual([1, 5, 6, 7, 9]);
  });

  it('tolerates surrounding whitespace around terms', () => {
    expect(parseIssueSelection(' 3 , 1 .. 2 ')).toEqual([1, 2, 3]);
  });

  it('accepts a single issue', () => {
    expect(parseIssueSelection('451')).toEqual([451]);
  });

  it('accepts a range whose ends are equal', () => {
    expect(parseIssueSelection('7..7')).toEqual([7]);
  });

  it('rejects an empty selection', () => {
    expect(() => parseIssueSelection('  ')).toThrow(/Empty issue selection/);
  });

  it('rejects a stray comma by name', () => {
    expect(() => parseIssueSelection('1,,2')).toThrow(/stray comma/);
  });

  it('rejects a non-numeric term and names it', () => {
    expect(() => parseIssueSelection('1,abc,3')).toThrow(/Invalid issue 'abc'/);
  });

  it('rejects issue 0 and a leading-zero number', () => {
    expect(() => parseIssueSelection('0')).toThrow(/Invalid issue '0'/);
    expect(() => parseIssueSelection('007')).toThrow(/Invalid issue '007'/);
  });

  it('rejects a number too large to survive a Number() round trip', () => {
    // Without this, `Number('99999999999999999999999')` reaches gh as the literal `1e+23`.
    expect(() => parseIssueSelection('99999999999999999999999')).toThrow(/Invalid issue/);
  });

  it('rejects a malformed range', () => {
    expect(() => parseIssueSelection('1..2..3')).toThrow(/Malformed range/);
  });

  it('rejects a descending range and suggests the corrected form', () => {
    expect(() => parseIssueSelection('9..1')).toThrow(/write it as 1\.\.9/);
  });

  it('rejects a range past the selection cap without materialising it', () => {
    expect(() => parseIssueSelection(`1..${MAX_ISSUE_SELECTION + 1}`)).toThrow(
      new RegExp(`past the ${MAX_ISSUE_SELECTION} cap`)
    );
  });

  it('rejects a huge range promptly rather than allocating it', () => {
    expect(() => parseIssueSelection('1..1000000')).toThrow(
      new RegExp(`past the ${MAX_ISSUE_SELECTION} cap`)
    );
  });

  it('rejects a list that accumulates past the cap', () => {
    const half = Math.ceil(MAX_ISSUE_SELECTION / 2);
    expect(() => parseIssueSelection(`1..${half},1000..${1000 + half}`)).toThrow(
      new RegExp(`past ${MAX_ISSUE_SELECTION} issues`)
    );
  });

  it('accepts a range exactly at the cap', () => {
    expect(parseIssueSelection(`1..${MAX_ISSUE_SELECTION}`)).toHaveLength(MAX_ISSUE_SELECTION);
  });

  it('carries its own Fix: line so a caller can print the message unmodified', () => {
    // The cap error used to get a generic "pass a list or range" appended, which told the
    // operator to do the very thing that had just failed.
    expect(() => parseIssueSelection('1..500')).toThrow(/Fix: narrow the range/);
    expect(() => parseIssueSelection('1,abc')).toThrow(/Fix: expected a positive issue number/);
  });
});
