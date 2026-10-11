`toSeconds()` gives the wrong number of seconds for every valid duration. The result is ten
times larger than it should be.

## Steps to reproduce

```sh
npm ci
node -e "const { toSeconds } = require('./src/duration'); console.log(toSeconds('90s'), toSeconds('2m'))"
```

## Expected

```text
90 120
```

## Actual

```text
900 1200
```

## Failing test

This test fails on `main` today and should pass once the bug is fixed:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { toSeconds } = require('../src/duration');

test('converts seconds and minutes to whole seconds', () => {
  assert.equal(toSeconds('90s'), 90);
  assert.equal(toSeconds('2m'), 120);
});
```

Run it with `npm test`. It reports `900 !== 90`.

## Environment

Node.js 22 on Linux, dependencies installed from `package-lock.json`.
