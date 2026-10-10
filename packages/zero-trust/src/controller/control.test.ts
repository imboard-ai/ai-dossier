import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compiledFixture } from '../__tests__/compiled-fixture';
import { createRun, ReasonCode, transitionRun } from '../state';
import { validateRunConfig } from './config';
import { acknowledgeControl, controlRefusal, readControlRequests, requestControl } from './control';
import { RunStore } from './run-store';

const dirs: string[] = [];
const stores: RunStore[] = [];
const TIME = '2026-10-10T00:00:00.000Z';
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-control-'));
  dirs.push(root);
  const key = path.join(root, 'signer.pem');
  fs.writeFileSync(
    key,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'fake',
    model: 'fake',
    endpoint: 'https://model.example',
    apiKeyEnv: 'MODEL_KEY',
  };
  const config = validateRunConfig({
    issueUrl: 'https://github.com/owner/repo/issues/1',
    contributor: 'contributor',
    executionProfile: {
      provider: 'local-qemu',
      profileDir: 'profile',
      stateDir: root,
      accelerator: 'auto',
      proxyEndpointsFile: 'endpoints.json',
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase },
      rates: [
        {
          resource: 'fake',
          currency: 'USD',
          unit: 'token',
          price: 0,
          units: 1,
          source: 'fixture',
          fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: TIME },
        },
      ],
    },
    budget: {
      currency: 'USD',
      ceilingMinor: 100,
      cleanupAllowanceMinor: 10,
      tokenLimit: 100,
      activeMinutes: 120,
    },
    signerKeyFile: key,
    githubApp: {
      appId: 1,
      clientId: 'fixture',
      slug: 'fixture',
      privateKeyEnv: 'APP_KEY',
      clientSecretEnv: 'APP_SECRET',
    },
  });
  const store = RunStore.create(path.join(root, 'runs'), config, TIME);
  stores.push(store);
  return store;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
describe('durable stop-only control', () => {
  it('request and result visibility expose only one complete link to concurrent readers', () => {
    const store = rig();
    const observations: { links: number; invalid: boolean }[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (/\.(?:json|result)$/u.test(String(to))) {
        const seen = readControlRequests(store);
        observations.push({ links: fs.lstatSync(to).nlink, invalid: seen.invalid });
      }
    });
    const row = requestControl(store, { kind: 'cancel', reason: 'Stop work' }, new Date(TIME));
    acknowledgeControl(store, row, 'applied');
    expect(observations).toEqual([
      { links: 1, invalid: false },
      { links: 1, invalid: false },
    ]);
    expect(readControlRequests(store).pending).toHaveLength(0);
  });
  it.each([
    'request',
    'result',
  ] as const)('a real writer death at %s rename leaves readable complete evidence and releases only its publisher guard', (stage) => {
    const store = rig();
    const root = path.dirname(store.directory);
    const fixture = compiledFixture(path.dirname(root), 'controller/control');
    const row =
      stage === 'result'
        ? requestControl(store, { kind: 'cancel', reason: 'Stop work' }, new Date(TIME))
        : null;
    if (stage === 'result') store.close();
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const { RunStore } = require(${JSON.stringify(path.join(path.dirname(fixture), 'run-store.js'))});
      const { requestControl, acknowledgeControl } = require(${JSON.stringify(fixture)});
      const store = RunStore.open(${JSON.stringify(root)}, ${JSON.stringify(store.runId)}, ${stage === 'request' ? '{ readOnly: true, observe: true }' : '{}'});
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith(${JSON.stringify(stage === 'request' ? '.json' : '.result')})) process.kill(process.pid, 'SIGKILL'); };
      ${stage === 'request' ? `requestControl(store, { kind: 'cancel', reason: 'Stop work' }, new Date(${JSON.stringify(TIME)}));` : `acknowledgeControl(store, ${JSON.stringify(row)}, 'applied');`}
    `,
      ],
      { encoding: 'utf8', timeout: 30000 }
    );
    expect(child.signal, child.stderr).toBe('SIGKILL');
    const reader = stage === 'result' ? RunStore.open(root, store.runId) : store;
    if (reader !== store) stores.push(reader);
    const state = readControlRequests(reader);
    expect(state.invalid).toBe(false);
    expect(state.pending).toHaveLength(stage === 'request' ? 1 : 0);
    if (stage === 'request') acknowledgeControl(reader, state.pending[0], 'applied');
  }, 60000);
  it('publishes complete fsynced requests from independent observational stores while the owner holds its guard', () => {
    const store = rig();
    expect(readControlRequests(store)).toEqual({ pending: [], refused: [], invalid: false });
    const second = RunStore.open(path.dirname(store.directory), store.runId, {
      readOnly: true,
      observe: true,
    });
    stores.push(second);
    const sync = vi.spyOn(fs, 'fsyncSync');
    const one = requestControl(second, { kind: 'pause', reason: 'Hold work' }, new Date(TIME));
    const two = requestControl(second, { kind: 'cancel', reason: 'Stop work' }, new Date(TIME));
    expect(one.id).not.toBe(two.id);
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(
      readControlRequests(store)
        .pending.map((r) => r.id)
        .sort()
    ).toEqual([one.id, two.id].sort());
    acknowledgeControl(store, one, 'applied');
    acknowledgeControl(store, two, 'nothing_to_pause');
    expect(readControlRequests(store)).toEqual({
      pending: [],
      refused: ['nothing_to_pause'],
      invalid: false,
    });
    expect(store.run.state).toBe('gating');
  });
  it.each([
    'torn',
    'unknown',
    'utf8',
    'digest',
    'extra',
    'result',
    'orphan',
    'directory',
  ])('refuses %s evidence without echo or repair', (damage) => {
    const store = rig();
    const row = requestControl(store, { kind: 'pause', reason: 'Hold' }, new Date(TIME));
    const dir = path.join(store.storeDirectory('control'), 'requests');
    const file = path.join(dir, `${row.id}.json`);
    if (damage === 'torn') fs.writeFileSync(file, '{"v":');
    if (damage === 'unknown') fs.writeFileSync(path.join(dir, 'unknown'), 'untrusted');
    if (damage === 'utf8') fs.writeFileSync(file, Buffer.from([0xff]));
    if (damage === 'digest') fs.writeFileSync(file, JSON.stringify({ ...row, kind: 'cancel' }));
    if (damage === 'extra') fs.writeFileSync(file, JSON.stringify({ ...row, command: 'push' }));
    if (damage === 'result')
      fs.writeFileSync(path.join(dir, `${row.id}.result`), '{"v":1}', { mode: 0o600 });
    if (damage === 'orphan') {
      fs.unlinkSync(file);
      fs.writeFileSync(path.join(dir, `${row.id}.result`), '{}', { mode: 0o600 });
    }
    if (damage === 'directory') {
      fs.unlinkSync(file);
      fs.mkdirSync(file);
    }
    expect(readControlRequests(store).invalid).toBe(true);
  });
  it('never interprets unpublished staging bytes as a request', () => {
    const store = rig();
    requestControl(store, { kind: 'pause', reason: 'Hold' }, new Date(TIME));
    fs.writeFileSync(
      path.join(
        store.storeDirectory('control'),
        'requests',
        '.zt-write-00000000-0000-0000-0000-000000000000'
      ),
      '{'
    );
    expect(readControlRequests(store).invalid).toBe(false);
    expect(readControlRequests(store).pending).toHaveLength(1);
  });
  it.each([
    ['applied'],
    ['cancel'],
    1,
    true,
    null,
  ])('rejects non-string control enums without coercion (%j)', (value) => {
    const store = rig();
    const row = requestControl(store, { kind: 'pause', reason: 'Hold' }, new Date(TIME));
    const dir = path.join(store.storeDirectory('control'), 'requests');
    fs.writeFileSync(
      path.join(dir, `${row.id}.result`),
      JSON.stringify({ v: 1, digest: row.digest, result: value }),
      { mode: 0o600 }
    );
    expect(readControlRequests(store).invalid).toBe(true);
    fs.unlinkSync(path.join(dir, `${row.id}.result`));
    const { digest: _digest, ...body } = row;
    const changed = { ...body, kind: value };
    fs.writeFileSync(
      path.join(dir, `${row.id}.json`),
      JSON.stringify({
        ...changed,
        digest: createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
      })
    );
    expect(readControlRequests(store).invalid).toBe(true);
  });
  it('rejects invalid request fields and never persists credential material', () => {
    const store = rig();
    for (const reason of ['', 'x'.repeat(501), 'Authorization: Bearer fixture-token'])
      expect(() => requestControl(store, { kind: 'pause', reason }, new Date(TIME))).toThrow();
    expect(() =>
      requestControl(store, { kind: 'unknown' as 'pause', reason: 'Hold' }, new Date(TIME))
    ).toThrow('invalid_control');
    expect(readControlRequests(store).pending).toHaveLength(0);
  });
  it('refuses no-compute pause and blocked cleanup cancellation without writes', () => {
    const store = rig();
    store.persistRun(transitionRun(store.run, ReasonCode.PermissionRequired, TIME));
    expect(() => requestControl(store, { kind: 'pause', reason: 'Hold' }, new Date(TIME))).toThrow(
      'nothing_to_pause'
    );
    store.persistRun(transitionRun(store.run, ReasonCode.CleanupFailed, TIME));
    expect(() => requestControl(store, { kind: 'cancel', reason: 'Stop' }, new Date(TIME))).toThrow(
      'cleanup_required'
    );
    expect(readControlRequests(store).pending).toHaveLength(0);
  });
  it('terminal states cannot be reopened by control', () => {
    const run = transitionRun(
      createRun({ runId: 'run', upstreamIssue: 'issue', contributor: 'contributor' }, TIME),
      ReasonCode.UserCancelled,
      TIME
    );
    expect(controlRefusal(run, 'cancel')).toBe('terminal');
  });
});
