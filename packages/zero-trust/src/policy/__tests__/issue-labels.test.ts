import { expect, it } from 'vitest';
import { isNonBugIssue } from '../issue-labels';

it.each([
  ['enhancement'],
  ['feature'],
  ['question'],
  ['discussion'],
  ['documentation'],
])('non-bug label %s restricts eligibility', (label) => expect(isNonBugIssue([label])).toBe(true));
it.each([
  ['bug'],
  ['Defect'],
  ['REGRESSION'],
])('explicit bug label %s dominates enhancement', (label) =>
  expect(isNonBugIssue([label, 'enhancement'])).toBe(false));
it('empty or neutral labels do not invent non-bug evidence', () => {
  expect(isNonBugIssue([])).toBe(false);
  expect(isNonBugIssue(['help wanted'])).toBe(false);
});
