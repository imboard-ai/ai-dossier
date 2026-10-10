import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localGit } from '../__tests__/local-git';
import { BudgetLedger } from '../budget';
import { acquireSource } from '../canonical/acquire';
import { Journal } from '../journal';
import { ReasonCode as R, transitionRun } from '../state';
import { validateRunConfig } from './config';
import {
  applyUserPatch,
  changeCheckpoints,
  changeIdentity,
  changeModelProfile,
  latestSourceEdit,
  validateUserPatch,
} from './edits';
import { RunStore } from './run-store';
import { implementationPhaseKey, StepArtifacts } from './steps';
import { loadVerification } from './verification-record';

const dirs: string[] = [];
const stores: RunStore[] = [];
const at = '2026-10-10T00:00:00.000Z';
const now = new Date(at);
const patch = (file = 'file', before = 'old', after = 'fixed') =>
  Buffer.from(
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`
  );
function rig(origin: 'implementing' | 'verifying' | 'shipping' | 'planning' = 'implementing') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-edits-'));
  dirs.push(dir);
  const signerKeyFile = path.join(dir, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'openai-compatible',
    model: 'fixture',
    endpoint: 'https://model.example/v1',
    apiKeyEnv: 'EDIT_MODEL_KEY',
  };
  const config = validateRunConfig({
    issueUrl: 'https://github.com/owner/repo/issues/1',
    contributor: 'alice',
    authorApproval: {
      userId: 12,
      login: 'alice',
      name: 'Alice',
      email: '12+alice@users.noreply.github.com',
      source: 'default',
      approvedAt: at,
    },
    executionProfile: {
      provider: 'local-qemu',
      profileDir: dir,
      stateDir: dir,
      accelerator: 'tcg',
      proxyEndpointsFile: path.join(dir, 'proxy.json'),
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase },
      rates: ['fixture', 'next', 'local-qemu'].map((resource) => ({
        resource,
        currency: 'USD',
        unit: resource === 'local-qemu' ? 'millisecond' : 'token',
        price: 0,
        units: 1,
        source: 'fixture',
        fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: at },
      })),
    },
    budget: {
      currency: 'USD',
      ceilingMinor: 100,
      cleanupAllowanceMinor: 10,
      tokenLimit: 1000,
      activeMinutes: 120,
    },
    signerKeyFile,
    githubApp: {
      appId: 1,
      clientId: 'fixture',
      slug: 'fixture',
      privateKeyEnv: 'APP_KEY',
      clientSecretEnv: 'APP_SECRET',
    },
  });
  const root = path.join(dir, 'runs');
  const store = RunStore.create(root, config, at);
  stores.push(store);
  const reasons = [
    R.GatePassed,
    ...(origin === 'planning' ? [] : [R.PlanApproved]),
    ...(['verifying', 'shipping'].includes(origin) ? [R.CandidateReady] : []),
    ...(origin === 'shipping' ? [R.VerificationPassed] : []),
    R.UserPaused,
  ];
  for (const reason of reasons) store.persistRun(transitionRun(store.run, reason, at));
  const remote = path.join(dir, 'upstream');
  fs.mkdirSync(remote);
  const git = (args: string[], input?: string) => localGit(remote, args, input).toString().trim();
  git(['init', '--bare', '--template=', '.']);
  const blob = git(['hash-object', '-w', '--stdin'], 'old\n');
  const tree = git(['mktree'], `100644 blob ${blob}\tfile\n`);
  const baseSha = git(
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', 'commit-tree', tree],
    'base\n'
  );
  git(['update-ref', 'refs/heads/main', baseSha]);
  const source = acquireSource(
    { owner: 'owner', repo: 'repo', baseSha },
    { remoteUrlForTest: pathToFileURL(remote).href }
  );
  const j = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  const artifacts = new StepArtifacts(j, store.runId);
  artifacts.put('source', { manifest: source.manifest, pack: source.pack.toString('base64') });
  artifacts.put('gate', { baseSha, policyDigest: 'a'.repeat(64) });
  j.close();
  const ledgerPath = path.join(store.storeDirectory('budget'), 'ledger.json');
  const ledger = new BudgetLedger(ledgerPath, store.contributionId);
  ledger.initialize([], config.modelProfile.rates);
  ledger.startSession({
    id: store.budgetSessionId(1),
    ceiling: { currency: 'USD', minor: 100 },
    cleanupAllowance: 10,
    tokenLimit: 1000,
    timeLimitMs: 7200000,
  });
  return { dir, root, store, config, ledger, ledgerPath };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('trusted paused user mutations', () => {
  it('unsafe patches observe zero artifact/overlay publication against a nonempty candidate, including reopen', () => {
    const h = rig();
    applyUserPatch(h.store, h.store.run, patch(), now);
    const before = h.store.userChanges;
    const diffFile = path.join(h.store.storeDirectory('artifacts'), 'candidate.diff');
    const diff = fs.readFileSync(diffFile);
    const rename = vi.spyOn(fs, 'renameSync');
    for (const bytes of [
      patch('../escape'),
      patch('.git/config'),
      Buffer.from('diff --git a/file b/file\nnew mode 120000\n'),
      Buffer.from('diff --git a/file b/file\nGIT binary patch\nliteral 4\ndata\n'),
    ]) {
      expect(() => applyUserPatch(h.store, h.store.run, bytes, now)).toThrow('invalid_patch');
      expect(h.store.userChanges).toEqual(before);
      expect(fs.readFileSync(diffFile)).toEqual(diff);
    }
    expect(rename).not.toHaveBeenCalled();
    // Recording assertion is sensitive to an injected forbidden publication.
    rename.mockImplementationOnce(() => {});
    fs.renameSync('injected-forbidden-source-write', 'injected-forbidden-destination');
    expect(() => expect(rename).not.toHaveBeenCalled()).toThrow();
    rename.mockRestore();
    const id = h.store.runId;
    h.store.close();
    const reopened = RunStore.open(h.root, id);
    stores.push(reopened);
    expect(reopened.userChanges).toEqual(before);
    expect(fs.readFileSync(diffFile)).toEqual(diff);
  });
  it('includes admitted paused-repair writes before applying a contributor patch', () => {
    const h = rig();
    const previous = applyUserPatch(h.store, h.store.run, patch(), now);
    const j = new Journal(path.join(h.store.storeDirectory('control'), 'steps'));
    const artifacts = new StepArtifacts(j, h.store.runId);
    artifacts.put('candidate', previous);
    artifacts.put('applied_user_edit', 1);
    artifacts.put('implementation_attempt', { phaseKey: implementationPhaseKey(h.store.run) });
    artifacts.put('implementation_continuation', {
      baseDigest: previous.manifest.digest,
      writes: [
        { path: 'file', content: 'repair\n' },
        { path: 'other', content: 'admitted repair\n' },
      ],
    });
    j.close();
    const candidate = applyUserPatch(
      h.store,
      h.store.run,
      patch('file', 'repair', 'contributor'),
      now
    );
    expect(
      Buffer.from(
        candidate.manifest.entries.find((e) => e.path === 'file')?.bytes ?? '',
        'base64'
      ).toString()
    ).toBe('contributor\n');
    expect(
      Buffer.from(
        candidate.manifest.entries.find((e) => e.path === 'other')?.bytes ?? '',
        'base64'
      ).toString()
    ).toBe('admitted repair\n');
    expect(candidate.touched).toEqual(['file', 'other']);
  });
  it.each([
    ' key',
    'key ',
    'key\nvalue',
    '',
  ])('refuses unusable model key bytes before changing a paused run (%j)', (key) => {
    const h = rig();
    vi.stubEnv('EDIT_MODEL_KEY', key);
    expect(() => changeModelProfile(h.store, h.store.run, h.config.modelProfile, now)).toThrow(
      'model_key_missing'
    );
    expect(h.store.config.modelProfile).toEqual(h.config.modelProfile);
    expect(h.store.run.state).toBe('paused_user');
  });
  it('applies a text patch through hardened Git and reopens the exact candidate and disclosure', () => {
    const h = rig();
    const candidate = applyUserPatch(h.store, h.store.run, patch(), now);
    expect(Buffer.from(candidate.manifest.entries[0].bytes, 'base64').toString()).toBe('fixed\n');
    expect(candidate.touched).toEqual(['file']);
    expect(h.store.run.state).toBe('paused_user');
    expect(latestSourceEdit(h.store)?.patchDigest).toMatch(/^[a-f0-9]{64}$/u);
    const id = h.store.runId;
    h.store.close();
    const reopened = RunStore.open(h.root, id);
    stores.push(reopened);
    expect(latestSourceEdit(reopened)?.candidate).toEqual(candidate);
    expect(reopened.validateEvidence().state).toBe('paused_user');
    const next = applyUserPatch(reopened, reopened.run, patch('file', 'fixed', 'second'), now);
    expect(next.record.candidateSha).not.toBe(candidate.record.candidateSha);
  });
  it.each([
    '../escape',
    '.git/config',
    'nested/.GiT/config',
    '/absolute',
    'a\\b',
    'git~1/config',
  ])('refuses unsafe %s without changing source', (name) => {
    const h = rig();
    const before = h.store.userChanges;
    expect(() => applyUserPatch(h.store, h.store.run, patch(name), now)).toThrow('invalid_patch');
    expect(h.store.userChanges).toEqual(before);
  });
  it.each([
    'diff --git a/file b/file\nnew mode 120000\n',
    'diff --git a/file b/file\nGIT binary patch\nliteral 5\nhello\n',
    'diff --git a/file b/file\nold mode 100644\nnew mode 160000\n',
    'diff --git a/file b/file\nBinary files a/file and b/file differ\n',
    'diff --git a/"space file" b/"space file"\n',
    'diff --git a/file b/file\nrename to ../escape\n',
    'diff --git a/file b/file\n--unsafe-paths\n',
  ])('refuses unsupported metadata %s', (text) => {
    expect(() => validateUserPatch(Buffer.from(text))).toThrow('invalid_patch');
  });
  it('refuses nonmatching hunks, truncated/invalid UTF-8 and no diff', () => {
    const h = rig();
    expect(() => applyUserPatch(h.store, h.store.run, patch('file', 'missing'), now)).toThrow(
      'invalid_patch'
    );
    for (const bytes of [
      Buffer.from('hello'),
      Buffer.from([0xff]),
      Buffer.alloc(0),
      Buffer.from('diff --git a/file b/file\n\0'),
    ])
      expect(() => validateUserPatch(bytes)).toThrow('invalid_patch');
    expect(h.store.userChanges).toEqual([]);
  });
  it('allows exec-bit-only patches and refuses shipping/planning edits', () => {
    const h = rig();
    const c = applyUserPatch(
      h.store,
      h.store.run,
      Buffer.from('diff --git a/file b/file\nold mode 100644\nnew mode 100755\n'),
      now
    );
    expect(c.manifest.entries[0].mode).toBe('100755');
    const shipping = rig('shipping');
    expect(() => applyUserPatch(shipping.store, shipping.store.run, patch(), now)).toThrow(
      'edit_after_verification'
    );
    const planning = rig('planning');
    expect(() => applyUserPatch(planning.store, planning.store.run, patch(), now)).toThrow(
      'edit_not_paused'
    );
  });
  it('fences all old verification records before publishing an edited candidate', () => {
    const h = rig('verifying');
    const dir = path.join(h.store.storeDirectory('artifacts'), 'verification');
    fs.mkdirSync(dir, { mode: 0o700 });
    const sha = 'b'.repeat(40);
    fs.writeFileSync(path.join(dir, `${sha}.json`), '{}', { mode: 0o600 });
    applyUserPatch(h.store, h.store.run, patch(), now);
    expect(latestSourceEdit(h.store)?.superseded).toEqual([sha]);
    expect(() =>
      loadVerification(h.store.storeDirectory('artifacts'), sha, { runId: h.store.runId })
    ).toThrow('not_shippable');
  });
  it('changes models durably while preserving every ledger byte and source/verification', () => {
    const h = rig();
    vi.stubEnv('EDIT_MODEL_KEY', 'fixture-key');
    const before = fs.readFileSync(h.ledgerPath);
    const next = {
      ...h.config.modelProfile,
      phases: {
        ...h.config.modelProfile.phases,
        implementing: { ...h.config.modelProfile.phases.implementing, model: 'next' },
      },
    };
    changeModelProfile(h.store, h.store.run, next, now);
    expect(fs.readFileSync(h.ledgerPath)).toEqual(before);
    expect(h.store.config.modelProfile).toEqual(next);
    expect(latestSourceEdit(h.store)).toBeUndefined();
    const id = h.store.runId;
    h.store.close();
    const reopened = RunStore.open(h.root, id);
    stores.push(reopened);
    expect(reopened.config.modelProfile).toEqual(next);
    expect(reopened.validateEvidence().state).toBe('paused_user');
    expect(fs.readFileSync(h.ledgerPath)).toEqual(before);
  });
  it('refuses missing rates, missing keys, unknown adapter and identity changes', () => {
    const h = rig();
    const next = { ...h.config.modelProfile, rates: [] };
    expect(() => changeModelProfile(h.store, h.store.run, next, now)).toThrow('missing_rate');
    expect(() => changeModelProfile(h.store, h.store.run, h.config.modelProfile, now)).toThrow(
      'model_key_missing'
    );
    const unavailable = {
      ...h.config.modelProfile,
      phases: {
        ...h.config.modelProfile.phases,
        planning: { ...h.config.modelProfile.phases.planning, adapter: 'missing' },
      },
    };
    expect(() => changeModelProfile(h.store, h.store.run, unavailable, now)).toThrow(
      'model_unavailable'
    );
    for (const identity of [
      { contributor: 'bob' },
      { issueUrl: 'https://github.com/owner/repo/issues/2' },
      { upstream: 'other' },
      { fork: 'other' },
    ])
      expect(() => changeIdentity(h.store, h.store.run, identity)).toThrow(
        'identity_change_requires_new_run'
      );
    expect(h.store.userChanges).toEqual([]);
  });
  it('changes only valid checkpoints while paused and fails closed on corrupt persisted mutations', () => {
    const h = rig();
    changeCheckpoints(h.store, h.store.run, ['plan', 'patch'], now);
    expect(h.store.config.checkpoints).toEqual(['plan', 'patch']);
    expect(() => changeCheckpoints(h.store, h.store.run, ['patch', 'patch'], now)).toThrow(
      'invalid_checkpoints'
    );
    const id = h.store.runId;
    const file = path.join(h.store.storeDirectory('control'), 'events.jsonl');
    h.store.close();
    const contents = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, contents.replace('"checkpoints"', '"unknown"'));
    expect(() => RunStore.open(h.root, id)).toThrow();
  });
});
