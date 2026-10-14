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
  applyUserPatch,
  changeCheckpoints,
  changeModelProfile,
  latestSourceEdit,
  sourceEditCount,
} from '../dist/controller/edits.js';
import { contributionIdOf } from '../dist/controller/ids.js';
import { openWaitUntil, publicationWaitTime } from '../dist/controller/lifecycle-times.js';
import {
  readOutcomeBudget,
  readOutcomeHandoffs,
  readOutcomeTrack,
} from '../dist/controller/outcome-records.js';
import { RunStore } from '../dist/controller/run-store.js';
import { assembleStatus, withManualAppRevocation } from '../dist/controller/status.js';
import { StepArtifacts } from '../dist/controller/steps.js';
import { STOP_NOTICE_KEY, stopNoticeAction } from '../dist/controller/stop-notice.js';
import {
  beginAuthorPreparation,
  fenceIncident,
  incidentRequested,
  stopStoredRun,
} from '../dist/controller/wiring.js';
import { assertDirectoryAncestors, privateDir, readPrivate } from '../dist/durable-fs.js';
import { MAX_BODY_LENGTH } from '../dist/github/handoff.js';
import { TokenJournal, UNRESOLVED } from '../dist/github/token-journal.js';
import { Journal } from '../dist/journal.js';

const FEEDBACK_NOT_ADMITTED =
  'This revision handed off: the maintainer feedback was judged out of scope or ambiguous, so nothing was implemented or pushed (the typed verdict is retained). Address the feedback yourself on the pull request, or cancel the run.';

import { isGitHubLogin } from '../dist/github-login.js';
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

// Signals terminate a process, not one command facade. All facades share the
// same cleanup barrier across preparation and broker-owned active invocations.
const authorOwners = new Set();
let stoppingAuthors = false;
const stopAuthors = async (signal) => {
  if (stoppingAuthors) return;
  stoppingAuthors = true;
  // Join every process-local owner, including controller pause/release after
  // broker adoption. Repeated signals cannot shorten this barrier.
  const owners = [...authorOwners];
  const results = await Promise.allSettled(owners.map((owner) => owner.dispose()));
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') continue;
    const owner = owners[index];
    if (owner.kind === 'controller') {
      const runId = owner.runId();
      process.stderr.write(
        `error: cleanup_failed${runId ? `; run ${runId}` : ''}; inspect zt-run status and reconcile VM, credential and accounting cleanup; revoke uncertain App authorization at https://github.com/settings/applications\n`
      );
    } else
      process.stderr.write(
        'error: revoke_failed; revoke the App authorization at https://github.com/settings/applications\n'
      );
  }
  process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
};
const interrupted = () => {
  void stopAuthors('SIGINT');
};
const terminated = () => {
  void stopAuthors('SIGTERM');
};
const hungup = () => {
  void stopAuthors('SIGHUP');
};
const releaseOwner = (owner) => {
  authorOwners.delete(owner);
  if (!authorOwners.size) {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    process.removeListener('SIGHUP', hungup);
  }
};
const trackOwner = (owner) => {
  if (!authorOwners.size) {
    process.on('SIGINT', interrupted);
    process.on('SIGTERM', terminated);
    process.on('SIGHUP', hungup);
  }
  authorOwners.add(owner);
  return owner;
};
const ownSession = (session) => {
  const owner = Object.freeze({
    approval: session.approval,
    dispose: async () => {
      await session.dispose();
      releaseOwner(owner);
    },
    adopt: async (...args) => {
      if (stoppingAuthors) refuse('admission_closed');
      const contributor = await session.adopt(...args);
      releaseOwner(owner); // Broker now owns durable cleanup and signal recovery.
      return contributor;
    },
  });
  return trackOwner(owner);
};

export async function createCommands({ root, createController, onAuthorizationUrl, onRun }) {
  root = path.resolve(root);
  const pendingAuthors = new Map();
  const pendingPreparations = new Map();
  const authorOperations = new Set();
  const withController = async (config, session, work) => {
    if (stoppingAuthors) refuse('admission_closed');
    const controller = createController(
      config,
      { onAuthorizationUrl, ...(onRun ? { onRun } : {}) },
      session
    );
    const owner = trackOwner({
      kind: 'controller',
      dispose: () => controller.interrupt(),
      runId: () => {
        try {
          const id = controller.snapshot().runId;
          return contributionIdOf(id) ? id : null;
        } catch {
          return null;
        }
      },
    });
    try {
      return await work(controller);
    } finally {
      releaseOwner(owner);
    }
  };
  const disposePreparation = async (key) => {
    const owner = pendingPreparations.get(key);
    if (!owner) return;
    await owner.dispose();
    releaseOwner(owner);
    pendingPreparations.delete(key);
  };
  const authorKey = (config) => {
    const { authorApproval: _approval, ...input } = runConfigInput(config);
    return canonicalJson(input, 1024 * 1024);
  };
  // Reserve the process-local credential owner before any await. A refused
  // competitor must never dispose the session the admitted start is using.
  const withAuthor = async (config, work) => {
    if (stoppingAuthors) refuse('admission_closed');
    const key = authorKey(config);
    if (authorOperations.has(key)) refuse('busy');
    authorOperations.add(key);
    try {
      return await work(key);
    } finally {
      authorOperations.delete(key);
    }
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
            gateAssessment: artifacts.get('gate_assessment'),
            gateAssessmentDigest: artifacts.digest('gate_assessment'),
            candidate:
              artifacts.get('applied_user_edit') !== sourceEditCount(store)
                ? (latestSourceEdit(store)?.candidate ?? artifacts.get('candidate'))
                : artifacts.get('candidate'),
            tracking: artifacts.get('tracking'),
            publication: artifacts.get('publication'),
            withdrawal: artifacts.get('withdrawal'),
            authorizationRequired: artifacts.get('authorization_required'),
            feedbackDecision: artifacts.get('feedback_decision'),
            stopNotice: artifacts.get(STOP_NOTICE_KEY),
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
          [
            'submitted',
            'awaiting_review',
            'accepted',
            'merged',
            'declined',
            'revising',
            'verifying',
            'shipping',
            'paused_user',
            'blocked',
          ].includes(run.state) &&
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
        else if (
          run.state === 'paused_user' &&
          retained.feedbackDecision?.sessionId === sessionId &&
          retained.feedbackDecision?.admitted === false
        )
          tracker = { state: run.state, nextPermittedAction: FEEDBACK_NOT_ADMITTED };
        const statusNow = new Date();
        const result = assembleStatus({
          run,
          now: statusNow,
          budget,
          sessionId,
          publicationWaitMs: store.withStoreDirectory('control', (dir) => {
            const file = path.join(dir, 'controller', 'events.jsonl');
            try {
              return publicationWaitTime(
                parseJournalEvents(readPrivate(file)),
                sessionId,
                statusNow.getTime(),
                store.runId,
                openWaitUntil(run, statusNow.getTime())
              );
            } catch (error) {
              if (error?.code === 'ENOENT') return 0;
              throw error;
            }
          }),
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
          authorizationRequired: retained.authorizationRequired,
        });
        const assessed = retained.gateAssessment;
        if (
          run.state === 'gating' &&
          assessed?.outcome === 'hand_off' &&
          stopNoticeAction(retained.stopNotice, run) &&
          retained.stopNotice.gateAssessmentDigest === retained.gateAssessmentDigest &&
          assessed.historyLength === run.history.length &&
          assessed.sessionId === sessionId
        )
          result.policyGate = {
            baseSha: assessed.baseSha,
            reasons: assessed.reasons,
            assessment: assessed.assessment,
          };
        // A producer's reason for exactly this stop; any later transition retires it.
        const noticed = stopNoticeAction(retained.stopNotice, run);
        if (noticed) result.nextPermittedAction = noticed;
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
        return withManualAppRevocation(result);
      },
      true
    );
  return {
    async discardAuthor(config) {
      return withAuthor(config, async (key) => {
        await disposePreparation(key);
        const session = pendingAuthors.get(key);
        await session?.dispose();
        pendingAuthors.delete(key);
      });
    },
    async prepareAuthor(config, { name, email } = {}) {
      return withAuthor(config, async (key) => {
        checkRoot(config);
        if (incidentRequested(root)) refuse('incident_active');
        if (config.resumeRunId) refuse('invalid_resume_run_id');
        await disposePreparation(key);
        await pendingAuthors.get(key)?.dispose();
        pendingAuthors.delete(key);
        const preparation = trackOwner(
          beginAuthorPreparation(config, { name, email }, { onAuthorizationUrl })
        );
        pendingPreparations.set(key, preparation);
        let session;
        try {
          const prepared = await preparation.ready;
          if (stoppingAuthors) refuse('admission_closed');
          session = ownSession(prepared);
          releaseOwner(preparation); // Atomic move: never a gap in cleanup ownership.
          pendingPreparations.delete(key);
        } catch (error) {
          await disposePreparation(key);
          throw error;
        }
        // A config-supplied approval cannot masquerade as fresh authenticated consent.
        pendingAuthors.set(key, session);
        return session.approval;
      });
    },
    async start(config) {
      return withAuthor(config, async (key) => {
        const session = pendingAuthors.get(key);
        let guard;
        try {
          checkRoot(config);
          if (incidentRequested(root)) refuse('incident_active');
          if (config.resumeRunId) refuse('invalid_resume_run_id');
          if (!session) refuse('author_approval_missing');
          const approved = { ...config, authorApproval: session.approval };
          guard = acquireStart(approved);
          const run = await withController(approved, session, (controller) =>
            controller.start(approved)
          );
          return status(run.runId);
        } finally {
          if (guard !== undefined) fs.closeSync(guard);
          await session?.dispose();
          pendingAuthors.delete(key);
        }
      });
    },
    edit(runId, bytes) {
      if (incidentRequested(root)) refuse('incident_active');
      withStore(runId, false, (store) => {
        checkRoot(store.config);
        applyUserPatch(store, store.run, bytes, new Date());
      });
      return status(runId);
    },
    async resume(runId, { revise, reviewers, modelProfile, checkpoints } = {}) {
      if (incidentRequested(root)) {
        const held = RunStore.open(root, runId, { cleanup: true });
        held.close();
        await stopStoredRun(root, runId, 'Incident root fence');
        return status(runId);
      }
      // Refuse a malformed login before any profile or checkpoint change is saved.
      if (reviewers?.some((login) => !isGitHubLogin(login))) refuse('invalid_reviewer');
      if (modelProfile !== undefined || checkpoints !== undefined)
        withStore(runId, false, (store) => {
          checkRoot(store.config);
          if (modelProfile !== undefined) changeModelProfile(store, store.run, modelProfile);
          if (checkpoints !== undefined) changeCheckpoints(store, store.run, checkpoints);
        });
      const config = configFor(runId, true);
      if (!config.authorApproval) refuse('author_approval_missing');
      // Locked controller reconciliation decides whether identity is needed.
      // Pending publication must reach read-back before any OAuth preflight.
      const run = await withController(config, undefined, (controller) =>
        controller.resume(runId, {
          revise: Boolean(revise),
          ...(reviewers ? { reviewers } : {}),
        })
      );
      return status(run.runId);
    },
    status,
    async resolve(runId, tokenId) {
      const store = RunStore.open(root, runId, { cleanup: true });
      let tokens;
      try {
        checkRoot(store.config);
        if (store.run.state !== 'blocked_cleanup') refuse('cleanup_required');
        tokens = new Journal(store.storeDirectory('tokens'));
        const journal = new TokenJournal(tokens);
        const token = journal.state.tokens.get(tokenId);
        if (!token || !UNRESOLVED.includes(token.status)) refuse('invalid_input');
        journal.resolveByOperator(tokenId, new Date().toISOString());
      } finally {
        tokens?.close();
        store.close();
      }
      // Acknowledgement settles one credential, never independent VM/accounting obligations.
      await stopStoredRun(root, runId, 'Operator confirmed credential dead');
      return status(runId);
    },
    async prAction(runId, request) {
      if (incidentRequested(root)) refuse('incident_active');
      const config = configFor(runId, true);
      let action = request;
      if (request.kind === 'edit') {
        const bytes = readPrivate(request.bodyFile, (stat) => {
          if (stat.size > MAX_BODY_LENGTH) refuse('invalid_input');
        });
        const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        assertSecretFree(body);
        action = { kind: 'edit', title: request.title, body };
      }
      return withController(config, undefined, (controller) => controller.prAction(runId, action));
    },
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
