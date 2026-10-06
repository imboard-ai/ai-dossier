import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ed25519Signer, Ed25519Verifier } from '@ai-dossier/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Intent, IntentDriver, idempotencyKey } from '../intents';
import { Journal } from '../journal';
import {
  issueReceipt,
  type ReceiptInput,
  receiptDigest,
  type SignedReceipt,
} from '../receipt/issue';
import { ReceiptNonceStore } from '../receipt/nonces';
import { renderReceipt } from '../receipt/render';
import { canonicalJson, parseReceipt, RECEIPT_TTL_MS } from '../receipt/schema';
import { authorizeShipping, type ReceiptContext, verifyReceipt } from '../receipt/verify';
import { createRun, ReasonCode, transitionRun } from '../state';

const SHA = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const AT = Date.parse('2026-10-06T00:00:00.000Z');
let directory: string;
let signer: Ed25519Signer;
let publicKey: string;
let input: ReceiptInput;
let context: ReceiptContext;
let intent: Intent;
let store: ReceiptNonceStore;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-'));
  const keys = generateKeyPairSync('ed25519');
  const keyFile = path.join(directory, 'controller.pem');
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  signer = new Ed25519Signer(keyFile);
  publicKey = await signer.getPublicKey();
  const operation = {
    contributionId: 'contribution-1',
    target: 'fork:22:branch:task',
    operationKind: 'push_branch' as const,
    candidateSha: CANDIDATE,
  };
  intent = {
    ...operation,
    key: idempotencyKey(operation),
    status: 'attempted',
    attempts: 1,
    retryReady: false,
    artifactRef: null,
  };
  input = {
    contributionId: 'contribution-1',
    runId: 'run-1',
    sessionId: 'session-1',
    contributor: 'alice',
    upstreamRepositoryId: 11,
    forkRepositoryId: 22,
    issue: 8,
    defaultBranch: 'main',
    baseSha: SHA,
    parentSha: SHA,
    candidateSha: CANDIDATE,
    profileDigest: DIGEST,
    policyDigest: DIGEST,
    profile: { name: 'node-22', runtime: '22.0.0', imageDigest: `sha256:${DIGEST}` },
    commands: [
      {
        id: 'regression',
        command: 'npm test',
        required: true,
        status: 'passed',
        exitStatus: 0,
        suites: 3,
        sanitizedLogDigest: DIGEST,
      },
    ],
    networkPolicy: {
      acquisition: 'github-public',
      provisioning: 'package-proxy',
      verification: 'offline',
      shipping: 'github-clean',
    },
    permittedShippingOperations: [
      {
        kind: 'push_branch',
        target: operation.target,
        operationKey: intent.key,
        nonce: 'nonce-1',
        expectedRemoteSha: SHA,
      },
    ],
  };
  const { commands: _commands, permittedShippingOperations: _operations, ...bindings } = input;
  context = {
    ...bindings,
    requiredCommands: [{ id: 'regression', command: 'npm test' }],
    policyPermitsShipping: true,
    allowedShippingOperations: [
      { kind: 'push_branch', target: operation.target, expectedRemoteSha: SHA },
    ],
  };
  fs.mkdirSync(path.join(directory, 'nonces'));
  store = new ReceiptNonceStore(path.join(directory, 'nonces'));
  store.initialize();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});
const issue = () => issueReceipt(input, signer, () => AT);
const verify = (r: SignedReceipt, c = context, clock = AT) =>
  verifyReceipt(r, publicKey, c, () => clock);
const authorize = (r: SignedReceipt, i = intent, s = store) =>
  authorizeShipping(r, publicKey, context, i, SHA, s, () => AT);

describe('controller receipt — scenarios 10/17, contributor integrity, S3/S4', () => {
  it.each([
    true,
    false,
  ])('real IntentDriver persists attempt before authorization and observes writes only for valid policy: %s', async (allowed) => {
    const r = await issue();
    if (!allowed) context.allowedShippingOperations = [];
    const journal = new Journal(path.join(directory, 'intents'));
    const writes: string[] = [];
    const driver = new IntentDriver(
      journal,
      {
        reconcile: async () => ({ kind: 'absent' }),
        mutate: async (attempted) => {
          expect(journal.read().at(-1)).toMatchObject({ type: 'attempted', key: attempted.key });
          await authorize(r, attempted);
          writes.push(attempted.key);
          return { artifactRef: 'https://github.com/alice/fork/tree/task', remoteSha: CANDIDATE };
        },
      },
      {
        run: [
          ReasonCode.GatePassed,
          ReasonCode.PlanApproved,
          ReasonCode.CandidateReady,
          ReasonCode.VerificationPassed,
        ].reduce(
          (run, reason) => transitionRun(run, reason, new Date(AT).toISOString()),
          createRun(
            {
              runId: 'run-1',
              contributor: 'alice',
              upstreamIssue: 'https://github.com/o/r/issues/8',
            },
            new Date(AT).toISOString()
          )
        ),
        contributionId: input.contributionId,
      },
      () => new Date(AT).toISOString()
    );
    try {
      if (allowed) {
        await driver.execute(intent);
        await driver.execute(intent);
        expect(writes).toEqual([intent.key]);
      } else {
        await expect(driver.execute(intent)).rejects.toThrow('Mutation outcome uncertain');
        expect(writes).toEqual([]);
      }
    } finally {
      journal.close();
    }
  });
  it('requires fresh policy scope even for a valid signed grant, without consuming on denial', async () => {
    const r = await issue();
    context.allowedShippingOperations = [];
    const consumed = vi.spyOn(store, 'consume');
    await expect(authorize(r)).rejects.toThrow('policy_scope_denied');
    expect(consumed).not.toHaveBeenCalled();
    context.allowedShippingOperations = [
      { kind: 'push_branch', target: intent.target, expectedRemoteSha: SHA },
    ];
    await expect(authorize(r)).resolves.toBeDefined();
  });
  it('neutralizes worker success claims in rendered text when checks are inconclusive', async () => {
    input.commands[0].command = 'printf "all tests passed"';
    input.commands[0].status = 'inconclusive';
    const text = renderReceipt((await issue()).receipt);
    expect(text).not.toMatch(/all tests passed/i);
    expect(text).toContain('[untrusted success claim]');
  });
  it('rejects signer algorithms and inconsistent signatures at issuance', async () => {
    await expect(
      issueReceipt(
        input,
        {
          algorithm: 'kms',
          sign: signer.sign.bind(signer),
          getPublicKey: signer.getPublicKey.bind(signer),
        },
        () => AT
      )
    ).rejects.toThrow('unsupported_signer');
    await expect(
      issueReceipt(
        input,
        {
          algorithm: 'ed25519',
          sign: async () => ({
            algorithm: 'ed25519',
            public_key: publicKey,
            signature: Buffer.alloc(64).toString('base64'),
            signed_at: new Date(AT).toISOString(),
          }),
          getPublicKey: signer.getPublicKey.bind(signer),
        },
        () => AT
      )
    ).rejects.toThrow('invalid_signature');
    await expect(issueReceipt(input, signer, () => NaN)).rejects.toThrow('invalid_clock');
    input.permittedShippingOperations[0].operationKey = 'other';
    await expect(issue()).rejects.toThrow('invalid_scope');
  });
  it('denies expiry between signature verification and nonce burn without a write', async () => {
    const r = await issue();
    let calls = 0;
    const consume = vi.spyOn(store, 'consume');
    await expect(
      authorizeShipping(r, publicKey, context, intent, SHA, store, () =>
        ++calls === 1 ? AT : AT + RECEIPT_TTL_MS
      )
    ).rejects.toThrow('expired');
    expect(consume).not.toHaveBeenCalled();
  });
  it('round-trips the ACTUAL public core signer shape and canonical bytes', async () => {
    const r = await issue();
    expect(r.signature).toEqual({
      algorithm: 'ed25519',
      signature: expect.any(String),
      public_key: publicKey,
      signed_at: expect.any(String),
    });
    expect((await new Ed25519Verifier().verify(canonicalJson(r.receipt), r.signature)).valid).toBe(
      true
    );
    expect(await verify(r)).toEqual(r.receipt);
    expect(Date.parse(r.receipt.expiresAt) - Date.parse(r.receipt.issuedAt)).toBe(RECEIPT_TTL_MS);
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: true })).toBe('{"a":true,"z":{"a":1,"b":2}}');
    expect(receiptDigest({ ...r.receipt })).toBe(r.digest);
    expect(await authorize(r)).toEqual(r.receipt.permittedShippingOperations[0]);
  });
  it('rejects a modified evidence byte even with a recomputed digest', async () => {
    const r = await issue();
    r.receipt.commands[0].sanitizedLogDigest = 'd'.repeat(64);
    await expect(verify(r)).rejects.toThrow('digest_mismatch');
    r.digest = receiptDigest(r.receipt);
    await expect(verify(r)).rejects.toThrow('bad_signature');
  });
  it('rejects a bad signature', async () => {
    const r = await issue();
    r.signature.signature = Buffer.alloc(64).toString('base64');
    await expect(verify(r)).rejects.toThrow('bad_signature');
  });
  it('does not trust an attacker signing key supplied in the envelope', async () => {
    const other = generateKeyPairSync('ed25519');
    const file = path.join(directory, 'attacker.pem');
    fs.writeFileSync(file, other.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await expect(
      verify(await issueReceipt(input, new Ed25519Signer(file), () => AT))
    ).rejects.toThrow('bad_signature');
  });
  it.each([
    'parentSha',
    'baseSha',
    'candidateSha',
    'contributor',
    'upstreamRepositoryId',
    'forkRepositoryId',
    'issue',
    'defaultBranch',
    'contributionId',
    'runId',
    'sessionId',
    'policyDigest',
    'profileDigest',
  ] as const)('rejects wrong exact binding: %s', async (field) => {
    const wrong = {
      ...context,
      [field]:
        typeof context[field] === 'number'
          ? 99
          : field.endsWith('Sha')
            ? 'd'.repeat(40)
            : field.endsWith('Digest')
              ? 'd'.repeat(64)
              : 'other',
    };
    await expect(verify(await issue(), wrong)).rejects.toThrow(`wrong_${field}`);
  });
  it('rejects profile/runtime and network-policy drift', async () => {
    const r = await issue();
    await expect(
      verify(r, { ...context, profile: { ...context.profile, runtime: '20' } })
    ).rejects.toThrow('wrong_profile');
    await expect(
      verify(r, { ...context, networkPolicy: { ...context.networkPolicy, verification: 'online' } })
    ).rejects.toThrow('wrong_networkPolicy');
  });
  it('rejects expiry at the exact 15-minute boundary and future issuance', async () => {
    const r = await issue();
    await expect(verify(r, context, AT + RECEIPT_TTL_MS - 1)).resolves.toBeDefined();
    await expect(verify(r, context, AT + RECEIPT_TTL_MS)).rejects.toThrow('expired');
    await expect(verify(r, context, AT - 1)).rejects.toThrow('expired');
    await expect(verify(r, context, Number.NaN)).rejects.toThrow('expired');
  });
  it('rejects a forged extended lifetime even when signed', async () => {
    const r = await issue();
    r.receipt.expiresAt = new Date(AT + RECEIPT_TTL_MS + 1).toISOString();
    expect(() => parseReceipt(r.receipt)).toThrow('invalid_expiry');
  });
  it.each([
    'failed',
    'inconclusive',
    'skipped',
  ] as const)('cannot verify or render blanket pass for %s', async (status) => {
    input.commands[0].status = status;
    const r = await issue();
    expect(r.receipt.verified).toBe(false);
    await expect(verify(r)).rejects.toThrow('unverified');
    expect(renderReceipt(r.receipt)).toContain(status);
    expect(renderReceipt(r.receipt)).not.toMatch(/all tests passed/i);
    r.receipt.verified = true;
    expect(() => parseReceipt(r.receipt)).toThrow('invalid_evidence');
  });
  it.each([
    { suites: 'unknown' },
    { suites: 0 },
    { exitStatus: 'unknown' },
    { exitStatus: 1 },
  ] as const)('unknown or contradictory evidence cannot earn verified: %j', async (patch) => {
    Object.assign(input.commands[0], patch);
    const r = await issue();
    expect(r.receipt.verified).toBe(false);
    await expect(authorize(r)).rejects.toThrow('unverified');
    expect(renderReceipt(r.receipt)).not.toMatch(/all tests passed/i);
  });
  it('cannot omit required commands or substitute a command under the same ID', async () => {
    const r = await issue();
    await expect(
      verify(r, { ...context, requiredCommands: [{ id: 'regression', command: 'true' }] })
    ).rejects.toThrow('required_commands_mismatch');
    await expect(
      verify(r, {
        ...context,
        requiredCommands: [...context.requiredCommands, { id: 'build', command: 'npm run build' }],
      })
    ).rejects.toThrow('required_commands_mismatch');
    await expect(verify(r, { ...context, requiredCommands: [] })).rejects.toThrow('unverified');
    input.commands[0].required = false;
    expect((await issue()).receipt.verified).toBe(false);
  });
  it('fails closed on revocation and operation scope/expected remote mismatch', async () => {
    const r = await issue();
    await expect(verify(r, { ...context, policyPermitsShipping: false })).rejects.toThrow(
      'policy_denied'
    );
    const wrong = { ...intent, target: 'fork:99:branch:task' };
    wrong.key = idempotencyKey(wrong);
    await expect(authorize(r, wrong)).rejects.toThrow('operation_denied');
    await expect(
      authorizeShipping(r, publicKey, context, intent, null, store, () => AT)
    ).rejects.toThrow('operation_denied');
    const pr = { ...intent, operationKind: 'pr_create' as const };
    pr.key = idempotencyKey(pr);
    await expect(authorize(r, pr)).rejects.toThrow('operation_denied');
    await expect(authorize(r, { ...intent, status: 'intended' })).rejects.toThrow(
      'unjournaled_operation'
    );
  });
  it('consumes single-use nonce durably and rejects replay after restart', async () => {
    const r = await issue();
    await authorize(r);
    const reopened = new ReceiptNonceStore(path.join(directory, 'nonces'));
    await expect(authorize(r, intent, reopened)).rejects.toThrow('replayed_nonce');
    expect(fs.readFileSync(path.join(directory, 'nonces/events.jsonl'), 'utf8')).toContain(
      r.digest
    );
  });
  it('cannot authorize the same journaled attempt twice using newly issued nonces', async () => {
    const first = await issue();
    await authorize(first);
    input.permittedShippingOperations[0].nonce = 'new-nonce';
    const second = await issue();
    await expect(authorize(second)).rejects.toThrow('replayed_operation');
    // IntentDriver creates attempt 2 only after reconciliation proved absence;
    // a new receipt/current policy then permits that new journaled attempt once.
    await expect(authorize(second, { ...intent, attempts: 2 })).resolves.toBeDefined();
    await expect(authorize(second, { ...intent, attempts: 2 })).rejects.toThrow('replayed_nonce');
  });
  it('serializes concurrent authorizations and burns per operation, not whole receipt', async () => {
    const pr = { ...intent, operationKind: 'pr_create' as const };
    pr.key = idempotencyKey(pr);
    input.permittedShippingOperations.push({
      kind: 'pr_create',
      target: pr.target,
      operationKey: pr.key,
      nonce: 'nonce-2',
      expectedRemoteSha: null,
    });
    context.allowedShippingOperations.push({
      kind: 'pr_create',
      target: pr.target,
      expectedRemoteSha: null,
    });
    const r = await issue();
    const results = await Promise.allSettled([authorize(r), authorize(r)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    await expect(
      authorizeShipping(r, publicKey, context, pr, null, store, () => AT)
    ).resolves.toMatchObject({ nonce: 'nonce-2' });
  });
  it('snapshots inputs before async signing; rejects getter and non-JSON tricks', async () => {
    const original = signer.sign.bind(signer);
    const wrapped = {
      algorithm: 'ed25519',
      getPublicKey: () => signer.getPublicKey(),
      sign: async (bytes: string) => {
        input.candidateSha = 'd'.repeat(40);
        return original(bytes);
      },
    };
    const r = await issueReceipt(input, wrapped, () => AT);
    expect(r.receipt.candidateSha).toBe(CANDIDATE);
    const getter = { ...r.receipt };
    Object.defineProperty(getter, 'contributor', { enumerable: true, get: () => 'ghp_secret' });
    expect(() => renderReceipt(getter)).toThrow('invalid_json');
    for (const value of [
      undefined,
      NaN,
      -0,
      new Date(),
      new Array(2),
      { toJSON: () => ({}) },
      '\ud800',
    ])
      expect(() => canonicalJson(value)).toThrow();
  });
  it.each([
    'ghp_secret',
    'github_pat_secret',
    'ghs_secret',
    'ghu_syntheticUserToken',
    'GHO_SYNTHETIC',
    'ghr_synthetic',
    'sk-proj-syntheticKey',
    'Authorization: token x',
    '_sk-proj-syntheticKey_',
    'credential_sk-12345678',
    String.raw`\nsk-proj-syntheticKey`,
    String.raw`Authorization:\ttoken\tx`,
    String.raw`Authorization:\x09token\x20x`,
    String.raw`Authorization:\u0009token\u0020x`,
    'sk-ant-secret',
    'Bearer\tsecret',
    'Bearer\nsecret',
  ])('rejects secrets without echoing them: %s', async (secret) => {
    input.commands[0].command = `npm test ${secret}`;
    const sign = vi.spyOn(signer, 'sign');
    await expect(issue()).rejects.not.toThrow(secret);
    await expect(issue()).rejects.toThrow('prohibited credential');
    expect(sign).not.toHaveBeenCalled();
  });
  it('escapes hostile HTML/Markdown and reports actual counts/log digests', async () => {
    input.commands[0].command = 'npm test </code><script>alert(1)</script> `\n';
    const text = renderReceipt((await issue()).receipt);
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&#96;&#10;');
    expect(text).toContain('suites=3');
    expect(text).toContain(DIGEST);
    expect(text).toContain(CANDIDATE);
  });
  it('rejects unknown schema fields/statuses, IDs-as-strings and short SHAs', async () => {
    const r = (await issue()).receipt;
    for (const patch of [
      { extra: 'value' },
      { upstreamRepositoryId: '11' },
      { candidateSha: 'abcd' },
      { schemaVersion: 'v2' },
      { commands: [{ ...r.commands[0], status: 'timeout' }] },
    ])
      expect(() => parseReceipt({ ...r, ...patch })).toThrow('invalid_schema');
  });
  it('bounds aggregate serialization before materializing arbitrarily large output', () => {
    expect(() => canonicalJson(Array.from({ length: 128 }, () => 'x'.repeat(8192)))).toThrow(
      'invalid_json'
    );
    expect(() =>
      canonicalJson(Object.fromEntries(Array.from({ length: 20001 }, (_, n) => [String(n), true])))
    ).toThrow('invalid_json');
  });
});

describe('controller nonce durability — concurrent processes and crash boundaries', () => {
  const row = { nonce: 'nonce-1', operationKey: 'operation-1', receiptDigest: DIGEST, attempt: 1 };
  it('a failure after the durable append does not yield permission or allow another writer', () => {
    const append = Journal.prototype.append;
    vi.spyOn(Journal.prototype, 'append').mockImplementation(function (this: Journal, event) {
      append.call(this, event);
      throw new Error('lost acknowledgement after fsync');
    });
    expect(() => store.consume(row)).toThrow('lost acknowledgement');
    vi.restoreAllMocks();
    expect(fs.readFileSync(path.join(directory, 'nonces/events.jsonl'), 'utf8')).toContain(
      row.nonce
    );
    expect(() => new ReceiptNonceStore(path.join(directory, 'nonces')).consume(row)).toThrow(
      'store_locked'
    );
    // Simulate supervisor proving old owner stopped and reconciling its durable
    // history, then releasing the lock. The nonce still cannot authorize twice.
    fs.unlinkSync(path.join(directory, 'nonces/receipt.lock'));
    expect(() => new ReceiptNonceStore(path.join(directory, 'nonces')).consume(row)).toThrow(
      'replayed_nonce'
    );
  });
  it('rejects coerced identifiers and unsafe store aliases', () => {
    expect(() => store.consume({ ...row, nonce: 42 } as unknown as typeof row)).toThrow(
      'corrupt_store'
    );
    const alias = path.join(directory, 'alias');
    fs.symlinkSync(path.join(directory, 'nonces'), alias);
    expect(() => new ReceiptNonceStore(alias)).toThrow('unsafe_store');
  });
  it('missing, corrupt or torn history never resets the consumed set', () => {
    const file = path.join(directory, 'nonces/events.jsonl');
    fs.unlinkSync(file);
    expect(() => store.consume(row)).toThrow('missing_store');
    fs.writeFileSync(file, '{"v":1,"type":"receipt-nonces"}\n{"nonce":');
    expect(() => store.consume(row)).toThrow();
  });
  it('fsync failure returns no authorization and fences even a reopened controller', () => {
    const original = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (++calls === 2) throw new Error('disk failure');
      original(fd);
    });
    expect(() => store.consume(row)).toThrow();
    vi.restoreAllMocks();
    expect(() => store.consume(row)).toThrow('persistence_uncertain');
    expect(() => new ReceiptNonceStore(path.join(directory, 'nonces')).consume(row)).toThrow(
      'store_locked'
    );
  });
  it('retains a durable consumed record after real controller SIGKILL following authorization', async () => {
    const code = `const {ReceiptNonceStore}=require(${JSON.stringify(path.resolve(__dirname, '../../dist/receipt/nonces.js'))});new ReceiptNonceStore(process.argv[1]).consume(${JSON.stringify(row)});process.send('consumed');setInterval(()=>{},1000)`;
    const child = spawn(process.execPath, ['-e', code, path.join(directory, 'nonces')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise<string | null>((resolve) =>
      child.on('exit', (_code, signal) => resolve(signal))
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(new Error('child exited before consumption')));
      });
      child.kill('SIGKILL');
      expect(await exited).toBe('SIGKILL');
    } finally {
      child.kill('SIGKILL');
    }
    expect(() => store.consume(row)).toThrow('replayed_nonce');
  });
  it('admits at most one of separate processes racing the same nonce', async () => {
    const code = `const {ReceiptNonceStore}=require(${JSON.stringify(path.resolve(__dirname, '../../dist/receipt/nonces.js'))});try{new ReceiptNonceStore(process.argv[1]).consume(${JSON.stringify(row)});process.exit(0)}catch{process.exit(2)}`;
    const results = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, ['-e', code, path.join(directory, 'nonces')], {
              stdio: 'ignore',
            });
            child.on('exit', resolve);
          })
      )
    );
    expect(results.filter((n) => n === 0)).toHaveLength(1);
    expect(results.filter((n) => n === 2)).toHaveLength(7);
  });
  it('crashed lock cannot be stolen and blocks until explicit supervisor reconciliation', () => {
    fs.writeFileSync(path.join(directory, 'nonces/receipt.lock'), 'dead-owner');
    expect(() => store.consume(row)).toThrow('store_locked');
    expect(() => store.initialize()).toThrow('store_locked');
  });
  it('consumption journal is private, no-follow, and rejects replay/corrupt entries', () => {
    store.consume(row);
    const file = path.join(directory, 'nonces/events.jsonl');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const journal = new Journal(path.join(directory, 'nonces'));
    journal.append(row);
    journal.close();
    expect(() => store.consume({ ...row, nonce: 'nonce-2' })).toThrow('corrupt_store');
    expect(() => store.initialize()).toThrow('store_exists');
  });
});
