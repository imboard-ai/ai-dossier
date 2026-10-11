import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CheckError,
  checkPrBody,
  formatTable,
  LIVE_FLAG,
  loadPackages,
  main,
  parseArgs,
  readRunEvidence,
  runChecks,
  TOKEN_ENV,
  verifyReceiptEnvelope,
} from './zt-acceptance-check.mjs';

// The real package code (built by `make build-all` before `make test`) renders the PR body
// and validates receipts, so these fixtures cannot drift from what a live run produces.
const { zt, core } = loadPackages();
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const RUN_ID = 'ztc-0123456789abcdef-run-1';
const CID = 'ztc-0123456789abcdef';
const BRANCH = `ztfc/${CID}`;
const ROOT = '/state/runs';
const UPSTREAM = 'imboard-ai/ztfc-upstream-fixture';
const FORK = 'ydhidden/ztfc-upstream-fixture';
const UPSTREAM_ID = 1100000001;
const FORK_ID = 2200000001;
const BASE = 'a'.repeat(40);
const FIRST = 'b'.repeat(40);
const SECOND = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const PR_URL = `https://github.com/${UPSTREAM}/pull/2`;

const controller = generateKeyPairSync('ed25519');
const CONTROLLER_PEM = controller.publicKey.export({ type: 'spki', format: 'pem' });
const rawPublic = (key) =>
  key.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');

function commands() {
  return [
    {
      id: 'regression',
      command: 'node --test test/regression.test.js',
      required: true,
      status: 'passed',
      exitStatus: 0,
      suites: 1,
      sanitizedLogDigest: DIGEST,
    },
    {
      id: 'test',
      command: 'node --test',
      required: true,
      status: 'passed',
      exitStatus: 0,
      suites: 2,
      sanitizedLogDigest: DIGEST,
    },
  ];
}

/** Recorded shape of a controller receipt envelope (ztfc-receipt-v2). */
function envelope(candidateSha, { session = 1, key = controller, overrides = {} } = {}) {
  const receipt = {
    schemaVersion: zt.RECEIPT_VERSION,
    contributionId: CID,
    runId: RUN_ID,
    sessionId: `${RUN_ID}-s${session}`,
    contributor: 'ydhidden',
    upstreamRepositoryId: UPSTREAM_ID,
    issue: 2,
    defaultBranch: 'main',
    forkRepositoryId: FORK_ID,
    baseSha: BASE,
    parentSha: BASE,
    candidateSha,
    profileDigest: DIGEST,
    policyDigest: DIGEST,
    profile: {
      name: 'node-22',
      runtime: '22.0.0',
      imageDigest: `sha256:${DIGEST}`,
      accelerator: 'kvm',
    },
    commands: commands(),
    networkPolicy: {
      acquisition: 'source-broker',
      provisioning: 'registry-proxy',
      verification: 'none',
      shipping: 'github',
    },
    issuedAt: '2026-10-11T10:00:00.000Z',
    expiresAt: '2026-10-11T10:15:00.000Z',
    permittedShippingOperations: [],
    verified: true,
    ...overrides,
  };
  const bytes = Buffer.from(zt.canonicalJson(receipt));
  return {
    receipt,
    // receiptDigest() would refuse the deliberately invalid fixtures; it is this hash.
    digest: createHash('sha256').update(bytes).digest('hex'),
    signature: {
      algorithm: 'ed25519',
      public_key: rawPublic(key.publicKey),
      signature: sign(null, bytes, key.privateKey).toString('base64'),
    },
  };
}

/** The intent the controller's pr_create hand-off was issued for; its marker is the one the
 * tracker records and the PR body carries. */
const PR_INTENT = {
  contributionId: CID,
  target: `${UPSTREAM}#2`,
  operationKind: 'pr_create',
  candidateSha: FIRST,
};
const TRACK_MARKER = zt.handoffMarker(PR_INTENT);

/** In-memory run store: the step journal, its content-addressed artifact files and the PR
 * tracker's journal (absent before submission). */
function store(artifacts, { tear = false, track = true } = {}) {
  const files = new Map();
  if (track)
    files.set(
      path.join(ROOT, CID, 'track', 'events.jsonl'),
      Buffer.from(
        `${JSON.stringify({
          v: 1,
          type: 'track',
          run: { runId: RUN_ID },
          contributionId: CID,
          pr: {
            binding: { upstream: { owner: 'imboard-ai', repo: 'ztfc-upstream-fixture' } },
            fork: { repositoryId: FORK_ID, owner: 'ydhidden', repo: 'ztfc-upstream-fixture' },
            number: 2,
            url: PR_URL,
            marker: TRACK_MARKER,
          },
          verifiedSha: FIRST,
        })}\n`
      )
    );
  const dir = path.join(ROOT, CID, 'control', 'steps');
  const lines = artifacts.map(([key, value]) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash('sha256').update(bytes).digest('hex');
    files.set(path.join(dir, `${digest}.json`), bytes);
    return JSON.stringify({ type: 'artifact', runId: RUN_ID, key, version: 1, digest });
  });
  const journal = `${lines.join('\n')}\n`;
  files.set(path.join(dir, 'events.jsonl'), Buffer.from(tear ? journal.slice(0, -1) : journal));
  files.set('/keys/controller.pub', Buffer.from(CONTROLLER_PEM));
  return {
    files,
    readFile: (file) => {
      const bytes = files.get(file);
      if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return bytes;
    },
  };
}

/** The PR body exactly as the controller prefilled it, with the CRLF a web form submits. */
function prBody(receipt) {
  return zt
    .buildPrContent({
      intent: PR_INTENT,
      issue: 2,
      title: 'Fix toSeconds() unit conversion',
      cause: 'Milliseconds were divided by the wrong factor.',
      scope: 'One line in src/duration.js plus a regression test.',
      receipt,
      receiptAllowed: true,
      regression: {
        command: 'node --test test/regression.test.js',
        baseStatus: 'failed',
        candidateStatus: 'passed',
      },
      limitations: [],
    })
    .body.replace(/\n/gu, '\r\n');
}

/** Recorded shapes of the GitHub REST answers the check reads. */
function github({ head = FIRST, branch = head, body, pulls, link = null, status = {} } = {}) {
  const detail = {
    number: 2,
    html_url: PR_URL,
    state: 'open',
    body,
    user: { login: 'ydhidden' },
    head: { ref: BRANCH, sha: head, repo: { full_name: FORK } },
    base: { ref: 'main', repo: { full_name: UPSTREAM } },
  };
  const routes = {
    [`/repos/${UPSTREAM}`]: { id: UPSTREAM_ID, full_name: UPSTREAM, fork: false },
    [`/repos/${FORK}`]: {
      id: FORK_ID,
      full_name: FORK,
      fork: true,
      owner: { login: 'ydhidden' },
      parent: { id: UPSTREAM_ID, full_name: UPSTREAM },
    },
    [`/repos/${FORK}/git/ref/heads/${BRANCH}`]: {
      ref: `refs/heads/${BRANCH}`,
      object: { type: 'commit', sha: branch },
    },
    [`/repos/${UPSTREAM}/pulls?state=all&head=ydhidden%3A${encodeURIComponent(BRANCH)}&base=main&per_page=100`]:
      pulls ?? [{ number: 2, html_url: PR_URL }],
    [`/repos/${UPSTREAM}/pulls/2`]: detail,
  };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const route = url.replace('https://api.github.com', '');
    const code = status[route] ?? (route in routes ? 200 : 404);
    return {
      status: code,
      headers: { get: (name) => (name === 'link' && route.includes('/pulls?') ? link : null) },
      text: async () => JSON.stringify(code === 200 ? routes[route] : { message: 'Not Found' }),
    };
  };
  return { fetch, calls };
}

function initialRun(overrides = {}) {
  const first = envelope(FIRST);
  const run = store(
    overrides.artifacts ?? [
      ['gate', { ok: true }],
      ['receipt', first],
      ['publication', { url: PR_URL, ci: 'none', headSha: FIRST }],
      ['tracked_pr', { number: 2 }],
    ],
    { tear: overrides.tear, track: overrides.track }
  );
  const gh = github({ body: prBody(first.receipt), ...overrides.github });
  return { run, gh, first };
}

const verifyWithController = (env) => verifyReceiptEnvelope(env, CONTROLLER_PEM, { zt, core });

function revisedRun(githubOverrides = {}) {
  const first = envelope(FIRST);
  const second = envelope(SECOND, { session: 2 });
  const run = store([
    ['receipt', first],
    ['publication', { url: PR_URL, ci: 'none', headSha: FIRST }],
    ['tracked_pr', { number: 2 }],
    ['receipt', second],
    ['tracked_pr', { number: 2 }],
  ]);
  // The body keeps the first candidate's verification unless the contributor ran pr-edit.
  const gh = github({ head: SECOND, body: prBody(first.receipt), ...githubOverrides });
  return { run, gh };
}

async function check(run, gh, extra = {}) {
  return runChecks(
    {
      root: ROOT,
      runId: RUN_ID,
      upstream: UPSTREAM,
      fork: FORK,
      controllerKey: CONTROLLER_PEM,
      afterRevision: false,
      ...extra,
    },
    { zt, core, fetch: gh.fetch, readFile: run.readFile, token: extra.token }
  );
}
const verdict = (results) =>
  Object.fromEntries(results.map((r) => [r.id, r.pass ? 'PASS' : r.detail]));

describe('zt-acceptance-check: initial submission', () => {
  it('passes every check on a consistent run, reading GitHub with GET only', async () => {
    const { run, gh } = initialRun();
    const results = await check(run, gh);
    expect(verdict(results)).toEqual({
      receipts: 'PASS',
      identity: 'PASS',
      'fork-branch': 'PASS',
      'single-pr': 'PASS',
      'pr-body': 'PASS',
      'pr-head': 'PASS',
    });
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const { url, init } of gh.calls) {
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(url.startsWith('https://api.github.com/repos/')).toBe(true);
      expect(init.headers.authorization).toBeUndefined();
    }
  });

  it('sends the optional read token as a bearer header', async () => {
    const { run, gh } = initialRun();
    await check(run, gh, { token: 'github_pat_readonly' });
    expect(
      gh.calls.every(({ init }) => init.headers.authorization === 'Bearer github_pat_readonly')
    ).toBe(true);
  });

  it('fails when the fork branch is not the verified candidate', async () => {
    const { run, gh } = initialRun({ github: { branch: SECOND } });
    expect(verdict(await check(run, gh))['fork-branch']).toBe(
      `fork_sha_mismatch: ${SECOND.slice(0, 12)} expected ${FIRST.slice(0, 12)}`
    );
  });

  it('fails single-pr and everything that needs the PR when two PRs share the head', async () => {
    const { run, gh } = initialRun({
      github: { pulls: [{ number: 2 }, { number: 3 }] },
    });
    const v = verdict(await check(run, gh));
    expect(v['single-pr']).toBe('pull_count_2');
    expect(v['pr-body']).toBe('pull_count_2');
    expect(v['pr-head']).toBe('pull_count_2');
    expect(v.receipts).toBe('PASS');
  });

  it('fails closed on a paginated or empty PR listing', async () => {
    const paged = initialRun({ github: { link: '<https://api.github.com/x?page=2>; rel="next"' } });
    expect(verdict(await check(paged.run, paged.gh))['single-pr']).toBe('pull_list_paginated');
    const none = initialRun({ github: { pulls: [] } });
    expect(verdict(await check(none.run, none.gh))['single-pr']).toBe('pull_count_0');
  });

  it('fails when the PR head is not the verified candidate', async () => {
    const { run, gh } = initialRun({ github: { head: SECOND, branch: FIRST } });
    expect(verdict(await check(run, gh))['pr-head']).toBe(
      `pull_head_not_latest_verified: ${SECOND.slice(0, 12)} expected ${FIRST.slice(0, 12)}`
    );
  });

  it('fails the body check without marker, disclosure or the exact commands', async () => {
    const first = envelope(FIRST);
    const body = prBody(first.receipt);
    for (const [broken, code] of [
      [body.replace(/<!-- ai-dossier:ztfc[^>]*-->/u, ''), 'pr_marker_count_0'],
      [`${body}\r\n${zt.findHandoffMarkers(body)[0]}`, 'pr_marker_count_2'],
      [body.replace('substantial LLM assistance', 'some help'), 'pr_disclosure_missing'],
      [
        body.replace('node --test</code>', 'node --test --watch</code>'),
        'pr_commands_missing: test',
      ],
      [body.replace('exit=0; suites=2', 'exit=0; suites=3'), 'pr_commands_missing: test'],
      [body.replaceAll(FIRST, SECOND), `pr_names_unverified_candidate: ${SECOND.slice(0, 12)}`],
      [body.replace(CID, 'ztc-ffffffffffffffff'), 'pr_marker_not_tracked_marker'],
      [body.replace('op=pr_create', 'op=pr_update'), 'pr_marker_not_pr_create'],
    ]) {
      const { run, gh } = initialRun({ github: { body: broken } });
      expect(verdict(await check(run, gh))['pr-body']).toBe(code);
    }
  });

  it('fails when the PR is by someone else or the run never recorded it', async () => {
    const { run, gh, first } = initialRun();
    const other = async (url, init) => {
      const response = await gh.fetch(url, init);
      if (!url.endsWith('/pulls/2')) return response;
      const value = JSON.parse(await response.text());
      return {
        ...response,
        text: async () => JSON.stringify({ ...value, user: { login: 'mallory' } }),
      };
    };
    expect(verdict(await check(run, { fetch: other }))['single-pr']).toBe(
      'pull_author_not_contributor'
    );
    const unrecorded = initialRun({ artifacts: [['receipt', first]] });
    expect(verdict(await check(unrecorded.run, unrecorded.gh))['single-pr']).toBe(
      'pull_not_recorded_by_run'
    );
  });

  it('fails identity when the fork is not the signed fork of the upstream', async () => {
    const { run } = initialRun();
    const gh = github({ body: prBody(envelope(FIRST).receipt) });
    const swapped = async (url, init) => {
      const response = await gh.fetch(url, init);
      if (!url.endsWith(`/repos/${FORK}`)) return response;
      const value = JSON.parse(await response.text());
      return { ...response, text: async () => JSON.stringify({ ...value, parent: { id: 7 } }) };
    };
    expect(verdict(await check(run, { fetch: swapped })).identity).toBe('fork_parent_mismatch');
  });

  it('fails closed on GitHub errors and unreadable answers', async () => {
    const { run, gh } = initialRun({
      github: { status: { [`/repos/${FORK}/git/ref/heads/${BRANCH}`]: 404 } },
    });
    expect(verdict(await check(run, gh))['fork-branch']).toBe('github_http_404: fork branch');
    const garbage = async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => '{',
    });
    const v = verdict(await check(initialRun().run, { fetch: garbage }));
    expect(Object.values(v).filter((x) => x === 'PASS')).toEqual(['PASS']);
    expect(v.identity).toBe('github_invalid_json: upstream repository');
    const offline = async () => {
      throw new Error('offline');
    };
    expect(verdict(await check(initialRun().run, { fetch: offline }))['single-pr']).toBe(
      'github_unreachable: pull list'
    );
  });
});

describe('zt-acceptance-check: diagnostics', () => {
  it('names a rate limit and keeps the cause of an unexpected error', async () => {
    const limited = async () => ({
      status: 403,
      headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : null) },
      text: async () => '{}',
    });
    expect(verdict(await check(initialRun().run, { fetch: limited })).identity).toBe(
      `github_rate_limited: upstream repository (set ${TOKEN_ENV})`
    );
    const broken = { ...zt, findHandoffMarkers: undefined };
    const { run, gh } = initialRun();
    const results = await runChecks(
      {
        root: ROOT,
        runId: RUN_ID,
        upstream: UPSTREAM,
        fork: FORK,
        controllerKey: CONTROLLER_PEM,
        afterRevision: false,
      },
      { zt: broken, core, fetch: gh.fetch, readFile: run.readFile }
    );
    expect(results.find((r) => r.id === 'pr-body').detail).toMatch(
      /^unexpected_error: TypeError: /u
    );
  });
});

describe('zt-acceptance-check: receipts and run evidence', () => {
  it('fails every dependent check when a receipt is signed by another key', async () => {
    const stranger = generateKeyPairSync('ed25519');
    const { run, gh } = initialRun({
      artifacts: [
        ['receipt', envelope(FIRST, { key: stranger })],
        ['publication', { url: PR_URL, ci: 'none', headSha: FIRST }],
      ],
    });
    const v = verdict(await check(run, gh));
    expect(v.receipts).toBe('receipt_signed_by_other_key (receipt 1 of 1)');
    expect(Object.values(v).every((x) => x !== 'PASS')).toBe(true);
  });

  it('rejects a tampered receipt, an unverified one and one from another run', () => {
    const good = envelope(FIRST);
    const tampered = { ...good, receipt: { ...good.receipt, candidateSha: SECOND } };
    expect(() => verifyWithController(tampered)).toThrow('receipt_digest_mismatch');
    const forged = {
      ...good,
      digest: zt.receiptDigest(tampered.receipt),
      receipt: tampered.receipt,
    };
    expect(() => verifyWithController(forged)).toThrow('receipt_bad_signature');
    const failed = commands().map((c) => ({ ...c, status: 'failed', exitStatus: 1 }));
    expect(() =>
      verifyWithController(envelope(FIRST, { overrides: { commands: failed, verified: false } }))
    ).toThrow('receipt_not_verified');
    expect(() => verifyWithController(envelope(FIRST, { overrides: { verified: false } }))).toThrow(
      'receipt_schema_invalid'
    );
    expect(() => verifyWithController({ ...good, extra: 1 })).toThrow('receipt_envelope_invalid');
    expect(() =>
      verifyWithController(envelope(FIRST, { overrides: { schemaVersion: 'ztfc-receipt-v1' } }))
    ).toThrow('receipt_schema_invalid');
  });

  it('refuses receipts bound to another run', async () => {
    const other = envelope(FIRST, {
      overrides: {
        runId: 'ztc-ffffffffffffffff-run-1',
        sessionId: 'ztc-ffffffffffffffff-run-1-s1',
      },
    });
    const { run, gh } = initialRun({ artifacts: [['receipt', other]] });
    expect(verdict(await check(run, gh)).receipts).toBe('receipt_other_run (receipt 1 of 1)');
  });

  it('fails closed on a torn journal, a missing store, a bad row or a changed artifact', async () => {
    const torn = initialRun({ tear: true });
    expect(new Set(Object.values(verdict(await check(torn.run, torn.gh))))).toEqual(
      new Set([`step_journal_incomplete: ${path.join(CID, 'control', 'steps', 'events.jsonl')}`])
    );
    const empty = { readFile: () => Buffer.alloc(0) };
    expect(() => readRunEvidence({ root: ROOT, runId: RUN_ID }, empty)).toThrow(
      'step_journal_incomplete'
    );
    const missing = {
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    expect(() => readRunEvidence({ root: ROOT, runId: RUN_ID }, missing)).toThrow(
      /step_journal_unreadable: .*events\.jsonl \(ENOENT\)/u
    );
    const { run } = initialRun();
    const journal = path.join(ROOT, CID, 'control', 'steps', 'events.jsonl');
    const extra = Buffer.concat([run.files.get(journal), Buffer.from('{"type":"artifact"}\n')]);
    run.files.set(journal, extra);
    expect(() => readRunEvidence({ root: ROOT, runId: RUN_ID }, run)).toThrow(
      'step_journal_invalid'
    );
    const fresh = initialRun().run;
    for (const [file, bytes] of fresh.files)
      if (file.endsWith('.json') && bytes.includes('ztfc-receipt-v2'))
        fresh.files.set(file, Buffer.from(bytes.toString().replace('"issue":2', '"issue":3')));
    expect(() => readRunEvidence({ root: ROOT, runId: RUN_ID }, fresh)).toThrow(
      'step_artifact_digest_mismatch'
    );
  });

  it('reads receipts in journal order and the latest publication', () => {
    const { run } = revisedRun();
    const evidence = readRunEvidence({ root: ROOT, runId: RUN_ID }, run);
    expect(evidence.branch).toBe(BRANCH);
    expect(evidence.receipts.map((e) => e.receipt.candidateSha)).toEqual([FIRST, SECOND]);
    expect(evidence.publication.url).toBe(PR_URL);
    expect(evidence.trackedPrNumber).toBe(2);
    expect(evidence.trackedPr().marker).toBe(TRACK_MARKER);
  });

  it('takes the latest value of a key from its last row, as StepArtifacts does', () => {
    const a = { url: PR_URL, ci: 'none', headSha: FIRST };
    const b = { url: `https://github.com/${UPSTREAM}/pull/9`, ci: 'none', headSha: FIRST };
    const run = store([
      ['publication', a],
      ['publication', b],
      ['publication', a],
    ]);
    expect(readRunEvidence({ root: ROOT, runId: RUN_ID }, run).publication).toEqual(a);
  });

  it('fails the body check when the tracker journal is missing', async () => {
    const { run, gh } = initialRun({ track: false });
    expect(verdict(await check(run, gh))['pr-body']).toMatch(/^track_journal_unreadable: /u);
  });

  it('never writes to the run store it reads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-acceptance-store-'));
    try {
      const { run, gh } = initialRun();
      for (const [file, bytes] of run.files)
        if (file.startsWith(ROOT)) {
          const target = path.join(root, path.relative(ROOT, file));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, bytes, { mode: 0o600 });
        }
      const snapshot = () =>
        fs
          .readdirSync(root, { recursive: true, withFileTypes: true })
          .map((entry) => {
            const full = path.join(entry.parentPath, entry.name);
            const stat = fs.statSync(full);
            return `${full} ${stat.mode} ${stat.size} ${stat.mtimeMs} ${entry.isFile() ? fs.readFileSync(full, 'hex') : 'dir'}`;
          })
          .sort();
      const before = snapshot();
      const reads = [];
      const results = await runChecks(
        {
          root,
          runId: RUN_ID,
          upstream: UPSTREAM,
          fork: FORK,
          controllerKey: CONTROLLER_PEM,
          afterRevision: false,
        },
        {
          zt,
          core,
          fetch: gh.fetch,
          readFile: (file) => {
            reads.push(file);
            return fs.readFileSync(file);
          },
        }
      );
      expect(results.every((r) => r.pass)).toBe(true);
      expect(reads.length).toBeGreaterThan(0);
      expect(snapshot()).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('zt-acceptance-check: after the verified revision', () => {
  it('passes when the PR head is the second verified candidate', async () => {
    const { run, gh } = revisedRun();
    const results = await check(run, gh, { afterRevision: true });
    expect(verdict(results)).toEqual({
      receipts: 'PASS',
      identity: 'PASS',
      'fork-branch': 'PASS',
      'single-pr': 'PASS',
      'pr-body': 'PASS',
      'pr-head': 'PASS',
    });
    expect(results.at(-1).detail).toBe(`${FIRST.slice(0, 12)} -> ${SECOND}`);
    expect(results.find((r) => r.id === 'pr-body').detail).toContain(
      `head is ${SECOND.slice(0, 12)} (body not updated after the revision)`
    );
  });

  it('fails without a second verified candidate or when the head did not move', async () => {
    const { run, gh } = initialRun();
    expect(verdict(await check(run, gh, { afterRevision: true }))['pr-head']).toBe(
      'no_second_verified_candidate'
    );
    const stale = revisedRun({ head: FIRST, branch: SECOND });
    expect(verdict(await check(stale.run, stale.gh, { afterRevision: true }))['pr-head']).toBe(
      `pull_head_not_latest_verified: ${FIRST.slice(0, 12)} expected ${SECOND.slice(0, 12)}`
    );
    const unpushed = revisedRun({ branch: FIRST });
    expect(
      verdict(await check(unpushed.run, unpushed.gh, { afterRevision: true }))['fork-branch']
    ).toBe(
      `fork_sha_mismatch: ${FIRST.slice(0, 12)} expected ${SECOND.slice(0, 12)} (an earlier verified candidate)`
    );
  });
});

describe('zt-acceptance-check: command line', () => {
  const argv = [
    '--root',
    ROOT,
    '--run',
    RUN_ID,
    '--upstream',
    UPSTREAM,
    '--fork',
    FORK,
    '--controller-key',
    '/keys/controller.pub',
  ];
  function io(run, gh, env = { [LIVE_FLAG]: '1' }) {
    const lines = { out: [], err: [] };
    return {
      lines,
      deps: {
        env,
        fetch: gh.fetch,
        readFile: run.readFile,
        loadPackages: () => ({ zt, core }),
        out: (l) => lines.out.push(l),
        err: (l) => lines.err.push(l),
      },
    };
  }

  it('refuses to run without the live flag and makes no request', async () => {
    const { run, gh } = initialRun();
    for (const env of [{}, { [LIVE_FLAG]: 'true' }]) {
      const { deps, lines } = io(run, gh, env);
      expect(await main(argv, deps)).toBe(2);
      expect(lines.err[0]).toContain(LIVE_FLAG);
    }
    expect(gh.calls).toEqual([]);
  });

  it('prints a PASS table and exits 0, or FAIL and exits 1', async () => {
    const ok = initialRun();
    const pass = io(ok.run, ok.gh);
    expect(await main(argv, pass.deps)).toBe(0);
    expect(pass.lines.out.join('\n')).toMatch(/fork-branch\s+PASS/u);
    expect(pass.lines.out.at(-1)).toBe('ALL CHECKS PASSED');
    const bad = initialRun({ github: { branch: SECOND } });
    const fail = io(bad.run, bad.gh);
    expect(await main([...argv, '--json'], fail.deps)).toBe(1);
    const report = JSON.parse(fail.lines.out[0]);
    expect(report.passed).toBe(false);
    expect(report.results.find((r) => r.id === 'fork-branch').pass).toBe(false);
  });

  it('refuses a private key, an unreadable key, a malformed token and bad arguments', async () => {
    const { run, gh } = initialRun();
    run.files.set(
      '/keys/controller.pub',
      Buffer.from(controller.privateKey.export({ type: 'pkcs8', format: 'pem' }))
    );
    expect(await main(argv, io(run, gh).deps)).toBe(2);
    run.files.set('/keys/controller.pub', Buffer.from('not a key'));
    expect(await main(argv, io(run, gh).deps)).toBe(2);
    run.files.delete('/keys/controller.pub');
    expect(await main(argv, io(run, gh).deps)).toBe(2);
    const ok = initialRun();
    expect(await main(argv, io(ok.run, ok.gh, { [LIVE_FLAG]: '1', [TOKEN_ENV]: 'a b' }).deps)).toBe(
      2
    );
    expect(await main(['--root'], io(ok.run, ok.gh).deps)).toBe(2);
    expect([...gh.calls, ...ok.gh.calls]).toEqual([]);
    const help = io(ok.run, ok.gh, {});
    expect(await main(['--help'], help.deps)).toBe(0);
    expect(help.lines.out[0]).toContain('--controller-key');
  });

  it('parses flags strictly', () => {
    expect(parseArgs([...argv, '--after-revision'])).toMatchObject({
      runId: RUN_ID,
      afterRevision: true,
      json: false,
      controllerKeyFile: '/keys/controller.pub',
    });
    expect(() => parseArgs([...argv, '--run', RUN_ID])).toThrow(CheckError);
    expect(() => parseArgs([...argv, '--force'])).toThrow('invalid_argument');
    expect(() => parseArgs(argv.slice(2))).toThrow('missing_flag: --root');
    expect(() => parseArgs(argv.map((a) => (a === RUN_ID ? 'run-1' : a)))).toThrow(
      'invalid_run_id'
    );
    for (const bad of ['a/b/c', 'owner/..', 'owner/.'])
      expect(() => parseArgs(argv.map((a) => (a === FORK ? bad : a)))).toThrow(
        'invalid_repository'
      );
  });

  it('matches command lines with the package renderer and formats the table', () => {
    const optional = { ...commands()[1], required: false };
    const body0 = prBody(
      envelope(FIRST, { overrides: { commands: [optional, commands()[0]] } }).receipt
    );
    expect(body0.split('\r\n')).toContain(zt.prCommandLine(optional));
    expect(formatTable([{ id: 'receipts', pass: true, detail: 'ok' }])).toBe(
      'CHECK     RESULT  DETAIL\nreceipts  PASS    ok'
    );
    const body = prBody(envelope(FIRST).receipt);
    expect(
      checkPrBody(body, { marker: TRACK_MARKER, receipts: [envelope(FIRST).receipt] }, zt)
        .candidateSha
    ).toBe(FIRST);
  });
});

describe('seeded upstream policy (fixtures/acceptance/npm)', () => {
  const fixture = path.join(REPO_ROOT, 'packages/zero-trust/fixtures/acceptance/npm');
  const policyFile = (name) => {
    const content = fs.readFileSync(path.join(fixture, 'upstream', name), 'utf8');
    const bytes = Buffer.from(content);
    return {
      path: name,
      content,
      sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    };
  };
  const files = [policyFile('CONTRIBUTING.md'), policyFile('README.md')];
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives the deterministic floor nothing stricter than AI disclosure', () => {
    const floor = zt.analyzePolicyFloor(files);
    expect(floor.restrictions).toEqual({
      ai: ['ai_disclosure'],
      assignment: [],
      directPr: [],
      draft: [],
      template: [],
      baseline: [],
    });
    expect(Object.values(floor.contradictions).every((c) => c === false)).toBe(true);
    expect(floor.assessment).toMatchObject({ draftRequired: false, receiptBlockAllowed: true });
  });

  it('proceeds through the gate without engagement when the typed answers are confident', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-acceptance-policy-'));
    dirs.push(dir);
    const model = 'fixture-model';
    const rates = [
      {
        resource: model,
        currency: 'USD',
        unit: 'token',
        price: 0,
        units: 1,
        source: 'fixture',
        fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: '2026-10-11T00:00:00Z' },
      },
    ];
    const ledger = new zt.BudgetLedger(path.join(dir, 'budget.json'), 'contribution');
    ledger.initialize([model], rates);
    ledger.startSession({
      id: 's1',
      ceiling: { currency: 'USD', minor: 1_000_000 },
      cleanupAllowance: 0,
      tokenLimit: 10_000_000,
      timeLimitMs: 10_000_000,
    });
    const text = files[0].content.split('\n');
    const line = (needle) => {
      const index = text.findIndex((l) => l.includes(needle));
      return [{ sourceId: 'CONTRIBUTING.md', line: index + 1, quote: text[index] }];
    };
    // What a careful model answers for this file, with literal citations.
    const answers = {
      'policy-ai': { value: 'disclosure_required', citations: line('must disclose') },
      'policy-assignment': { value: 'not_required', citations: line('Assignment is optional') },
      'policy-direct-pr': { value: 'welcomed', citations: line('Direct pull requests') },
      'policy-non-draft': { value: true, citations: line('ready for review') },
      'policy-receipt': { value: true, citations: line('verification receipt') },
      'policy-baseline': { value: false, citations: line('npm test') },
    };
    let pending;
    const complete = async () => ({
      kind: 'tool_calls',
      calls: [{ id: 'p', name: 'report_decision', arguments: pending }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const llm = zt.createLlmDecisionProvider({ adapter: { id: model, complete }, timeoutMs: 1000 });
    const provider = {
      ...llm,
      request: (q, inputs, pass) => {
        pending = answers[q.id];
        return llm.request(q, inputs, pass);
      },
    };
    const policy = await zt.assessPolicy(files, {
      provider,
      budget: { ledger, sessionId: 's1', rates },
    });
    expect(policy).toMatchObject({
      ai: 'disclosure_required',
      assignment: 'not_required',
      directPr: 'welcomed',
      draftRequired: false,
      receiptBlockAllowed: true,
    });
    const facts = { policy, assigned: false, eligibility: { kind: 'eligible', reasons: [] } };
    const row = zt.GATE_ROWS.find((r) => r.matches(facts));
    expect(row.id).toBe('proceed');
  });

  it('keeps the seeded issue free of the fix', () => {
    const body = fs.readFileSync(path.join(fixture, 'issue-body.md'), 'utf8');
    expect(fs.readFileSync(path.join(fixture, 'issue-title.txt'), 'utf8').trim()).not.toBe('');
    expect(body).toContain("toSeconds('90s'), 90");
    expect(body).not.toMatch(/\/ ?100\b|1000|divid/iu);
  });
});
