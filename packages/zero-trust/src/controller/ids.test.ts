import { expect, it } from 'vitest';
import { contributionIdOf } from './ids';

it('parses the supported run ID without magic suffix slicing', () => {
  expect(contributionIdOf('ztc-0123456789abcdef-run-1')).toBe('ztc-0123456789abcdef');
  expect(contributionIdOf('ztc-0123456789abcdef-run-2')).toBeUndefined();
  expect(contributionIdOf('../escape')).toBeUndefined();
});
