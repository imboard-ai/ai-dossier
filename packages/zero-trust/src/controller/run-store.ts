import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
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
  ReasonCode,
  type RunRecord,
  restoreRun,
  sameRunRecord,
  transitionRun,
} from '../state';
import { parseStrictUtf8Json, strictUtf8 } from '../strict-utf8';
import {
  type CheckpointBindings,
  type CheckpointPoint,
  type CheckpointRecord,
  checkpointBindings,
  checkpointPhase,
  checkpointResumeReason,
  restoreCheckpoint,
  sameCheckpointBindings,
} from './checkpoint-record';
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

function validateCheckpoint(
  record: CheckpointRecord,
  run: RunRecord,
  config: RunConfig,
  records: Map<CheckpointPoint, CheckpointRecord>,
  bindings: Map<CheckpointPoint, CheckpointBindings>,
  next?: RunRecord
): void {
  if (
    record.runId !== run.runId ||
    !config.checkpoints.includes(record.point) ||
    (record.status !== 'rejected' &&
      !sameCheckpointBindings(record.bindings, bindings.get(record.point) ?? record.bindings))
  )
    fail('invalid_store');
  const previous = records.get(record.point);
  if (!next) {
    if (
      previous ||
      !bindings.has(record.point) ||
      record.status !== 'open' ||
      record.interruptedState !== run.state ||
      record.interruptedHistoryLength !== run.history.length ||
      Date.parse(record.createdAt) < Date.parse(run.updatedAt)
    )
      fail('invalid_store');
  } else {
    if (
      !previous ||
      previous.status !== 'open' ||
      JSON.stringify(
        restoreCheckpoint({
          ...record,
          status: 'open',
          resolvedAt: undefined,
          rejectionReason: undefined,
        })
      ) !== JSON.stringify(previous) ||
      run.state !== 'paused_user' ||
      run.history.length !== record.interruptedHistoryLength + 1 ||
      run.history.at(-1)?.from !== record.interruptedState ||
      record.resolvedAt === undefined ||
      record.status === 'open'
    )
      fail('invalid_store');
    const reason =
      record.status === 'rejected'
        ? ReasonCode.UserCancelled
        : checkpointResumeReason(record.point);
    if (!sameRunRecord(transitionRun(run, reason, record.resolvedAt), next)) fail('run_diverged');
  }
}
/** An open checkpoint owns its boundary even before the pause snapshot lands.
 * Ordinary persistence may pause or fail/cancel, but may never continue work. */
function validateCheckpointContinuation(
  run: RunRecord,
  next: RunRecord,
  records: Map<CheckpointPoint, CheckpointRecord>
): void {
  const exits = new Set([
    ReasonCode.PolicyBlocked,
    ReasonCode.UnsupportedEnvironment,
    ReasonCode.ExecutionFailed,
    ReasonCode.UserCancelled,
    ReasonCode.CleanupFailed,
  ]);
  for (const record of records.values()) {
    if (record.status !== 'open') continue;
    for (let i = run.history.length; i < next.history.length; i++) {
      const event = next.history[i];
      if (
        i >= record.interruptedHistoryLength &&
        (event.from === record.interruptedState || event.from === 'paused_user') &&
        event.reasonCode !== ReasonCode.UserPaused &&
        !exits.has(event.reasonCode)
      )
        fail('invalid_store');
    }
  }
}
function replayControl(
  events: unknown[],
  config: RunConfig
): {
  run: RunRecord;
  confirmed?: RunRecord;
  upstreamId?: number;
  checkpoints: Map<CheckpointPoint, CheckpointRecord>;
  bindings: Map<CheckpointPoint, CheckpointBindings>;
} {
  let run: RunRecord | undefined;
  let confirmed: RunRecord | undefined;
  let upstreamId: number | undefined;
  const checkpoints = new Map<CheckpointPoint, CheckpointRecord>();
  const bindings = new Map<CheckpointPoint, CheckpointBindings>();
  for (const event of events) {
    assertSecretFree(event);
    if (isTailRecovery(event)) continue;
    if (!isRecord(event) || event.v !== 1) fail('invalid_store');
    if (event.type === 'run' || event.type === 'checkpoint_resolution') {
      const next = restoreRun(event.run);
      if (
        run
          ? !confirmed || !sameRunRecord(run, confirmed) || !isRunContinuation(run, next)
          : next.history.length !== 0
      )
        fail('run_diverged');
      if (event.type === 'checkpoint_resolution') {
        if (!run) fail('invalid_store');
        const record = restoreCheckpoint(event.record);
        validateCheckpoint(record, run, config, checkpoints, bindings, next);
        checkpoints.set(record.point, record);
      } else if (run) {
        validateCheckpointContinuation(run, next, checkpoints);
      }
      run = next;
    } else if (
      event.type === 'checkpoint_bindings' &&
      run &&
      confirmed &&
      sameRunRecord(run, confirmed)
    ) {
      checkpointPhase(event.point);
      const point = event.point as CheckpointPoint;
      if (!config.checkpoints.includes(point)) fail('invalid_store');
      bindings.set(point, checkpointBindings(event.bindings, point, run.runId));
    } else if (event.type === 'checkpoint' && run && confirmed && sameRunRecord(run, confirmed)) {
      const record = restoreCheckpoint(event.record);
      validateCheckpoint(record, run, config, checkpoints, bindings);
      checkpoints.set(record.point, record);
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
  return { run, confirmed, upstreamId, checkpoints, bindings };
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
  private checkpoints = new Map<CheckpointPoint, CheckpointRecord>();
  private bindings = new Map<CheckpointPoint, CheckpointBindings>();
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
    try {
      this.validateConfigEvidence();
      const pinned = `/proc/self/fd/${this.directoryFd}`;
      const events = this.withStoreDirectory('control', (dir) =>
        parseJournalEvents(readPrivate(path.join(dir, 'events.jsonl')))
      );
      if (events.some(isRecoveryEvent)) fail('invalid_store');
      const evidence = replayControl(events, this.storedConfig);
      const snapshot = restoreRun(parseStrictUtf8Json(readPrivate(path.join(pinned, 'run.json'))));
      assertSecretFree(snapshot);
      if (
        !evidence.confirmed ||
        !sameRunRecord(evidence.confirmed, evidence.run) ||
        !sameRunRecord(evidence.run, snapshot) ||
        !sameRunRecord(snapshot, this.current) ||
        evidence.upstreamId !== this.upstreamId ||
        JSON.stringify([...evidence.checkpoints]) !== JSON.stringify([...this.checkpoints]) ||
        JSON.stringify([...evidence.bindings]) !== JSON.stringify([...this.bindings])
      )
        fail('run_diverged');
      return snapshot;
    } catch {
      fail('invalid_store');
    }
  }
  /** Fresh, strict config/digest evidence through the held directory descriptor. */
  validateConfigEvidence(): RunConfig {
    this.check();
    try {
      const pinned = `/proc/self/fd/${this.directoryFd}`;
      const bytes = readPrivate(path.join(pinned, 'config.json'));
      if (hash(bytes) !== strictUtf8(readPrivate(path.join(pinned, 'config.sha256'))))
        fail('invalid_store');
      const config = validateRunConfig(parseStrictUtf8Json(bytes));
      if (JSON.stringify(config) !== JSON.stringify(this.storedConfig)) fail('run_diverged');
      return config;
    } catch {
      fail('invalid_store');
    }
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
    if (types.isAsyncFunction(work)) fail('invalid_store');
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
      ) {
        // Consume a rejected returned promise before refusing its escaped lifetime.
        void Promise.resolve(value).catch(() => {});
        fail('invalid_store');
      }
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Atomic private artifact publication with the store's persistence-uncertainty latch.
   * A failed publication retains the lifetime fence; reporting and further writes refuse it. */
  replaceArtifact(name: string, bytes: Buffer): void {
    this.check();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) fail('invalid_store');
    this.withStoreDirectory('artifacts', (dir) =>
      this.write(() => replacePrivate(path.join(dir, name), bytes))
    );
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
      const evidence = replayControl(journal.read(), config);
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
      store.checkpoints = evidence.checkpoints;
      store.bindings = evidence.bindings;
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
    validateCheckpointContinuation(this.current, run, this.checkpoints);
    this.write(() => {
      this.journal.append({ v: 1, type: 'run', run });
      confirmSnapshot(this.journal, `/proc/self/fd/${this.directoryFd}`, run);
    });
    this.current = run;
  }
  /** Controller-owned current content; update after any candidate/policy/session edit. */
  recordCheckpointBindings(point: CheckpointPoint, input: CheckpointBindings): void {
    this.check();
    const bindings = checkpointBindings(input, point, this.runId);
    if (!this.storedConfig.checkpoints.includes(point)) fail('invalid_store');
    const previous = this.bindings.get(point);
    if (previous && sameCheckpointBindings(previous, bindings)) return;
    this.write(() => this.journal.append({ v: 1, type: 'checkpoint_bindings', point, bindings }));
    this.bindings.set(point, bindings);
  }
  currentCheckpointBindings(point: CheckpointPoint): CheckpointBindings | undefined {
    this.check();
    checkpointPhase(point);
    return this.bindings.get(point);
  }
  checkpoint(point: CheckpointPoint): CheckpointRecord | undefined {
    this.check();
    checkpointPhase(point);
    return this.checkpoints.get(point);
  }
  /** Persist record before UserPaused. The controller lifetime guard covers both steps. */
  persistCheckpoint(input: CheckpointRecord): void {
    this.check();
    const record = restoreCheckpoint(input);
    validateCheckpoint(record, this.current, this.storedConfig, this.checkpoints, this.bindings);
    this.write(() => this.journal.append({ v: 1, type: 'checkpoint', record }));
    this.checkpoints.set(record.point, record);
  }
  /** Decision and lifecycle continuation share one durable event; snapshot recovery is
   * the same as persistRun, so no crash can leave a reusable approval. */
  resolveCheckpoint(input: CheckpointRecord, next: RunRecord): void {
    this.check();
    const record = restoreCheckpoint(input);
    next = restoreRun(structuredClone(next));
    validateCheckpoint(
      record,
      this.current,
      this.storedConfig,
      this.checkpoints,
      this.bindings,
      next
    );
    this.write(() => {
      this.journal.append({ v: 1, type: 'checkpoint_resolution', record, run: next });
      confirmSnapshot(this.journal, `/proc/self/fd/${this.directoryFd}`, next);
    });
    this.current = next;
    this.checkpoints.set(record.point, record);
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
