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
  fenceIncident,
  incidentRequested,
  prepareAuthor,
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
      const run = await createController(config, { onAuthorizationUrl }).resume(runId, {
        revise: Boolean(revise),
        ...(reviewers ? { reviewers } : {}),
      });
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
      return createController(config, { onAuthorizationUrl }).prAction(runId, action);
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
