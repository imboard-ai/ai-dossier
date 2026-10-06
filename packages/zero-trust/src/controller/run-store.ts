import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { privateDir, readPrivate, replacePrivate, syncDirectory } from '../durable-fs';
import { Journal } from '../journal';
import { StoreLockedError } from '../lock';
import { isTailRecovery } from '../recovery';
import {
  createRun,
  isRecord,
  isRunContinuation,
  type RunRecord,
  restoreRun,
  sameRunRecord,
} from '../state';
import { assertSecretFree, type RunConfig, runConfigInput, validateRunConfig } from './config';

export const RUN_STORE_DIRECTORIES = Object.freeze([
  'intents',
  'handoff',
  'track',
  'tokens',
  'push-ledger',
  'nonces',
  'budget',
  'vm',
  'profile',
  'artifacts',
  'bodies',
  'control',
] as const);
export type RunStoreErrorCode =
  | 'invalid_store'
  | 'invalid_run_id'
  | 'run_diverged'
  | 'resume_identity_mismatch'
  | 'persistence_uncertain'
  | 'store_closed';
export class RunStoreError extends Error {
  constructor(readonly code: RunStoreErrorCode) {
    super(`Run store refused (${code})`);
    this.name = 'RunStoreError';
  }
}
function fail(code: RunStoreErrorCode): never {
  throw new RunStoreError(code);
}
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function noSymlinkAncestors(directory: string): void {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_store');
    }
    if (current === path.dirname(current)) break;
  }
}
/** Permanent flock inode; Linux kernel releases it on controller death, never age. */
function acquire(directory: string): number {
  if (process.platform !== 'linux') throw new StoreLockedError();
  const file = path.join(directory, '.controller.guard');
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_CREAT |
        fs.constants.O_RDWR |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new StoreLockedError();
    const result = spawnSync('/usr/bin/flock', ['-x', '-n', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      timeout: 5000,
    });
    if (result.error || result.status !== 0) throw new StoreLockedError();
    const named = fs.lstatSync(file);
    if (named.dev !== stat.dev || named.ino !== stat.ino) throw new StoreLockedError();
    fs.fsyncSync(fd);
    syncDirectory(directory);
    return fd;
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw new StoreLockedError();
  }
}

/** Controller-owned local storage, outside every worker filesystem. */
export class RunStore {
  private closed = false;
  private poisoned = false;
  private upstreamId: number | undefined;
  private constructor(
    readonly directory: string,
    readonly contributionId: string,
    private readonly guard: number,
    private readonly journal: Journal,
    private readonly storedConfig: RunConfig,
    private current: RunRecord
  ) {}
  get runId(): string {
    return this.current.runId;
  }
  get run(): RunRecord {
    this.check();
    return this.current;
  }
  get config(): RunConfig {
    this.check();
    return structuredClone(this.storedConfig);
  }
  get upstreamRepositoryId(): number | undefined {
    this.check();
    return this.upstreamId;
  }
  storeDirectory(name: (typeof RUN_STORE_DIRECTORIES)[number]): string {
    this.check();
    if (!RUN_STORE_DIRECTORIES.includes(name)) fail('invalid_store');
    return path.join(this.directory, name);
  }
  budgetSessionId(n: number): string {
    this.check();
    if (!Number.isSafeInteger(n) || n <= 0) fail('invalid_store');
    return `${this.runId}-s${n}`;
  }
  static create(root: string, input: RunConfig, now: Date | string): RunStore {
    const config = validateRunConfig(runConfigInput(input));
    if (config.resumeRunId !== undefined) fail('invalid_run_id');
    noSymlinkAncestors(root);
    privateDir(root);
    const contributionId = `ztc-${randomBytes(8).toString('hex')}`;
    const directory = path.join(root, contributionId);
    // Exclusive creation prevents accidental reuse, even in a random-ID collision.
    fs.mkdirSync(directory, { mode: 0o700 });
    privateDir(directory);
    syncDirectory(root);
    const guard = acquire(directory);
    let journal: Journal | undefined;
    try {
      for (const name of RUN_STORE_DIRECTORIES) privateDir(path.join(directory, name));
      const run = createRun(
        {
          runId: `${contributionId}-run-1`,
          upstreamIssue: config.issueUrl,
          contributor: config.contributor,
        },
        now instanceof Date ? now.toISOString() : now
      );
      const bytes = Buffer.from(JSON.stringify(runConfigInput(config)));
      replacePrivate(path.join(directory, 'config.json'), bytes);
      replacePrivate(path.join(directory, 'config.sha256'), Buffer.from(hash(bytes)));
      journal = new Journal(path.join(directory, 'control'));
      journal.append({ v: 1, type: 'run', run });
      replacePrivate(path.join(directory, 'run.json'), Buffer.from(JSON.stringify(run)));
      syncDirectory(directory);
      return new RunStore(directory, contributionId, guard, journal, config, run);
    } catch (error) {
      journal?.close();
      fs.closeSync(guard);
      throw error;
    }
  }
  static open(root: string, runId: string): RunStore {
    if (!/^ztc-[a-f0-9]{16}-run-1$/u.test(runId)) fail('invalid_run_id');
    const contributionId = runId.slice(0, -6);
    const directory = path.resolve(root, contributionId);
    noSymlinkAncestors(directory);
    // Opening never creates a missing store or missing evidence.
    for (const dir of [
      directory,
      ...RUN_STORE_DIRECTORIES.map((name) => path.join(directory, name)),
    ]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
        fail('invalid_store');
    }
    const guard = acquire(directory);
    let journal: Journal | undefined;
    try {
      const bytes = readPrivate(path.join(directory, 'config.json'));
      if (hash(bytes) !== readPrivate(path.join(directory, 'config.sha256')).toString('utf8'))
        fail('invalid_store');
      const config = validateRunConfig(JSON.parse(bytes.toString('utf8')));
      const raw: unknown = JSON.parse(
        readPrivate(path.join(directory, 'run.json')).toString('utf8')
      );
      assertSecretFree(raw);
      const run = restoreRun(raw);
      if (
        run.runId !== runId ||
        run.contributor !== config.contributor ||
        run.upstreamIssue !== config.issueUrl
      )
        fail('invalid_store');
      readPrivate(path.join(directory, 'control', 'events.jsonl'));
      journal = new Journal(path.join(directory, 'control'));
      let previous: RunRecord | undefined;
      let upstreamId: number | undefined;
      for (const event of journal.read()) {
        assertSecretFree(event);
        if (isTailRecovery(event)) continue;
        if (!isRecord(event) || event.v !== 1) fail('invalid_store');
        if (event.type === 'run') {
          const next = restoreRun(event.run);
          if (previous ? !isRunContinuation(previous, next) : next.history.length !== 0)
            fail('run_diverged');
          previous = next;
        } else if (
          event.type === 'upstream' &&
          upstreamId === undefined &&
          Number.isSafeInteger(event.repositoryId) &&
          Number(event.repositoryId) > 0
        ) {
          upstreamId = event.repositoryId as number;
        } else fail('invalid_store');
      }
      if (!previous || !sameRunRecord(previous, run)) fail('run_diverged');
      const store = new RunStore(directory, contributionId, guard, journal, config, run);
      store.upstreamId = upstreamId;
      return store;
    } catch (error) {
      journal?.close();
      fs.closeSync(guard);
      if (error instanceof RunStoreError) throw error;
      fail('invalid_store');
    }
  }
  private check(): void {
    if (this.closed) fail('store_closed');
    if (this.poisoned) fail('persistence_uncertain');
  }
  persistRun(input: RunRecord): void {
    this.check();
    input = structuredClone(input);
    assertSecretFree(input);
    const run = restoreRun(input);
    if (!isRunContinuation(this.current, run)) fail('run_diverged');
    if (sameRunRecord(this.current, run)) return;
    this.write(() => {
      this.journal.append({ v: 1, type: 'run', run });
      replacePrivate(path.join(this.directory, 'run.json'), Buffer.from(JSON.stringify(run)));
    });
    this.current = run;
  }
  recordUpstreamRepositoryId(id: number): void {
    this.check();
    if (!Number.isSafeInteger(id) || id <= 0) fail('invalid_store');
    if (this.upstreamId !== undefined) {
      if (this.upstreamId !== id) fail('resume_identity_mismatch');
      return;
    }
    this.write(() => this.journal.append({ v: 1, type: 'upstream', repositoryId: id }));
    this.upstreamId = id;
  }
  /** Compare identity before validating a changed provider; never rebind a target. */
  assertResumeMatches(
    config: Pick<RunConfig, 'contributor' | 'issueUrl'> & {
      executionProfile: { provider: string };
      upstreamRepositoryId?: number;
    }
  ): void {
    this.check();
    config = structuredClone(config);
    assertSecretFree(config);
    if (
      config.contributor !== this.storedConfig.contributor ||
      config.issueUrl !== this.storedConfig.issueUrl ||
      config.executionProfile.provider !== this.storedConfig.executionProfile.provider ||
      (this.upstreamId !== undefined && config.upstreamRepositoryId !== this.upstreamId)
    )
      fail('resume_identity_mismatch');
  }
  private write(work: () => void): void {
    try {
      work();
    } catch {
      this.poisoned = true;
      fail('persistence_uncertain');
    }
  }
  close(): void {
    if (this.closed) return;
    // Uncertain persistence retains the kernel fence until process termination.
    this.closed = true;
    this.journal.close();
    if (!this.poisoned) fs.closeSync(this.guard);
  }
}
