import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertDirectoryAncestors,
  privateDir,
  readPrivate,
  replacePrivate,
  syncDirectory,
} from '../durable-fs';
import { Journal, parseJournalEvents } from '../journal';
import { lockDescriptor, StoreLockedError } from '../lock';
import { isRecoveryEvent, isTailRecovery } from '../recovery';
import { assertSecretFree } from '../redaction';
import {
  createRun,
  isRecord,
  isRunContinuation,
  type RunRecord,
  restoreRun,
  sameRunRecord,
} from '../state';
import { parseStrictUtf8Json, strictUtf8 } from '../strict-utf8';
import { type RunConfig, RunConfigError, runConfigInput, validateRunConfig } from './config';
import { contributionIdOf } from './ids';

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

/** Pin every ancestor before descending: later writes cannot follow a replacement. */
function pinDirectory(directory: string): number {
  let fd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (const component of path.resolve(directory).split('/').filter(Boolean)) {
      const next = fs.openSync(
        `/proc/self/fd/${fd}/${component}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      fs.closeSync(fd);
      fd = next;
    }
    const stat = fs.fstatSync(fd);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) fail('invalid_store');
    return fd;
  } catch {
    fs.closeSync(fd);
    fail('invalid_store');
  }
}

function replayControl(events: unknown[]): {
  run: RunRecord;
  confirmed?: RunRecord;
  upstreamId?: number;
} {
  let run: RunRecord | undefined;
  let confirmed: RunRecord | undefined;
  let upstreamId: number | undefined;
  for (const event of events) {
    assertSecretFree(event);
    if (isTailRecovery(event)) continue;
    if (!isRecord(event) || event.v !== 1) fail('invalid_store');
    if (event.type === 'run') {
      const next = restoreRun(event.run);
      if (
        run
          ? !confirmed || !sameRunRecord(run, confirmed) || !isRunContinuation(run, next)
          : next.history.length !== 0
      )
        fail('run_diverged');
      run = next;
    } else if (
      event.type === 'snapshot' &&
      run &&
      event.sha256 === hash(Buffer.from(JSON.stringify(run)))
    ) {
      confirmed = run;
    } else if (
      event.type === 'upstream' &&
      upstreamId === undefined &&
      Number.isSafeInteger(event.repositoryId) &&
      Number(event.repositoryId) > 0
    ) {
      upstreamId = event.repositoryId as number;
    } else fail('invalid_store');
  }
  if (!run) fail('invalid_store');
  return { run, confirmed, upstreamId };
}
function confirmSnapshot(journal: Journal, directory: string, run: RunRecord): void {
  const bytes = Buffer.from(JSON.stringify(run));
  replacePrivate(path.join(directory, 'run.json'), bytes);
  journal.append({ v: 1, type: 'snapshot', sha256: hash(bytes) });
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
    lockDescriptor(fd, 0);
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
    private readonly directoryFd: number,
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
  /** Read current durable evidence under the lifetime fence, without repair or writes.
   * Cached state is an equality constraint, never independent reporting evidence. */
  validateEvidence(): RunRecord {
    this.check();
    const pinned = `/proc/self/fd/${this.directoryFd}`;
    const events = this.withStoreDirectory('control', (dir) =>
      parseJournalEvents(readPrivate(path.join(dir, 'events.jsonl')))
    );
    if (events.some(isRecoveryEvent)) fail('invalid_store');
    const evidence = replayControl(events);
    const snapshot = restoreRun(parseStrictUtf8Json(readPrivate(path.join(pinned, 'run.json'))));
    assertSecretFree(snapshot);
    if (
      !evidence.confirmed ||
      !sameRunRecord(evidence.confirmed, evidence.run) ||
      !sameRunRecord(evidence.run, snapshot) ||
      !sameRunRecord(snapshot, this.current) ||
      evidence.upstreamId !== this.upstreamId
    )
      fail('run_diverged');
    return snapshot;
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
  /** Synchronous local operation under this store's held fence and a pinned child directory.
   * The callback must not retain the descriptor path beyond its lifetime. */
  withStoreDirectory<T>(
    name: (typeof RUN_STORE_DIRECTORIES)[number],
    work: (directory: string) => T & (T extends PromiseLike<unknown> ? never : unknown)
  ): T {
    this.check();
    if (!RUN_STORE_DIRECTORIES.includes(name)) fail('invalid_store');
    const fd = fs.openSync(
      `/proc/self/fd/${this.directoryFd}/${name}`,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      const stat = fs.fstatSync(fd);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) fail('invalid_store');
      const value = work(`/proc/self/fd/${fd}`);
      if (
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        'then' in value &&
        typeof value.then === 'function'
      )
        fail('invalid_store');
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }
  static create(root: string, input: RunConfig, now: Date | string): RunStore {
    const config = validateRunConfig(runConfigInput(input));
    if (config.resumeRunId !== undefined) fail('invalid_run_id');
    const runTimestamp = now instanceof Date ? now.toISOString() : now;
    const contributionId = `ztc-${randomBytes(8).toString('hex')}`;
    const directory = path.resolve(root, contributionId);
    let guard: number | undefined;
    let directoryFd: number | undefined;
    let journal: Journal | undefined;
    try {
      assertDirectoryAncestors(root);
      privateDir(root);
      fs.mkdirSync(directory, { mode: 0o700 });
      privateDir(directory);
      syncDirectory(root);
      directoryFd = pinDirectory(directory);
      const pinned = `/proc/self/fd/${directoryFd}`;
      guard = acquire(pinned);
      for (const name of RUN_STORE_DIRECTORIES) privateDir(path.join(directory, name));
      const run = createRun(
        {
          runId: `${contributionId}-run-1`,
          upstreamIssue: config.issueUrl,
          contributor: config.contributor,
        },
        runTimestamp
      );
      const bytes = Buffer.from(JSON.stringify(runConfigInput(config)));
      replacePrivate(path.join(pinned, 'config.json'), bytes);
      replacePrivate(path.join(pinned, 'config.sha256'), Buffer.from(hash(bytes)));
      journal = new Journal(path.join(directory, 'control'));
      journal.append({ v: 1, type: 'run', run });
      confirmSnapshot(journal, pinned, run);
      syncDirectory(pinned);
      return new RunStore(directory, contributionId, guard, directoryFd, journal, config, run);
    } catch (error) {
      journal?.close();
      if (guard !== undefined) fs.closeSync(guard);
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
      if (
        error instanceof RunStoreError ||
        error instanceof StoreLockedError ||
        error instanceof RunConfigError
      )
        throw error;
      fail('invalid_store');
    }
  }
  static open(root: string, runId: string): RunStore {
    const contributionId = contributionIdOf(runId);
    if (!contributionId) fail('invalid_run_id');
    const directory = path.resolve(root, contributionId);
    let directoryFd: number | undefined;
    let guard: number | undefined;
    let journal: Journal | undefined;
    try {
      assertDirectoryAncestors(directory);
      // Opening never creates a missing store or missing evidence.
      for (const dir of [
        directory,
        ...RUN_STORE_DIRECTORIES.map((name) => path.join(directory, name)),
      ]) {
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
          fail('invalid_store');
      }
      directoryFd = pinDirectory(directory);
      const pinned = `/proc/self/fd/${directoryFd}`;
      guard = acquire(pinned);
      const bytes = readPrivate(path.join(pinned, 'config.json'));
      if (hash(bytes) !== strictUtf8(readPrivate(path.join(pinned, 'config.sha256'))))
        fail('invalid_store');
      const config = validateRunConfig(parseStrictUtf8Json(bytes));
      const raw = parseStrictUtf8Json(readPrivate(path.join(pinned, 'run.json')));
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
      const evidence = replayControl(journal.read());
      if (!sameRunRecord(evidence.run, run)) {
        if (
          !evidence.confirmed ||
          sameRunRecord(evidence.run, evidence.confirmed) ||
          !sameRunRecord(evidence.confirmed, run)
        )
          fail('run_diverged');
      }
      if (!evidence.confirmed || !sameRunRecord(evidence.run, evidence.confirmed))
        confirmSnapshot(journal, pinned, evidence.run);
      const store = new RunStore(
        directory,
        contributionId,
        guard,
        directoryFd,
        journal,
        config,
        evidence.run
      );
      store.upstreamId = evidence.upstreamId;
      return store;
    } catch (error) {
      journal?.close();
      if (guard !== undefined) fs.closeSync(guard);
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
      if (
        error instanceof RunStoreError ||
        error instanceof StoreLockedError ||
        error instanceof RunConfigError
      )
        throw error;
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
      confirmSnapshot(this.journal, `/proc/self/fd/${this.directoryFd}`, run);
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
    if (!this.poisoned) {
      fs.closeSync(this.guard);
      fs.closeSync(this.directoryFd);
    }
  }
}
