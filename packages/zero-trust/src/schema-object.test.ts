import Ajv from 'ajv';
import { expect, it } from 'vitest';
import { object } from './schema-object';

it('closed object schemas reject absent and undeclared fields', () => {
  const validate = new Ajv().compile(object({ value: { type: 'string' } }));
  expect(validate({ value: 'fact' })).toBe(true);
  expect(validate({})).toBe(false);
  expect(validate({ value: 'fact', invented: true })).toBe(false);
});
