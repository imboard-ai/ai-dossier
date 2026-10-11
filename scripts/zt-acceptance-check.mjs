#!/usr/bin/env node
// ------------------------------------------------------------------
// zt-acceptance-check.mjs
//
// Read-only verdict for the zero-trust live acceptance demonstration (#1115).
// Run it after the owner run reaches `submitted` (and again after the
// verified revision, with --after-revision). Runbook:
// docs/features/zero-trust-full-cycle/acceptance-runbook.md
//
// It reads the run store's step-artifact journal (never through RunStore, so
// it takes no lock and repairs nothing) and makes GET requests to the GitHub
// REST API, anonymously or with an optional read token. It never writes to
// GitHub or to the run store.
//
//   receipts     every retained receipt is ztfc-receipt-v2, intact, verified,
//                bound to this run and signed by the given controller key
//   identity     upstream and fork repository IDs equal the signed IDs, and
//                the fork's parent is the upstream
//   fork-branch  the fork branch `ztfc/<contribution>` points at the latest
//                verified candidate
//   single-pr    exactly one pull request exists for that head and base
//                (state=all), by the contributor
//   pr-body      the body carries one pr_create marker for this contribution,
//                the LLM disclosure, and the receipt's exact command lines
//   pr-head      the PR head is the latest verified candidate; with
//                --after-revision it is the second verified candidate and
//                differs from the first
//
// Fail closed: an unreadable, truncated, paginated or ambiguous answer is a
// FAIL, never a pass. Exit 0 only when every check passes; 1 when any check
// fails; 2 when the run is refused (no live flag, bad arguments, bad key).
// ------------------------------------------------------------------
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIVE_FLAG = 'ZT_ACCEPTANCE_LIVE';
export const TOKEN_ENV = 'ZT_ACCEPTANCE_READ_TOKEN';
const API = 'https://api.github.com';
const DISCLOSURE_HEADING = '## LLM disclosure';

export const USAGE = `Usage: ${LIVE_FLAG}=1 node scripts/zt-acceptance-check.mjs --root <stateDir>/runs --run <runId> --upstream <owner/repo> --fork <owner/repo> --controller-key <public-key-file> [--after-revision] [--json]

Optional: ${TOKEN_ENV}=<read-only token> raises the anonymous GitHub rate limit.`;

const VALUE_FLAGS = new Set(['root', 'run', 'upstream', 'fork', 'controller-key']);
const BOOLEAN_FLAGS = new Set(['after-revision', 'json', 'help']);

export class CheckError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CheckError';
    this.code = code;
  }
}

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
  if (!/^ztc-[a-f0-9]{16}-run-1$/u.test(opts.run)) throw new CheckError('invalid_run_id');
  for (const name of ['upstream', 'fork'])
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/u.test(opts[name]))
      throw new CheckError(`invalid_repository: --${name}`);
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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lower = (text) => String(text).toLowerCase();
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);

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

/**
 * The step-artifact journal the controller keeps at
 * `<root>/<contribution>/control/steps/events.jsonl`, read with the same row rules as
 * `StepArtifacts`. Every artifact file is checked against its content digest. Only
 * complete newline-terminated journals are accepted: run this while no controller runs.
 */
export function readRunEvidence({ root, runId }, { readFile }) {
  const contributionId = /^(ztc-[a-f0-9]{16})-run-1$/u.exec(runId)?.[1];
  if (!contributionId) throw new CheckError('invalid_run_id');
  const dir = path.join(root, contributionId, 'control', 'steps');
  let bytes;
  try {
    bytes = readFile(path.join(dir, 'events.jsonl'));
  } catch {
    throw new CheckError('step_journal_unreadable');
  }
  const text = strictUtf8(bytes, 'step_journal_invalid');
  if (!text || !text.endsWith('\n')) throw new CheckError('step_journal_incomplete');
  const keys = new Map();
  for (const line of text.slice(0, -1).split('\n')) {
    const row = strictJson(line, 'step_journal_invalid');
    if (
      !isRecord(row) ||
      Object.keys(row).length !== 5 ||
      row.type !== 'artifact' ||
      row.runId !== runId ||
      row.version !== 1 ||
      typeof row.key !== 'string' ||
      !/^[a-z_]{1,64}$/u.test(row.key) ||
      typeof row.digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(row.digest)
    )
      throw new CheckError('step_journal_invalid');
    const digests = keys.get(row.key) ?? [];
    if (!digests.includes(row.digest)) digests.push(row.digest);
    keys.set(row.key, digests);
  }
  const load = (digest) => {
    let value;
    try {
      value = readFile(path.join(dir, `${digest}.json`));
    } catch {
      throw new CheckError('step_artifact_unreadable');
    }
    if (sha256(value) !== digest) throw new CheckError('step_artifact_digest_mismatch');
    return strictJson(strictUtf8(value, 'step_artifact_invalid'), 'step_artifact_invalid');
  };
  const latest = (key) => {
    const digest = keys.get(key)?.at(-1);
    return digest === undefined ? undefined : load(digest);
  };
  return {
    contributionId,
    runId,
    branch: `ztfc/${contributionId}`,
    receipts: (keys.get('receipt') ?? []).map(load),
    publication: latest('publication'),
    trackedPr: latest('tracked_pr'),
  };
}

/** Offline receipt-v2 integrity plus trust in the given controller key. Expiry is not
 * checked: a receipt is valid for 15 minutes of shipping, and this runs afterwards. */
export function verifyReceiptEnvelope(envelope, controllerKey, { zt, core }) {
  if (!isRecord(envelope) || Object.keys(envelope).sort().join(',') !== 'digest,receipt,signature')
    throw new CheckError('receipt_envelope_invalid');
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

/** GET-only GitHub REST client. Anything but 200 with a JSON body is a refusal. */
export function githubReader({ fetch, token }) {
  return async (pathname) => {
    let response;
    try {
      response = await fetch(`${API}${pathname}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ai-dossier-zt-acceptance-check',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      throw new CheckError('github_unreachable');
    }
    if (response.status !== 200) throw new CheckError(`github_http_${response.status}`);
    const body = strictJson(await response.text(), 'github_invalid_json');
    return { body, link: response.headers?.get?.('link') ?? null };
  };
}

const repoPath = (fullName) =>
  `/repos/${fullName
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;

/** `untrustedText(value, n, false)` followed by `escapeHtml`, as `buildPrContent` renders a
 * command; any text the renderer would alter differently simply fails to match. */
export function renderedCommand(command) {
  const plain = command
    .replace(/\r\n?/gu, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: mirror the renderer's control-character strip.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/<!--/gu, '&lt;!--')
    .replace(/--!?>/gu, '--&gt;');
  return plain.replace(
    /[&<>"'`\r\n]/gu,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '`': '&#96;',
        '\r': '&#13;',
        '\n': '&#10;',
      })[c]
  );
}

export function commandLine(c) {
  return `- <code>${renderedCommand(c.command)}</code>${c.required ? '' : ' (optional)'}: ${c.status}; exit=${c.exitStatus}; suites=${c.suites}`;
}

/** Checks the PR body against the retained receipts. Returns the receipt it names. */
export function checkPrBody(body, { contributionId, receipts }, zt) {
  if (typeof body !== 'string' || !body) throw new CheckError('pr_body_missing');
  const markers = zt.findHandoffMarkers(body);
  if (markers.length !== 1) throw new CheckError(`pr_marker_count_${markers.length}`);
  const marker = /contribution=([A-Za-z0-9_-]+) intent=[a-f0-9]{32} op=([a-z_]+)/u.exec(markers[0]);
  if (marker?.[1] !== contributionId) throw new CheckError('pr_marker_other_contribution');
  if (marker[2] !== 'pr_create') throw new CheckError('pr_marker_not_pr_create');
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
  if (!receipt) throw new CheckError('pr_names_unverified_candidate');
  const missing = receipt.commands.filter((c) => !lines.includes(commandLine(c)));
  if (missing.length)
    throw new CheckError(`pr_commands_missing: ${missing.map((c) => c.id).join(',')}`);
  return receipt;
}

/** Runs every check; each returns PASS/FAIL with a short detail. Never throws. */
export async function runChecks(input, deps) {
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
      return ev.receipts.map((envelope) => {
        const r = verifyReceiptEnvelope(envelope, input.controllerKey, { zt, core });
        if (r.contributionId !== ev.contributionId || r.runId !== input.runId)
          throw new CheckError('receipt_other_run');
        return r;
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
  const pulls = () =>
    once('pulls', async () => {
      const ev = await evidence();
      const { defaultBranch } = await signed();
      const forkOwner = input.fork.split('/')[0];
      const query = new URLSearchParams({
        state: 'all',
        head: `${forkOwner}:${ev.branch}`,
        base: defaultBranch,
        per_page: '100',
      });
      const { body, link } = await get(`${repoPath(input.upstream)}/pulls?${query}`);
      if (!Array.isArray(body)) throw new CheckError('pull_list_invalid');
      if (link && /rel="next"/u.test(link)) throw new CheckError('pull_list_paginated');
      return body;
    });
  const pr = () =>
    once('pr', async () => {
      const list = await pulls();
      if (list.length !== 1) throw new CheckError(`pull_count_${list.length}`);
      const number = list[0]?.number;
      if (!Number.isSafeInteger(number) || number < 1) throw new CheckError('pull_list_invalid');
      const { body } = await get(`${repoPath(input.upstream)}/pulls/${number}`);
      if (!isRecord(body) || body.number !== number) throw new CheckError('pull_detail_invalid');
      return body;
    });

  const check = async (id, title, fn) => {
    try {
      return { id, title, pass: true, detail: await fn() };
    } catch (error) {
      return {
        id,
        title,
        pass: false,
        detail: error instanceof CheckError ? error.code : 'unexpected_error',
      };
    }
  };

  return [
    await check('receipts', 'receipts verify with the controller key', async () => {
      const all = await receipts();
      return `${all.length} receipt(s), ${(await candidates()).length} verified candidate(s)`;
    }),
    await check('identity', 'repository IDs match the signed receipt', async () => {
      const ids = await signed();
      const upstream = (await get(repoPath(input.upstream))).body;
      const fork = (await get(repoPath(input.fork))).body;
      if (!isRecord(upstream) || upstream.id !== ids.upstreamId)
        throw new CheckError('upstream_id_mismatch');
      if (!isRecord(fork) || fork.id !== ids.forkId) throw new CheckError('fork_id_mismatch');
      if (fork.fork !== true || !isRecord(fork.parent) || fork.parent.id !== ids.upstreamId)
        throw new CheckError('fork_parent_mismatch');
      if (lower(fork.owner?.login) !== lower(ids.contributor))
        throw new CheckError('fork_owner_not_contributor');
      return `upstream ${ids.upstreamId}, fork ${ids.forkId}`;
    }),
    await check('fork-branch', 'fork branch SHA equals the verified candidate', async () => {
      const ev = await evidence();
      const latest = (await candidates()).at(-1);
      const branchPath = ev.branch
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
      const { body } = await get(`${repoPath(input.fork)}/git/ref/heads/${branchPath}`);
      if (!isRecord(body) || body.ref !== `refs/heads/${ev.branch}`)
        throw new CheckError('fork_ref_ambiguous');
      if (body.object?.type !== 'commit' || !isSha(body.object.sha))
        throw new CheckError('fork_ref_invalid');
      if (body.object.sha !== latest)
        throw new CheckError(`fork_sha_${body.object.sha.slice(0, 12)}`);
      return `${ev.branch} = ${latest}`;
    }),
    await check('single-pr', 'exactly one PR for head and base (state=all)', async () => {
      const ev = await evidence();
      const ids = await signed();
      const detail = await pr();
      if (
        lower(detail.head?.repo?.full_name) !== lower(input.fork) ||
        detail.head?.ref !== ev.branch
      )
        throw new CheckError('pull_head_mismatch');
      if (
        lower(detail.base?.repo?.full_name) !== lower(input.upstream) ||
        detail.base?.ref !== ids.defaultBranch
      )
        throw new CheckError('pull_base_mismatch');
      if (lower(detail.user?.login) !== lower(ids.contributor))
        throw new CheckError('pull_author_not_contributor');
      const recorded = ev.publication?.url ?? null;
      if (recorded === null && ev.trackedPr?.number === undefined)
        throw new CheckError('pull_not_recorded_by_run');
      if (recorded !== null && recorded !== detail.html_url)
        throw new CheckError('pull_url_mismatch');
      if (ev.trackedPr && ev.trackedPr.number !== detail.number)
        throw new CheckError('pull_number_mismatch');
      return `${detail.html_url} (${detail.state})`;
    }),
    await check('pr-body', 'PR body has the marker, disclosure and commands', async () => {
      const ev = await evidence();
      const named = checkPrBody(
        (await pr()).body,
        { contributionId: ev.contributionId, receipts: await receipts() },
        zt
      );
      return `${named.commands.length} command(s) for ${named.candidateSha.slice(0, 12)}`;
    }),
    input.afterRevision
      ? await check('pr-head', 'PR head is the second verified candidate', async () => {
          const list = await candidates();
          const head = (await pr()).head?.sha;
          if (list.length < 2) throw new CheckError('no_second_verified_candidate');
          if (head !== list.at(-1)) throw new CheckError('pull_head_not_latest_verified');
          if (head === list[0]) throw new CheckError('pull_head_unchanged');
          return `${list[0].slice(0, 12)} -> ${head}`;
        })
      : await check('pr-head', 'PR head is the verified candidate', async () => {
          const head = (await pr()).head?.sha;
          if (head !== (await candidates()).at(-1)) throw new CheckError('pull_head_not_verified');
          return head;
        }),
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
    err(`error: ${error instanceof CheckError ? error.code : 'controller_key_unreadable'}`);
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
    out(passed ? 'ALL CHECKS PASSED' : 'ACCEPTANCE CHECK FAILED');
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
