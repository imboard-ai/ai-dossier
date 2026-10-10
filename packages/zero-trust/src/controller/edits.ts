/** Trusted contributor commands. Repository/model input has no route to these APIs. */
import fs from 'node:fs';
import path from 'node:path';
import {
  exportSource,
  type SourceManifest,
  sha256,
  validateManifest,
  validateSourcePath,
} from '../canonical/export';
import { createCandidate, reconstructCandidate } from '../canonical/reconstruct';
import { TrustedGit } from '../canonical/trusted-git';
import { Journal } from '../journal';
import { assertModelKeyEnv, readModelKey } from '../model/transport';
import { assertSecretFree } from '../redaction';
import { isRecord, type RunRecord, sameRunRecord } from '../state';
import { strictUtf8 } from '../strict-utf8';
import { requireAuthorApproval } from './author-approval';
import { type RunConfig, runConfigInput, validateRunConfig } from './config';
import { readControlRequests } from './control';
import type { RunStore } from './run-store';
import {
  type Candidate,
  candidateMessage,
  implementationPhaseKey,
  reviewDiff,
  StepArtifacts,
} from './steps';
import { WorkspaceOverlay } from './workspace-overlay';

export class UserEditError extends Error {
  constructor(
    readonly code:
      | 'invalid_patch'
      | 'edit_not_paused'
      | 'edit_after_verification'
      | 'identity_change_requires_new_run'
      | 'model_key_missing'
      | 'model_unavailable'
      | 'invalid_user_edit'
  ) {
    super(`User change refused (${code})`);
  }
}
function paused(store: RunStore, run: RunRecord): void {
  if (!sameRunRecord(run, store.validateEvidence()) || run.state !== 'paused_user')
    throw new UserEditError('edit_not_paused');
  store.assertResumable();
  const controls = readControlRequests(store);
  if (controls.invalid || controls.pending.length) throw new UserEditError('invalid_user_edit');
}

/** Deliberately closed text-diff grammar; ambiguous/quoted paths are refused. Git checks hunks. */
export function validateUserPatch(bytes: Buffer): readonly string[] {
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024)
      throw new Error();
    const text = strictUtf8(bytes);
    assertSecretFree(text);
    if (!text.endsWith('\n') || text.includes('\0') || text.includes('\r')) throw new Error();
    const files = new Set<string>();
    let inHunk = false;
    let header = false;
    const admit = (file: string) => {
      validateSourcePath(file);
      files.add(file);
    };
    for (const line of text.split('\n').slice(0, -1)) {
      if (line.startsWith('diff --git ')) {
        const match = /^diff --git a\/([^\s"]+) b\/([^\s"]+)$/u.exec(line);
        if (!match) throw new Error();
        admit(match[1]);
        admit(match[2]);
        header = true;
        inHunk = false;
      } else if (!header) throw new Error();
      else if (line.startsWith('@@ ')) {
        if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line)) throw new Error();
        inHunk = true;
      } else if (inHunk) {
        if (!/^[ +-]/u.test(line) && line !== '\\ No newline at end of file') throw new Error();
      } else if (/^(?:---|\+\+\+) /u.test(line)) {
        const file = line.slice(4);
        if (file !== '/dev/null') {
          if (!/^[ab]\/[^\s"]+$/u.test(file)) throw new Error();
          admit(file.slice(2));
        }
      } else if (/^(?:old mode|new mode|new file mode|deleted file mode) /u.test(line)) {
        if (!/^(?:old mode|new mode|new file mode|deleted file mode) 100(?:644|755)$/u.test(line))
          throw new Error();
      } else if (/^rename (?:from|to) /u.test(line))
        admit(line.replace(/^rename (?:from|to) /u, ''));
      else if (
        !/^(?:index [a-f0-9]+\.\.[a-f0-9]+(?: 100(?:644|755))?|similarity index \d+%)$/u.test(line)
      )
        throw new Error();
    }
    if (!files.size) throw new Error();
    return Object.freeze([...files].sort());
  } catch {
    throw new UserEditError('invalid_patch');
  }
}

export interface SourceEdit {
  readonly policyDigest: string;
  readonly reviewDigest: string;
  readonly patchDigest: string;
  readonly files: readonly string[];
  readonly candidate: Candidate;
  readonly superseded: readonly string[];
}
export function latestSourceEdit(store: RunStore): SourceEdit | undefined {
  const change = store.userChanges.filter((c) => c.kind === 'source').at(-1);
  if (!change) return undefined;
  const value = change.value;
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'candidate,files,patchDigest,policyDigest,reviewDigest,superseded' ||
    typeof value.policyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.policyDigest) ||
    typeof value.reviewDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.reviewDigest) ||
    typeof value.patchDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.patchDigest) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    !Array.isArray(value.superseded) ||
    value.superseded.some((s) => typeof s !== 'string' || !/^[a-f0-9]{40}$/u.test(s)) ||
    !isRecord(value.candidate)
  )
    throw new UserEditError('invalid_user_edit');
  for (const file of value.files) {
    if (typeof file !== 'string') throw new UserEditError('invalid_user_edit');
    validateSourcePath(file);
  }
  const candidate = value.candidate as unknown as Candidate;
  validateManifest(candidate.manifest);
  return value as unknown as SourceEdit;
}
export function sourceEditCount(store: RunStore): number {
  return store.userChanges.filter((c) => c.kind === 'source').length;
}

/** All source bytes are held by the controller. No hooks, filters or worker repository. */
export function applyUserPatch(
  store: RunStore,
  run: RunRecord,
  patchBytes: Buffer,
  now: Date
): Candidate {
  paused(store, run);
  const origin = run.history.at(-1)?.from;
  if (origin === 'shipping') throw new UserEditError('edit_after_verification');
  if (!['implementing', 'verifying'].includes(origin ?? ''))
    throw new UserEditError('edit_not_paused');
  const bytes = Buffer.from(patchBytes);
  const files = validateUserPatch(bytes);
  const journal = new Journal(path.join(store.storeDirectory('control'), 'steps'));
  try {
    const artifacts = new StepArtifacts(journal, run.runId);
    const source = artifacts.require<{ manifest: SourceManifest; pack: string }>('source');
    const base = validateManifest(source.manifest);
    const pack = Buffer.from(source.pack, 'base64');
    const edit = latestSourceEdit(store);
    const previous =
      edit && artifacts.get<number>('applied_user_edit') !== sourceEditCount(store)
        ? edit.candidate
        : artifacts.get<Candidate>('candidate');
    const overlay = new WorkspaceOverlay(base);
    if (previous) {
      reconstructCandidate(previous.manifest, previous.record, previous.authority, pack);
      overlay.replaceSource(previous.manifest, previous.touched);
    }
    const attempt = artifacts.get<{ phaseKey: number }>('implementation_attempt');
    if (
      origin === 'implementing' &&
      (!previous || attempt?.phaseKey === implementationPhaseKey(run))
    ) {
      const continuation = artifacts.get<{
        baseDigest: string;
        writes: { path: string; content: string }[];
      }>('implementation_continuation');
      if (continuation) {
        if (
          continuation.baseDigest !== (previous?.manifest.digest ?? base.digest) ||
          !Array.isArray(continuation.writes)
        )
          throw new UserEditError('invalid_user_edit');
        for (const write of continuation.writes) overlay.write(write.path, write.content);
      }
    }
    const git = new TrustedGit();
    let manifest: SourceManifest;
    try {
      const workspace = path.join(git.directory, 'workspace');
      overlay.materialize(workspace);
      const argv = ['-C', workspace, `--work-tree=${workspace}`, '-c', 'core.bare=false', 'apply'];
      if (
        git.exec([...argv, '--check', '-'], { input: bytes }).status !== 0 ||
        git.exec([...argv, '-'], { input: bytes }).status !== 0
      )
        throw new UserEditError('invalid_patch');
      manifest = exportSource(workspace);
    } finally {
      git.close();
    }
    assertSecretFree(manifest);
    const touched = [...new Set([...overlay.touchedPaths(), ...files])].sort();
    const approval = store.config.authorApproval;
    if (!approval) throw new UserEditError('invalid_user_edit');
    const digest = sha256(bytes);
    const author =
      previous?.authority.author ??
      requireAuthorApproval(store.config, { login: approval.login, userId: approval.userId });
    const gate = artifacts.require<{
      baseSha: string;
      policyDigest: string;
      signoffRequired?: boolean;
    }>('gate');
    const produced = createCandidate(
      manifest,
      {
        baseSha: previous?.record.baseSha ?? artifacts.require<{ baseSha: string }>('gate').baseSha,
        author,
        committerTimestamp: now.toISOString().replace(/\.\d{3}Z$/u, 'Z'),
        message: candidateMessage(
          store.config.upstream.issue,
          artifacts.get<number>('attempt') ?? 1,
          author,
          gate.signoffRequired === true,
          { count: sourceEditCount(store) + 1, digest }
        ),
      },
      pack
    );
    const candidate: Candidate = {
      record: produced.record,
      authority: produced.authority,
      manifest,
      touched,
      meta: previous?.meta ?? {
        title: 'Contributor candidate',
        cause: 'Contributor edits',
        scope: 'User-supplied patch',
        limitations: [],
      },
    };
    const superseded: string[] = [];
    const directory = path.join(store.storeDirectory('artifacts'), 'verification');
    try {
      for (const name of fs.readdirSync(directory))
        if (/^[a-f0-9]{40}\.json$/u.test(name)) superseded.push(name.slice(0, -5));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A crash after this conservative fence never admits old evidence. Records remain immutable.
    for (const sha of superseded)
      store.replaceArtifact(`superseded-${sha}`, Buffer.from(run.runId));
    const diff = reviewDiff(base, manifest);
    store.replaceArtifact('candidate.diff', diff);
    paused(store, run);
    store.recordUserChange(
      'source',
      {
        patchDigest: digest,
        files,
        candidate,
        superseded,
        policyDigest: artifacts.require<{ policyDigest: string }>('gate').policyDigest,
        reviewDigest: sha256(diff),
      },
      now.toISOString()
    );
    return candidate;
  } finally {
    journal.close();
  }
}

export function changeModelProfile(
  store: RunStore,
  run: RunRecord,
  newProfile: RunConfig['modelProfile'],
  now = new Date()
): void {
  paused(store, run);
  const config = validateRunConfig({
    ...runConfigInput(store.config),
    modelProfile: structuredClone(newProfile),
  });
  for (const phase of Object.values(config.modelProfile.phases)) {
    if (phase.adapter !== 'openai-compatible') throw new UserEditError('model_unavailable');
    try {
      assertModelKeyEnv(phase.apiKeyEnv);
      readModelKey(phase.apiKeyEnv);
    } catch {
      throw new UserEditError('model_key_missing');
    }
  }
  store.recordUserChange('model', config.modelProfile, now.toISOString());
}
export function changeCheckpoints(
  store: RunStore,
  run: RunRecord,
  checkpoints: RunConfig['checkpoints'],
  now = new Date()
): void {
  paused(store, run);
  const config = validateRunConfig({
    ...runConfigInput(store.config),
    checkpoints: structuredClone(checkpoints),
  });
  store.recordUserChange('checkpoints', config.checkpoints, now.toISOString());
}
export function changeIdentity(_store: RunStore, _run: RunRecord, _identity: unknown): never {
  throw new UserEditError('identity_change_requires_new_run');
}
