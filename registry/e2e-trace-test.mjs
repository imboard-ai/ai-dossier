// End-to-end test for the trace API.
// Hits a running server (default http://localhost:3000), signs test JWTs with
// the local JWT_SECRET, exercises every endpoint, and DELETEs everything it
// created at the end. Exit code is non-zero if any check fails.
//
// Usage:
//   BASE_URL=http://localhost:3000 node e2e-trace-test.mjs
//   BASE_URL=https://dossier-registry.vercel.app node e2e-trace-test.mjs

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('JWT_SECRET must be set (source registry/.env.local)');
  process.exit(1);
}

const ALICE = `e2e-alice-${randomUUID().slice(0, 8)}`;
const BOB = `e2e-bob-${randomUUID().slice(0, 8)}`;
const aliceToken = jwt.sign({ sub: ALICE, email: null, orgs: [] }, SECRET, { expiresIn: '1h' });
const bobToken = jwt.sign({ sub: BOB, email: null, orgs: [] }, SECRET, { expiresIn: '1h' });

const TRACE_ID = randomUUID();

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  if (res.status !== 204) {
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, requestId: res.headers.get('x-request-id') };
}

console.log(`\nTesting ${BASE}`);
console.log(`  alice: ${ALICE}`);
console.log(`  bob:   ${BOB}`);
console.log(`  trace: ${TRACE_ID}\n`);

// ---- auth gate ----
console.log('Auth:');
{
  const r = await call('POST', '/api/v1/traces', { body: {} });
  check(
    'POST /api/v1/traces without token → 401 MISSING_TOKEN',
    r.status === 401 && r.body?.error?.code === 'MISSING_TOKEN',
    `got ${r.status} ${JSON.stringify(r.body)}`
  );
}

// ---- create ----
console.log('\nCreate:');
{
  const r = await call('POST', '/api/v1/traces', {
    token: aliceToken,
    body: {
      trace_id: TRACE_ID,
      dossier: { title: 'E2E Test Dossier', version: '1.0.0' },
      agent: { name: 'e2e-runner', version: '1.0' },
      started_at: new Date().toISOString(),
      status: 'running',
    },
  });
  check('POST /api/v1/traces → 201', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  check('  response has trace_id', r.body?.trace_id === TRACE_ID);
  check('  response has url', r.body?.url === `/api/v1/traces/${TRACE_ID}`);
}

// ---- conflict ----
console.log('\nConflict:');
{
  const r = await call('POST', '/api/v1/traces', {
    token: aliceToken,
    body: {
      trace_id: TRACE_ID,
      dossier: { title: 'Dup', version: '1.0.0' },
      started_at: new Date().toISOString(),
      status: 'running',
    },
  });
  check(
    'POST same trace_id → 409 CONFLICT',
    r.status === 409 && r.body?.error?.code === 'CONFLICT',
    `got ${r.status} ${JSON.stringify(r.body)}`
  );
}

// ---- list ----
console.log('\nList:');
{
  const r = await call('GET', '/api/v1/traces?status=running', { token: aliceToken });
  check('GET /api/v1/traces?status=running → 200', r.status === 200, `got ${r.status}`);
  const found = Array.isArray(r.body?.traces) && r.body.traces.some((t) => t.trace_id === TRACE_ID);
  check('  list contains our trace', found);
  check('  pagination has limit/offset/total', typeof r.body?.pagination?.total === 'number');
}

// ---- get ----
console.log('\nGet:');
{
  const r = await call('GET', `/api/v1/traces/${TRACE_ID}`, { token: aliceToken });
  check('GET /api/v1/traces/:id → 200', r.status === 200, `got ${r.status}`);
  check('  body has trace_id', r.body?.trace_id === TRACE_ID);
  check('  body has dossier', r.body?.dossier?.title === 'E2E Test Dossier');
  check('  body has empty steps array', Array.isArray(r.body?.steps) && r.body.steps.length === 0);
}

// ---- append steps ----
console.log('\nAppend steps:');
{
  const r1 = await call('POST', `/api/v1/traces/${TRACE_ID}/steps`, {
    token: aliceToken,
    body: { step_id: 's1', type: 'action', detail: 'first step' },
  });
  check(
    'POST /steps (1st) → 201, step_number=1',
    r1.status === 201 && r1.body?.step_number === 1,
    `got ${r1.status} ${JSON.stringify(r1.body)}`
  );

  const r2 = await call('POST', `/api/v1/traces/${TRACE_ID}/steps`, {
    token: aliceToken,
    body: { step_id: 's2', type: 'validation', detail: 'second step' },
  });
  check(
    'POST /steps (2nd) → 201, step_number=2',
    r2.status === 201 && r2.body?.step_number === 2,
    `got ${r2.status} ${JSON.stringify(r2.body)}`
  );

  const r3 = await call('GET', `/api/v1/traces/${TRACE_ID}/steps`, { token: aliceToken });
  check(
    'GET /steps → 200, two steps in order',
    r3.status === 200 &&
      r3.body?.steps?.length === 2 &&
      r3.body.steps[0].step_id === 's1' &&
      r3.body.steps[1].step_id === 's2',
    `got ${r3.status} ${JSON.stringify(r3.body)}`
  );
}

// ---- patch ----
console.log('\nPatch:');
{
  const r = await call('PATCH', `/api/v1/traces/${TRACE_ID}`, {
    token: aliceToken,
    body: { status: 'success', completed_at: new Date().toISOString(), duration_ms: 1234 },
  });
  check(
    'PATCH /api/v1/traces/:id → 200',
    r.status === 200,
    `got ${r.status} ${JSON.stringify(r.body)}`
  );

  const r2 = await call('GET', `/api/v1/traces/${TRACE_ID}`, { token: aliceToken });
  check(
    'GET after patch shows status=success',
    r2.body?.status === 'success',
    `got status=${r2.body?.status}`
  );
}

// ---- cross-owner isolation ----
console.log('\nOwner isolation:');
{
  const r = await call('GET', `/api/v1/traces/${TRACE_ID}`, { token: bobToken });
  check(
    "bob GET alice's trace → 404 NOT_FOUND",
    r.status === 404 && r.body?.error?.code === 'NOT_FOUND',
    `got ${r.status} ${JSON.stringify(r.body)}`
  );

  const r2 = await call('DELETE', `/api/v1/traces/${TRACE_ID}`, { token: bobToken });
  check(
    "bob DELETE alice's trace → 404 NOT_FOUND",
    r2.status === 404 && r2.body?.error?.code === 'NOT_FOUND',
    `got ${r2.status} ${JSON.stringify(r2.body)}`
  );

  const r3 = await call('GET', '/api/v1/traces', { token: bobToken });
  const aliceTraceVisibleToBob =
    Array.isArray(r3.body?.traces) && r3.body.traces.some((t) => t.trace_id === TRACE_ID);
  check("bob LIST does not include alice's trace", !aliceTraceVisibleToBob);
}

// ---- validation ----
console.log('\nValidation:');
{
  const r = await call('POST', '/api/v1/traces', { token: aliceToken, body: {} });
  check(
    'empty body → 400 MISSING_FIELD',
    r.status === 400 && r.body?.error?.code === 'MISSING_FIELD',
    `got ${r.status}`
  );
}
{
  const r = await call('POST', '/api/v1/traces', {
    token: aliceToken,
    body: {
      trace_id: 'not-a-uuid',
      dossier: { title: 'X', version: '1.0.0' },
      started_at: new Date().toISOString(),
      status: 'running',
    },
  });
  check(
    'non-UUID trace_id → 400 INVALID_FIELD',
    r.status === 400 && r.body?.error?.code === 'INVALID_FIELD',
    `got ${r.status}`
  );
}

// ---- delete + verify gone ----
console.log('\nDelete:');
{
  const r = await call('DELETE', `/api/v1/traces/${TRACE_ID}`, { token: aliceToken });
  check('DELETE /api/v1/traces/:id → 204', r.status === 204, `got ${r.status}`);

  const r2 = await call('GET', `/api/v1/traces/${TRACE_ID}`, { token: aliceToken });
  check('GET after delete → 404', r2.status === 404);
}

// ---- summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
