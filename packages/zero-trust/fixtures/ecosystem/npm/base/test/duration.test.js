const assert = require('node:assert/strict');
const test = require('node:test');
const { toSeconds } = require('../src/duration');

test('rejects text that is not a duration', () => {
  assert.throws(() => toSeconds('soon'), TypeError);
});
