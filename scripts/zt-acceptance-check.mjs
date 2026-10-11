#!/usr/bin/env node
// ------------------------------------------------------------------
// zt-acceptance-check.mjs
//
// Read-only verdict for the zero-trust live acceptance demonstration (#1115).
// Run it after the owner run reaches `submitted` (and again after the
// verified revision, with --after-revision). Runbook:
// docs/features/zero-trust-full-cycle/acceptance-runbook.md
//
// It reads the run store's step-artifact and PR-tracker journals directly
// (never through RunStore, so it takes no lock and repairs nothing) and makes
// GET requests to the GitHub REST API, anonymously or with an optional read
// token. It never writes to GitHub or to the run store.
//
//   receipts     every retained receipt is ztfc-receipt-v2, intact, verified,
//                bound to this run and signed by the given controller key
//   identity     upstream and fork repository IDs equal the signed IDs, the
//                fork's parent is the upstream, and the contributor owns it
//   fork-branch  the fork branch `ztfc/<contribution>` points at the latest
//                verified candidate
//   single-pr    exactly one pull request exists for that head and base
//                (state=all), by the contributor, and it is the one the run
//                recorded
//   pr-body      the body carries exactly the marker the run tracks, the LLM
//                disclosure, and the exact command lines of a verified receipt
//   pr-head      the PR head is the latest verified candidate; with
//                --after-revision there are at least two verified candidates
//                and the head also differs from the first
//
// Fail closed: an unreadable, truncated, paginated or ambiguous answer is a
// FAIL, never a pass.
// Exit: 0 every check passed; 1 a check failed; 2 refused (no live flag, bad
// arguments, unreadable or private key, packages not built, malformed token).
// ------------------------------------------------------------------
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIVE_FLAG = 'ZT_ACCEPTANCE_LIVE';
export const TOKEN_ENV = 'ZT_ACCEPTANCE_READ_TOKEN';
const API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 30_000;
const DISCLOSURE_HEADING = '## LLM disclosure';
const RUN_ID_PATTERN = /^(ztc-[a-f0-9]{16})-run-1$/u;
const BRANCH_PREFIX = 'ztfc/';
const JOURNAL_ROW_KEYS = 'digest,key,runId,type,version';
const ENVELOPE_KEYS = 'digest,receipt,signature';

export const USAGE = `Usage: ${LIVE_FLAG}=1 node scripts/zt-acceptance-check.mjs --root <stateDir>/runs --run <runId> --upstream <owner/repo> --fork <owner/repo> --controller-key <public-key-file> [--after-revision] [--json]

Optional: ${TOKEN_ENV}=<read-only token> raises the anonymous GitHub rate limit.
Use absolute paths. Exit: 0 all checks passed; 1 a check failed; 2 refused.`;

const VALUE_FLAGS = new Set(['root', 'run', 'upstream', 'fork', 'controller-key']);
const BOOLEAN_FLAGS = new Set(['after-revision', 'json', 'help']);

export class CheckError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CheckError';
    this.code = code;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shortSha = (sha) => String(sha).slice(0, 12);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  isRecord(value) && Object.keys(value).sort().join(',') === keys;
const sameLogin = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const encodePath = (value) =>
  value
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
const repoPath = (fullName) => `/repos/${encodePath(fullName)}`;

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)$/u.exec(argv[i]);
    const name = match?.[1];
    if (!name || (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) || name in opts)
      throw new CheckError(`invalid_argument: ${argv[i]}`);
    if (BOOLEAN_FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--'))
      throw new CheckError(`missing_value: --${name}`);
    opts[name] = value;
  }
  if (opts.help) return { help: true };
  for (const name of VALUE_FLAGS) if (!opts[name]) throw new CheckError(`missing_flag: --${name}`);
  if (!RUN_ID_PATTERN.test(opts.run)) throw new CheckError('invalid_run_id');
  for (const name of ['upstream', 'fork']) {
    const repo = opts[name].split('/')[1];
    if (
      !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/u.test(opts[name]) ||
      repo === '.' ||
      repo === '..'
    )
      throw new CheckError(`invalid_repository: --${name}`);
  }
  return {
    root: opts.root,
    runId: opts.run,
    upstream: opts.upstream,
    fork: opts.fork,
    controllerKeyFile: opts['controller-key'],
    afterRevision: Boolean(opts['after-revision']),
    json: Boolean(opts.json),
  };
}

function strictUtf8(bytes, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CheckError(code);
  }
}

function strictJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CheckError(code);
  }
}

/** A complete newline-terminated JSONL journal (a controller writing it shows as incomplete). */
function readJournal(readFile, root, relative, label) {
  let bytes;
  try {
    bytes = readFile(path.join(root, relative));
  } catch (error) {
    throw new CheckError(`${label}_unreadable: ${relative} (${error?.code ?? 'error'})`);
  }
  const text = strictUtf8(bytes, `${label}_invalid: ${relative}`);
  if (!text || !text.endsWith('\n')) throw new CheckError(`${label}_incomplete: ${relative}`);
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => strictJson(line, `${label}_invalid: ${relative}`));
}

/**
 * Run evidence, read with the same row rules as `StepArtifacts`
 * (`<root>/<contribution>/control/steps/`) and the PR tracker's first `track` record
 * (`<root>/<contribution>/track/events.jsonl`). Each artifact file is checked against its
 * content digest. The latest value of a key is its last row, as in `StepArtifacts`.
 * Only complete journals are accepted: run this while no controller runs.
 */
export function readRunEvidence({ root, runId }, { readFile }) {
  const contributionId = RUN_ID_PATTERN.exec(runId)?.[1];
  if (!contributionId) throw new CheckError('invalid_run_id');
  const stepsDir = path.join(contributionId, 'control', 'steps');
  const latestDigest = new Map();
  const receiptDigests = [];
  for (const row of readJournal(
    readFile,
    root,
    path.join(stepsDir, 'events.jsonl'),
    'step_journal'
  )) {
    if (
      !hasExactKeys(row, JOURNAL_ROW_KEYS) ||
      row.type !== 'artifact' ||
      row.runId !== runId ||
      row.version !== 1 ||
      typeof row.key !== 'string' ||
      !/^[a-z_]{1,64}$/u.test(row.key) ||
      typeof row.digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(row.digest)
    )
      throw new CheckError('step_journal_invalid: unexpected row');
    latestDigest.set(row.key, row.digest);
    if (row.key === 'receipt' && !receiptDigests.includes(row.digest))
      receiptDigests.push(row.digest);
  }
  const load = (digest) => {
    const relative = path.join(stepsDir, `${digest}.json`);
    let value;
    try {
      value = readFile(path.join(root, relative));
    } catch (error) {
      throw new CheckError(`step_artifact_unreadable: ${relative} (${error?.code ?? 'error'})`);
    }
    if (sha256(value) !== digest)
      throw new CheckError(`step_artifact_digest_mismatch: ${relative}`);
    return strictJson(
      strictUtf8(value, `step_artifact_invalid: ${relative}`),
      `step_artifact_invalid: ${relative}`
    );
  };
  const latest = (key) => (latestDigest.has(key) ? load(latestDigest.get(key)) : undefined);
  const trackJournal = path.join(contributionId, 'track', 'events.jsonl');
  // Read lazily: before submission the tracker does not exist yet.
  const trackedPr = () => {
    const first = readJournal(readFile, root, trackJournal, 'track_journal')[0];
    if (
      !isRecord(first) ||
      first.type !== 'track' ||
      first.contributionId !== contributionId ||
      !isRecord(first.pr) ||
      typeof first.pr.marker !== 'string' ||
      typeof first.pr.url !== 'string' ||
      !Number.isSafeInteger(first.pr.number)
    )
      throw new CheckError(`track_journal_invalid: ${trackJournal}`);
    return first.pr;
  };
  return {
    contributionId,
    runId,
    branch: `${BRANCH_PREFIX}${contributionId}`,
    receipts: receiptDigests.map(load),
    publication: latest('publication'),
    trackedPrNumber: latest('tracked_pr')?.number,
    trackedPr,
  };
}

/** Offline receipt-v2 integrity plus trust in the given controller key. Expiry is not
 * checked: a receipt is valid for 15 minutes of shipping, and this runs afterwards.
 * Mirrors `receiptIntegrity` (src/receipt/integrity.ts), which the package does not export,
 * and additionally refuses any key but the controller's. */
export function verifyReceiptEnvelope(envelope, controllerKey, { zt, core }) {
  if (!hasExactKeys(envelope, ENVELOPE_KEYS)) throw new CheckError('receipt_envelope_invalid');
  let receipt;
  try {
    receipt = zt.parseReceipt(envelope.receipt);
  } catch {
    throw new CheckError('receipt_schema_invalid');
  }
  if (receipt.schemaVersion !== zt.RECEIPT_VERSION) throw new CheckError('receipt_version');
  if (envelope.digest !== zt.receiptDigest(receipt))
    throw new CheckError('receipt_digest_mismatch');
  const signature = envelope.signature;
  if (
    !isRecord(signature) ||
    signature.algorithm !== 'ed25519' ||
    typeof signature.public_key !== 'string' ||
    typeof signature.signature !== 'string'
  )
    throw new CheckError('receipt_signature_invalid');
  if (!core.publicKeysMatch(signature.public_key, controllerKey))
    throw new CheckError('receipt_signed_by_other_key');
  let valid = false;
  try {
    const key = createPublicKey(core.toSpkiPem(controllerKey));
    const bytes = Buffer.from(signature.signature, 'base64');
    valid =
      key.asymmetricKeyType === 'ed25519' &&
      bytes.length === 64 &&
      bytes.toString('base64') === signature.signature &&
      verify(null, Buffer.from(zt.canonicalJson(receipt)), key, bytes);
  } catch {
    valid = false;
  }
  if (!valid) throw new CheckError('receipt_bad_signature');
  if (receipt.verified !== true) throw new CheckError('receipt_not_verified');
  return receipt;
}

/** GET-only GitHub REST client. Anything but 200 with a JSON body is a refusal, named by
 * the request label so two reads in one check stay distinguishable. */
export function githubReader({ fetch, token }) {
  return async (label, pathname) => {
    let response;
    try {
      response = await fetch(`${API}${pathname}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ai-dossier-zt-acceptance-check',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (error) {
      throw new CheckError(
        error?.name === 'TimeoutError' ? `github_timeout: ${label}` : `github_unreachable: ${label}`
      );
    }
    const header = (name) => response.headers?.get?.(name) ?? null;
    if (response.status !== 200) {
      if ([403, 429].includes(response.status) && header('x-ratelimit-remaining') === '0')
        throw new CheckError(`github_rate_limited: ${label} (set ${TOKEN_ENV})`);
      throw new CheckError(`github_http_${response.status}: ${label}`);
    }
    const body = strictJson(await response.text(), `github_invalid_json: ${label}`);
    return { body, link: header('link') };
  };
}

/** The package's own Verification-line renderer; text it refuses counts as missing. */
function renderedLine(zt, c) {
  try {
    return zt.prCommandLine(c);
  } catch {
    return undefined;
  }
}

/** Checks the PR body against the tracked marker and the retained receipts. Returns the
 * receipt whose verification section the body carries. */
export function checkPrBody(body, { marker, receipts }, zt) {
  if (typeof body !== 'string' || !body) throw new CheckError('pr_body_missing');
  const markers = zt.findHandoffMarkers(body);
  if (markers.length !== 1) throw new CheckError(`pr_marker_count_${markers.length}`);
  if (zt.markerOperation(markers[0]) !== 'pr_create')
    throw new CheckError('pr_marker_not_pr_create');
  if (!zt.hasOnlyMarker(body, marker)) throw new CheckError('pr_marker_not_tracked_marker');
  const lines = body.split(/\r\n|\n|\r/u);
  const disclosure = `This contribution used substantial LLM assistance, orchestrated with [ai-dossier](${zt.LLM_DISCLOSURE_URL}).`;
  const heading = lines.indexOf(DISCLOSURE_HEADING);
  if (heading < 0 || !lines.slice(heading + 1).some((line) => line.startsWith(disclosure)))
    throw new CheckError('pr_disclosure_missing');
  const named = lines
    .map((line) => /^Commands run against `([a-f0-9]{40})` /u.exec(line)?.[1])
    .filter(Boolean);
  if (named.length !== 1) throw new CheckError(`pr_verification_sections_${named.length}`);
  const receipt = receipts.find((r) => r.candidateSha === named[0]);
  if (!receipt) throw new CheckError(`pr_names_unverified_candidate: ${shortSha(named[0])}`);
  const missing = receipt.commands.filter((c) => {
    const line = renderedLine(zt, c);
    return line === undefined || !lines.includes(line);
  });
  if (missing.length)
    throw new CheckError(`pr_commands_missing: ${missing.map((c) => c.id).join(',')}`);
  return receipt;
}

/** Memoized evidence shared by the checks; each loader fails closed with a CheckError. */
function evidenceLoaders(input, deps) {
  const { zt, core } = deps;
  const get = githubReader({ fetch: deps.fetch, token: deps.token });
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, Promise.resolve().then(fn));
    return memo.get(key);
  };
  const evidence = () => once('evidence', () => readRunEvidence(input, deps));
  const receipts = () =>
    once('receipts', async () => {
      const ev = await evidence();
      if (!ev.receipts.length) throw new CheckError('no_retained_receipt');
      return ev.receipts.map((envelope, index) => {
        try {
          const r = verifyReceiptEnvelope(envelope, input.controllerKey, { zt, core });
          if (r.contributionId !== ev.contributionId || r.runId !== input.runId)
            throw new CheckError('receipt_other_run');
          return r;
        } catch (error) {
          if (!(error instanceof CheckError)) throw error;
          throw new CheckError(`${error.code} (receipt ${index + 1} of ${ev.receipts.length})`);
        }
      });
    });
  const candidates = () =>
    once('candidates', async () => {
      const list = [];
      for (const r of await receipts())
        if (!list.includes(r.candidateSha)) list.push(r.candidateSha);
      return list;
    });
  const signed = () =>
    once('signed', async () => {
      const all = await receipts();
      const pick = (field) => {
        const values = [...new Set(all.map((r) => r[field]))];
        if (values.length !== 1) throw new CheckError(`receipts_disagree_${field}`);
        return values[0];
      };
      return {
        upstreamId: pick('upstreamRepositoryId'),
        forkId: pick('forkRepositoryId'),
        contributor: pick('contributor'),
        defaultBranch: pick('defaultBranch'),
      };
    });
  const pr = () =>
    once('pr', async () => {
      const ev = await evidence();
      const { defaultBranch } = await signed();
      const query = new URLSearchParams({
        state: 'all',
        head: `${input.fork.split('/')[0]}:${ev.branch}`,
        base: defaultBranch,
        per_page: '100',
      });
      const { body: list, link } = await get(
        'pull list',
        `${repoPath(input.upstream)}/pulls?${query}`
      );
      if (!Array.isArray(list)) throw new CheckError('pull_list_invalid');
      if (link && /rel="next"/u.test(link)) throw new CheckError('pull_list_paginated');
      if (list.length !== 1) throw new CheckError(`pull_count_${list.length}`);
      const number = list[0]?.number;
      if (!Number.isSafeInteger(number) || number < 1) throw new CheckError('pull_number_invalid');
      const { body } = await get('pull detail', `${repoPath(input.upstream)}/pulls/${number}`);
      if (!isRecord(body) || body.number !== number) throw new CheckError('pull_detail_invalid');
      return body;
    });
  return { get, evidence, receipts, candidates, signed, pr };
}

async function runCheck(id, title, fn) {
  try {
    return { id, title, pass: true, detail: await fn() };
  } catch (error) {
    const detail =
      error instanceof CheckError
        ? error.code
        : `unexpected_error: ${String(error?.name ?? 'Error')}: ${String(error?.message ?? error).slice(0, 200)}`;
    return { id, title, pass: false, detail };
  }
}

/** Runs every check; each returns PASS/FAIL with a short detail. Never throws. */
export async function runChecks(input, deps) {
  const { get, evidence, receipts, candidates, signed, pr } = evidenceLoaders(input, deps);
  return [
    await runCheck('receipts', 'receipts verify with the controller key', async () => {
      const all = await receipts();
      return `${all.length} receipt(s), ${(await candidates()).length} verified candidate(s)`;
    }),
    await runCheck('identity', 'repository IDs match the signed receipt', async () => {
      const ids = await signed();
      const upstream = (await get('upstream repository', repoPath(input.upstream))).body;
      const fork = (await get('fork repository', repoPath(input.fork))).body;
      if (!isRecord(upstream) || upstream.id !== ids.upstreamId)
        throw new CheckError('upstream_id_mismatch');
      if (!isRecord(fork) || fork.id !== ids.forkId) throw new CheckError('fork_id_mismatch');
      if (fork.fork !== true || !isRecord(fork.parent) || fork.parent.id !== ids.upstreamId)
        throw new CheckError('fork_parent_mismatch');
      if (!sameLogin(fork.owner?.login, ids.contributor))
        throw new CheckError('fork_owner_not_contributor');
      // Names only: the outcome record is public and carries no numeric IDs.
      return `${input.upstream} and ${input.fork} match the signed IDs`;
    }),
    await runCheck('fork-branch', 'fork branch SHA equals the verified candidate', async () => {
      const ev = await evidence();
      const list = await candidates();
      const latest = list.at(-1);
      const { body } = await get(
        'fork branch',
        `${repoPath(input.fork)}/git/ref/heads/${encodePath(ev.branch)}`
      );
      if (!isRecord(body) || body.ref !== `refs/heads/${ev.branch}`)
        throw new CheckError('fork_ref_ambiguous');
      const sha = body.object?.sha;
      if (body.object?.type !== 'commit' || typeof sha !== 'string' || !/^[a-f0-9]{40}$/u.test(sha))
        throw new CheckError('fork_ref_invalid');
      if (sha !== latest)
        throw new CheckError(
          `fork_sha_mismatch: ${shortSha(sha)} expected ${shortSha(latest)}${list.includes(sha) ? ' (an earlier verified candidate)' : ''}`
        );
      return `${ev.branch} = ${latest}`;
    }),
    await runCheck('single-pr', 'exactly one PR for head and base (state=all)', async () => {
      const ev = await evidence();
      const ids = await signed();
      const detail = await pr();
      if (!sameLogin(detail.head?.repo?.full_name, input.fork) || detail.head?.ref !== ev.branch)
        throw new CheckError('pull_head_mismatch');
      if (
        !sameLogin(detail.base?.repo?.full_name, input.upstream) ||
        detail.base?.ref !== ids.defaultBranch
      )
        throw new CheckError('pull_base_mismatch');
      if (!sameLogin(detail.user?.login, ids.contributor))
        throw new CheckError('pull_author_not_contributor');
      const recorded = ev.publication?.url ?? null;
      if (recorded === null && ev.trackedPrNumber === undefined)
        throw new CheckError('pull_not_recorded_by_run');
      if (recorded !== null && recorded !== detail.html_url)
        throw new CheckError('pull_url_mismatch');
      if (ev.trackedPrNumber !== undefined && ev.trackedPrNumber !== detail.number)
        throw new CheckError('pull_number_mismatch');
      return `${detail.html_url} (${detail.state})`;
    }),
    await runCheck('pr-body', 'PR body has the marker, disclosure and commands', async () => {
      const ev = await evidence();
      const detail = await pr();
      const tracked = ev.trackedPr();
      const named = checkPrBody(
        detail.body,
        { marker: tracked.marker, receipts: await receipts() },
        deps.zt
      );
      const head = detail.head?.sha;
      return `${named.commands.length} command(s) for ${shortSha(named.candidateSha)}${named.candidateSha === head ? '' : `; head is ${shortSha(head)} (body not updated after the revision)`}`;
    }),
    await runCheck(
      'pr-head',
      input.afterRevision
        ? 'PR head is a new verified candidate after the revision'
        : 'PR head is the verified candidate',
      async () => {
        const list = await candidates();
        const head = (await pr()).head?.sha;
        if (head !== list.at(-1))
          throw new CheckError(
            `pull_head_not_latest_verified: ${shortSha(head)} expected ${shortSha(list.at(-1))}`
          );
        if (!input.afterRevision) return head;
        if (list.length < 2) throw new CheckError('no_second_verified_candidate');
        if (head === list[0]) throw new CheckError('pull_head_unchanged');
        return `${shortSha(list[0])} -> ${head}`;
      }
    ),
  ];
}

export function formatTable(results) {
  const width = Math.max(...results.map((r) => r.id.length), 5);
  return [
    `${'CHECK'.padEnd(width)}  RESULT  DETAIL`,
    ...results.map((r) => `${r.id.padEnd(width)}  ${r.pass ? 'PASS' : 'FAIL'}    ${r.detail}`),
  ].join('\n');
}

export function loadPackages() {
  const require = createRequire(import.meta.url);
  try {
    return {
      zt: require('../packages/zero-trust/dist/index.js'),
      core: require('@ai-dossier/core'),
    };
  } catch {
    throw new CheckError('packages_not_built: run `make build-zero-trust` first');
  }
}

export async function main(argv, deps) {
  const { env, out, err } = deps;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    err(`error: ${error instanceof CheckError ? error.code : 'invalid_arguments'}`);
    err(USAGE);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (env[LIVE_FLAG] !== '1') {
    err(`error: refusing to run without ${LIVE_FLAG}=1 (this check reads live GitHub data)`);
    return 2;
  }
  const token = env[TOKEN_ENV];
  if (token !== undefined && !/^[A-Za-z0-9_]{1,255}$/u.test(token)) {
    err(`error: ${TOKEN_ENV} is malformed`);
    return 2;
  }
  let packages;
  let controllerKey;
  try {
    packages = deps.loadPackages();
    controllerKey = strictUtf8(
      deps.readFile(opts.controllerKeyFile),
      'controller_key_unreadable'
    ).trim();
  } catch (error) {
    err(
      `error: ${error instanceof CheckError ? error.code : `controller_key_unreadable (${error?.code ?? 'error'})`}`
    );
    return 2;
  }
  if (/PRIVATE KEY/u.test(controllerKey) || !packages.core.isSupportedPublicKey(controllerKey)) {
    err('error: --controller-key must name the Ed25519 PUBLIC key (openssl pkey -pubout)');
    return 2;
  }
  const results = await runChecks(
    { ...opts, controllerKey },
    { ...packages, fetch: deps.fetch, readFile: deps.readFile, token }
  );
  const passed = results.every((r) => r.pass);
  if (opts.json)
    out(JSON.stringify({ runId: opts.runId, afterRevision: opts.afterRevision, passed, results }));
  else {
    out(`zt-acceptance-check ${opts.runId}${opts.afterRevision ? ' (after revision)' : ''}`);
    out(formatTable(results));
    out(
      passed
        ? 'ALL CHECKS PASSED'
        : 'ACCEPTANCE CHECK FAILED (rows with the same detail share one root cause)'
    );
  }
  return passed ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    readFile: (file) => fs.readFileSync(file),
    loadPackages,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
