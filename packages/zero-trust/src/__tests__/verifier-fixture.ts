/** Shared fixture for the independent verifier tests (#1102): the npm ecosystem fixture
 * as a local base commit pack and canonical candidates, a `FakeVmAdapter` with the
 * production broker request validation and scripted boundary reports, and a run in
 * `verifying`. No network and no VM. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSource, type SourceManifest } from '../canonical/export';
import { type CommitInputs, createCandidate } from '../canonical/reconstruct';
import type { RunLifecycle } from '../controller/evidence-runner';
import type { VerifierDeps, VerifyInput } from '../controller/verifier';
import {
  detectEcosystem,
  type SupportedDetection,
  sourceFilesFromManifest,
} from '../ecosystem/detect';
import { type ProfileRecord, recordProfileSelection, selectProfile } from '../ecosystem/profiles';
import { createRun, ReasonCode as R, type RunRecord, transitionRun } from '../state';
import type { ExecRequest, VmHandle } from '../vm/adapter';
import { assertWorkspacePath, validateExecArgv, validateRequest } from '../vm/broker';
import { ATTACK_CATEGORIES } from '../vm/evidence';
import { WORKER_RELAY } from '../vm/qemu-args';
import { type FakeExecScript, type FakeVm, FakeVmAdapter, junit } from './fake-vm';

export const RUN_ID = 'run-1102';
export const TIME = '2026-10-08T00:00:00.000Z';
export const REGRESSION_TEST = 'test/regression.test.js';
const RELAY = `http://${WORKER_RELAY.host}:${WORKER_RELAY.port}/`;
export const ENDPOINTS = { npmRegistry: RELAY, pypiIndex: `${RELAY}index/` };
const NPM = path.join(__dirname, '..', '..', 'fixtures', 'ecosystem', 'npm');

const temps: string[] = [];
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
export function removeTemps(): void {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

function fixtureDir(patches: readonly string[]): string {
  const dir = tempDir('zt-verifier-src-');
  fs.cpSync(path.join(NPM, 'base'), dir, { recursive: true });
  for (const patch of patches) {
    const applied = spawnSync('git', ['apply', path.join(NPM, patch)], { cwd: dir });
    if (applied.status !== 0) throw new Error(`git apply ${patch}: ${applied.stderr}`);
  }
  return dir;
}

export const BASE: SourceManifest = exportSource(fixtureDir([]));
export const CANDIDATE: SourceManifest = exportSource(
  fixtureDir(['regression.patch', 'fix.patch'])
);

/** The fixture base committed once in a throwaway repository, as a raw pack. */
function basePack(): { baseSha: string; pack: Buffer } {
  const dir = fixtureDir([]);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '1791194400 +0000',
    GIT_COMMITTER_DATE: '1791194400 +0000',
  };
  const git = (args: string[], input?: string) => {
    const result = spawnSync('git', args, { cwd: dir, env, input });
    if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
    return result.stdout;
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=Base', '-c', 'user.email=base@example.org', 'commit', '-q', '-m', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']).toString().trim();
  return { baseSha, pack: git(['pack-objects', '--stdout', '--revs'], `${baseSha}\n`) };
}
export const BASE_COMMIT = basePack();

export function approved(attempt = 1): CommitInputs {
  return {
    baseSha: BASE_COMMIT.baseSha,
    author: {
      login: 'contributor',
      name: 'Approved Contributor',
      email: 'contributor@example.org',
      timestamp: '2026-10-08T00:00:00Z',
    },
    committerTimestamp: '2026-10-08T00:01:00Z',
    message: `fix: duration rounding (attempt ${attempt})\n`,
  };
}

/** A canonical candidate and the verifier input for it. */
export function candidateInput(attempt = 1, manifest: SourceManifest = CANDIDATE): VerifyInput {
  const candidate = createCandidate(manifest, approved(attempt), BASE_COMMIT.pack);
  return {
    candidateSha: candidate.record.candidateSha,
    manifest,
    record: candidate.record,
    authority: candidate.authority,
    basePack: BASE_COMMIT.pack,
    regressionTargets: [REGRESSION_TEST],
    regressionBase: 'failed',
  };
}

function profileRecord(): ProfileRecord {
  const selection = selectProfile(
    detectEcosystem(sourceFilesFromManifest(BASE)) as SupportedDetection
  );
  if (!selection.ok) throw new Error('no profile');
  return recordProfileSelection(tempDir('zt-verifier-profile-'), RUN_ID, selection);
}
export const PROFILE = profileRecord();

const fixed = (vm: FakeVm) =>
  vm.files.get('src/duration.js')?.bytes.toString('utf8').includes('millis / 1000') ?? false;

/** The fixture's behaviour from what was uploaded: the regression test fails until the
 * source carries the fix; everything else passes. */
export function fixtureScript(request: ExecRequest, vm: FakeVm): FakeExecScript {
  if (!request.report) return { stdout: `ran ${request.argv.join(' ')}\n` };
  const failing = vm.files.has(REGRESSION_TEST) && !fixed(vm);
  return { exitCode: failing ? 1 : 0, report: junit(1, failing), stdout: 'tests\n' };
}

function boundaryReport(probe: string, phase: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      probe,
      phase,
      records: ATTACK_CATEGORIES.map((category) => ({
        category,
        attempt: 'attempt',
        outcome: 'denied',
      })),
    })
  );
}

/** `FakeVmAdapter` with the production broker request validation (so the boundary
 * session's host-side abuse checks are refused as in production) and denied-everything
 * hostile-fixture reports. `acceptAbuse` disables the validation: the boundary fails. */
export class VerifierFakeVm extends FakeVmAdapter {
  acceptAbuse = false;
  /** Report files the boundary probe reads back; `null` makes them missing. */
  boundaryReports: ((probe: string, phase: string) => Buffer) | null = boundaryReport;

  override async putFile(vm: VmHandle, name: string, bytes: Buffer, executable = false) {
    if (!this.acceptAbuse)
      validateRequest({ op: 'put', path: name, data: bytes.toString('base64'), executable });
    return super.putFile(vm, name, bytes, executable);
  }

  override async getFile(vm: VmHandle, name: string) {
    if (!this.acceptAbuse) assertWorkspacePath(name);
    const match = /\/results\/(node|python)-(.*)\.json$/u.exec(name);
    if (match && this.boundaryReports)
      return this.boundaryReports(match[1] as string, match[2] as string);
    return super.getFile(vm, name);
  }

  override async exec(vm: VmHandle, request: ExecRequest) {
    if (!this.acceptAbuse) validateExecArgv(request.profile, request.argv);
    return super.exec(vm, request);
  }

  /** The bytes uploaded to `vmId` before its provisioning ended (the source, not fixtures). */
  sourceUploads(vmId: string): Map<string, Buffer> {
    const end = this.calls.findIndex((c) => c.op === 'endProvisioning' && c.vmId === vmId);
    const uploads = new Map<string, Buffer>();
    const vm = this.vms.get(vmId) as FakeVm;
    for (const call of this.calls.slice(0, end))
      if (call.op === 'putFile' && call.vmId === vmId)
        uploads.set(call.path as string, vm.files.get(call.path as string)?.bytes as Buffer);
    return uploads;
  }
}

export function verifyingRun(): RunRecord {
  return [R.GatePassed, R.PlanApproved, R.CandidateReady].reduce(
    (run, reason) => transitionRun(run, reason, TIME),
    createRun(
      { runId: RUN_ID, upstreamIssue: 'https://github.com/o/r/issues/1', contributor: 'c' },
      TIME
    )
  );
}

export interface Harness {
  readonly adapter: VerifierFakeVm;
  readonly observed: RunRecord[];
  readonly artifactsDir: string;
  deps(run?: RunRecord): VerifierDeps;
}

export function harness(adapter = new VerifierFakeVm(fixtureScript)): Harness {
  const observed: RunRecord[] = [];
  const artifactsDir = path.join(tempDir('zt-verifier-store-'), 'artifacts');
  return {
    adapter,
    observed,
    artifactsDir,
    deps(run = verifyingRun()): VerifierDeps {
      const lifecycle: RunLifecycle = {
        run,
        now: () => new Date(TIME),
        observeRun: (next) => observed.push(next),
        sleep: async () => {},
      };
      return {
        adapter,
        runId: RUN_ID,
        limits: { vcpus: 1, memoryMiB: 512, diskGiB: 1, commandTimeoutMs: 1000 },
        profileRecord: PROFILE,
        proxyTarget: { host: '10.0.0.2', port: 4873 },
        endpoints: ENDPOINTS,
        artifactsDir,
        lifecycle,
        boundaryTimeoutMs: 1000,
      };
    },
  };
}
