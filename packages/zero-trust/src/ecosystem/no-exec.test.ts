import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRun, ReasonCode, transitionRun } from '../state';
import { applyProvisioning, applyVerification, classifyOutcome } from './classify';
import { buildCommandPlan } from './commands';
import { detectEcosystem } from './detect';
import { loadProfileRecord, recordProfileSelection, selectProfile } from './profiles';
import {
  buildLockIndex,
  checkArtifact,
  proxpiEnvironment,
  renderSquidConfig,
  renderVerdaccioConfig,
} from './proxy';

// vi.mock is hoisted above the imports. Any process launch from the product path fails this file: every child_process entry
// point records the attempt and throws.
const launches: string[] = [];
vi.mock('node:child_process', () => {
  const trap =
    (name: string) =>
    (..._args: unknown[]) => {
      launches.push(name);
      throw new Error(`process launch attempted: ${name}`);
    };
  const api = Object.fromEntries(
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map((n) => [
      n,
      trap(n),
    ])
  );
  return { ...api, default: api };
});

const FIXTURES = path.join(__dirname, '../../fixtures/ecosystem');
const LOCKS = { npm: 'package-lock.json', pip: 'requirements.txt', uv: 'uv.lock' } as const;

describe('the ecosystem product path launches no process (ac6)', () => {
  it('the trap is armed (positive control)', () => {
    expect(() => childProcess.spawnSync('true')).toThrow('process launch attempted');
    expect(launches.splice(0)).toEqual(['spawnSync']);
  });

  it.each([
    'npm',
    'pip',
    'uv',
  ] as const)('%s fixture: detect → select → record → plan → classify → proxy', (name) => {
    const dir = path.join(FIXTURES, name, 'base');
    const files = new Map(
      fs
        .readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isFile())
        .map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')])
    );
    const detection = detectEcosystem(files);
    if (!detection.supported) throw new Error(detection.reason);
    const selection = selectProfile(detection);
    if (!selection.ok) throw new Error(selection.reason);
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-noexec-'));
    try {
      recordProfileSelection(store, 'run-1', selection);
      loadProfileRecord(store, 'run-1');
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
    buildCommandPlan(detection.manager, {
      npmRegistry: 'http://npm-proxy:4873/',
      pypiIndex: 'http://pypi-proxy:5000/index/',
    });
    const t = '2026-10-06T00:00:00.000Z';
    let run = createRun(
      { runId: 'r', upstreamIssue: 'https://github.com/o/r/issues/1', contributor: 'a' },
      t
    );
    for (const r of [ReasonCode.GatePassed, ReasonCode.PlanApproved, ReasonCode.CandidateReady])
      run = transitionRun(run, r, t);
    applyVerification(applyProvisioning(run, 'passed', t), classifyOutcome({ kind: 'timeout' }), t);
    const index = buildLockIndex(detection.manager, files.get(LOCKS[detection.manager]) as string);
    checkArtifact(index, [...index.artifacts.keys()][0], Buffer.from('x'));
    const d = {
      squidHost: 'egress-proxy',
      squidPort: 3128,
      squidCaCertPath: '/etc/squid/ca.pem',
      squidCaKeyPath: '/etc/squid/ca.key',
      verdaccioPort: 4873,
      verdaccioStorage: '/verdaccio/storage',
      proxpiPort: 5000,
      proxpiCacheDir: '/var/cache/proxpi',
      mirrorCidrs: ['10.20.0.0/29'],
    };
    renderSquidConfig(d);
    renderVerdaccioConfig(d);
    proxpiEnvironment(d);
    expect(launches).toEqual([]);
  });
});
