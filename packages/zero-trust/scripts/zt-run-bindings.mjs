/** Production command bindings. Root is the run-store root itself, never stateDir.
 * No provider text or credential is emitted here; the parser owns fixed rendering. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  approveCheckpoint,
  checkpointStatus,
  rejectCheckpoint,
} from '../dist/controller/checkpoints.js';
import { runConfigInput } from '../dist/controller/config.js';
import { readControlRequests, requestControl } from '../dist/controller/control.js';
import {
  readOutcomeBudget,
  readOutcomeHandoffs,
  readOutcomeTrack,
} from '../dist/controller/outcome-records.js';
import { RunStore } from '../dist/controller/run-store.js';
import { assembleStatus } from '../dist/controller/status.js';
import { StepArtifacts } from '../dist/controller/steps.js';
import {
  fenceIncident,
  incidentRequested,
  prepareAuthor,
  stopStoredRun,
} from '../dist/controller/wiring.js';
import { assertDirectoryAncestors, privateDir, readPrivate } from '../dist/durable-fs.js';
import { parseJournalEvents } from '../dist/journal.js';
import { lockDescriptor, StoreLockedError } from '../dist/lock.js';
import { aggregate, contributionOutcome, recordAdoption } from '../dist/metrics/outcomes.js';
import { canonicalJson } from '../dist/receipt/schema.js';
import { assertSecretFree } from '../dist/redaction.js';
import { exportContribution } from '../dist/retention/export.js';
import { applySweep, planSweep } from '../dist/retention/retention.js';

function refuse(code) {
  throw Object.assign(new Error(code), { code });
}

export async function createCommands({ root, createController, onAuthorizationUrl }) {
  root = path.resolve(root);
  const pendingAuthors = new Map();
  const authorKey = (config) => {
    const { authorApproval: _approval, ...input } = runConfigInput(config);
    return canonicalJson(input, 1024 * 1024);
  };
  // New run IDs are random. Bind overlapping starts by the trusted config digest,
  // independently of fresh OAuth/approval timestamps, while keeping different
  // configurations runnable under the same root. Kernel ownership never expires.
  const acquireStart = (config) => {
    const directory = path.join(config.executionProfile.stateDir, '.start-guards');
    privateDir(directory);
    const name = createHash('sha256').update(authorKey(config)).digest('hex');
    const file = path.join(directory, name);
    let fd;
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
      if (named.ino !== stat.ino || named.dev !== stat.dev) throw new StoreLockedError();
      return fd;
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      throw error;
    }
  };
  const checkRoot = (config) => {
    if (
      path.basename(root) !== 'runs' ||
      root !== path.resolve(config.executionProfile.stateDir, 'runs')
    )
      refuse('root_mismatch');
  };
  const withStore = (runId, readOnly, work, observe = false) => {
    const store = RunStore.open(root, runId, { readOnly, observe });
    try {
      return work(store);
    } finally {
      store.close();
    }
  };
  const configFor = (runId, recover = false) =>
    withStore(runId, !recover, (store) => {
      checkRoot(store.config);
      return store.config;
    });
  const ids = (incident = false) => {
    assertDirectoryAncestors(root);
    const entries = [];
    const directory = fs.opendirSync(root);
    let capped = false;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (entries.length >= 10000) {
          capped = true;
          break;
        }
        entries.push(entry);
      }
    } finally {
      directory.closeSync();
    }
    const invalid =
      capped ||
      entries.some(
        (e) => e.name !== '.incident' && (!e.isDirectory() || !/^ztc-[a-f0-9]{16}$/u.test(e.name))
      );
    if (!incident && invalid) refuse('invalid_store');
    return {
      invalid,
      values: entries
        .filter((e) => e.isDirectory() && /^ztc-[a-f0-9]{16}$/u.test(e.name))
        .map((e) => `${e.name}-run-1`)
        .sort(),
    };
  };
  const status = (runId) =>
    withStore(
      runId,
      true,
      (store) => {
        const run = store.run;
        const budget = readOutcomeBudget(store);
        const sessionId = budget.sessions.at(-1)?.id;
        const retained = store.withStoreDirectory('control', (dir) => {
          const filePath = path.join(dir, 'steps', 'events.jsonl');
          let bytes;
          try {
            bytes = readPrivate(filePath);
          } catch (error) {
            if (error?.code === 'ENOENT') return {};
            throw error;
          }
          // Read-only structural journal: constructor replay never creates/repairs a file.
          const artifacts = new StepArtifacts(
            { filePath, read: () => parseJournalEvents(bytes) },
            runId
          );
          return {
            gate: artifacts.get('gate'),
            candidate: artifacts.get('candidate'),
            tracking: artifacts.get('tracking'),
            publication: artifacts.get('publication'),
            withdrawal: artifacts.get('withdrawal'),
          };
        });
        let handoff;
        if (
          run.state === 'awaiting_maintainer' ||
          (run.state === 'awaiting_contributor' && ['contributor_handoff'].includes(run.reasonCode))
        ) {
          const held = readOutcomeHandoffs(store, run);
          handoff = { ...held, run };
        }
        let tracker;
        if (
          retained.tracking &&
          ['submitted', 'awaiting_review', 'accepted', 'merged', 'declined'].includes(run.state) &&
          run.history.some((e) => e.reasonCode === 'publication_observed')
        ) {
          readOutcomeTrack(store, run);
          if (retained.tracking?.state === run.state) tracker = retained.tracking;
        }
        const point = ['plan', 'patch', 'verification'].find(
          (p) => store.checkpoint(p)?.status === 'open'
        );
        if (run.state === 'paused_user' && point)
          tracker = {
            state: run.state,
            ...checkpointStatus(store.checkpoint(point), store.currentCheckpointBindings(point)),
          };
        const result = assembleStatus({
          run,
          now: new Date(),
          budget,
          sessionId,
          handoff,
          tracker,
          ...(retained.candidate?.record?.candidateSha
            ? { candidateSha: retained.candidate.record.candidateSha }
            : {}),
          ...(retained.gate
            ? {
                prerequisite: {
                  upstream: {
                    ...store.config.upstream,
                    repositoryId: retained.gate.eligibility.repositoryId,
                    defaultBranch: retained.gate.eligibility.defaultBranch,
                  },
                  appSlug: store.config.githubApp.slug,
                },
              }
            : {}),
          authorApproval: store.config.authorApproval,
        });
        const control = readControlRequests(store);
        if (control.invalid) {
          result.phase = 'invalid_control';
          result.nextPermittedAction =
            'Control evidence is corrupt or unknown; inspect retained request files before resuming.';
        } else if (control.pending.length) {
          result.phase = control.pending.some((r) => r.kind === 'cancel')
            ? 'cancel_requested'
            : 'pause_requested';
          result.nextPermittedAction =
            'The durable control request is pending controller application.';
        } else if (control.refused.length) {
          result.nextPermittedAction = `Control refused: ${control.refused.join(',')}. ${result.nextPermittedAction}`;
        }
        if (run.state === 'cancelled' && retained.publication)
          result.nextPermittedAction = `Submitted PR: ${retained.publication.url}. ${retained.withdrawal ?? 'The contributor may withdraw the submitted PR explicitly.'}`;
        store.validateEvidence();
        return result;
      },
      true
    );
  return {
    async prepareAuthor(config, { name, email } = {}) {
      checkRoot(config);
      if (incidentRequested(root)) refuse('incident_active');
      if (config.resumeRunId) refuse('invalid_resume_run_id');
      const approval = await prepareAuthor(config, { name, email }, { onAuthorizationUrl });
      // A config-supplied approval cannot masquerade as fresh authenticated consent.
      pendingAuthors.set(authorKey(config), approval);
      return approval;
    },
    async start(config) {
      checkRoot(config);
      if (incidentRequested(root)) refuse('incident_active');
      if (config.resumeRunId) refuse('invalid_resume_run_id');
      const key = authorKey(config);
      const approval = pendingAuthors.get(key);
      if (!approval) refuse('author_approval_missing');
      pendingAuthors.delete(key);
      const approved = { ...config, authorApproval: approval };
      const guard = acquireStart(approved);
      try {
        const run = await createController(approved, { onAuthorizationUrl }).start(approved);
        return status(run.runId);
      } finally {
        fs.closeSync(guard);
      }
    },
    async resume(runId, { revise } = {}) {
      if (revise) refuse('revision_unavailable');
      if (incidentRequested(root)) {
        const held = RunStore.open(root, runId, { cleanup: true });
        held.close();
        await stopStoredRun(root, runId, 'Incident root fence');
        return status(runId);
      }
      const config = configFor(runId, true);
      if (!config.authorApproval) refuse('author_approval_missing');
      const control = withStore(runId, true, readControlRequests, true);
      if (!control.invalid && !control.pending.length)
        await prepareAuthor(
          config,
          { userId: config.authorApproval.userId },
          { onAuthorizationUrl }
        );
      const run = await createController(config, { onAuthorizationUrl }).resume(runId);
      return status(run.runId);
    },
    status,
    pause(runId, reason) {
      return withStore(
        runId,
        true,
        (store) => requestControl(store, { kind: 'pause', reason }, new Date()),
        true
      );
    },
    cancel(runId, reason) {
      return withStore(
        runId,
        true,
        (store) => requestControl(store, { kind: 'cancel', reason }, new Date()),
        true
      );
    },
    approve(runId, answer) {
      withStore(runId, false, (store) => approveCheckpoint(store, store.run, answer, new Date()));
      return status(runId);
    },
    reject(runId, answer, reason) {
      withStore(runId, false, (store) =>
        rejectCheckpoint(store, store.run, answer, reason, new Date())
      );
      return status(runId);
    },
    async authorize(runId) {
      await createController(configFor(runId), { onAuthorizationUrl }).authorize(runId);
      return status(runId);
    },
    async killAll(reason) {
      assertSecretFree(reason);
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 500)
        refuse('invalid_input');
      const results = [];
      const failures = [];
      fenceIncident(root, reason);
      const selected = ids(true);
      if (selected.invalid) failures.push(Object.assign(new Error(), { code: 'invalid_store' }));
      for (const runId of selected.values) {
        try {
          await stopStoredRun(root, runId, reason);
          results.push(status(runId));
        } catch (error) {
          failures.push(error);
        }
      }
      // Join every incident obligation before reporting a failed store.
      if (failures.length) throw failures[0];
      return results;
    },
    metrics() {
      return aggregate(ids().values.map((runId) => withStore(runId, true, contributionOutcome)));
    },
    adoption(runId, note) {
      withStore(runId, false, (store) => recordAdoption(store, note, new Date()));
      return status(runId);
    },
    sweep({ apply } = {}) {
      const plan = planSweep(root, new Date());
      if (apply) applySweep(plan);
      return {
        applied: Boolean(apply),
        contributions: plan.contributions.length,
        files: plan.contributions.reduce((n, c) => n + c.files.length, 0),
      };
    },
    export(runId, out) {
      withStore(runId, true, (store) => exportContribution(store, out));
    },
  };
}
