/** Production command bindings. Root is the run-store root itself, never stateDir.
 * No provider text or credential is emitted here; the parser owns fixed rendering. */
import fs from 'node:fs';
import path from 'node:path';
import {
  approveCheckpoint,
  checkpointStatus,
  rejectCheckpoint,
} from '../dist/controller/checkpoints.js';
import { runConfigInput } from '../dist/controller/config.js';
import {
  readOutcomeBudget,
  readOutcomeHandoffs,
  readOutcomeTrack,
} from '../dist/controller/outcome-records.js';
import { RunStore } from '../dist/controller/run-store.js';
import { assembleStatus } from '../dist/controller/status.js';
import { StepArtifacts } from '../dist/controller/steps.js';
import { prepareAuthor, stopStoredRun } from '../dist/controller/wiring.js';
import { assertDirectoryAncestors, readPrivate } from '../dist/durable-fs.js';
import { parseJournalEvents } from '../dist/journal.js';
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
  const configFor = (runId) =>
    withStore(runId, true, (store) => {
      checkRoot(store.config);
      return store.config;
    });
  const ids = () => {
    assertDirectoryAncestors(root);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (
      entries.length > 10000 ||
      entries.some((e) => !e.isDirectory() || !/^ztc-[a-f0-9]{16}$/u.test(e.name))
    )
      refuse('invalid_store');
    return entries.map((e) => `${e.name}-run-1`).sort();
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
        store.validateEvidence();
        return result;
      },
      true
    );
  return {
    async prepareAuthor(config, { name, email } = {}) {
      checkRoot(config);
      if (config.resumeRunId) refuse('invalid_resume_run_id');
      const approval = await prepareAuthor(config, { name, email }, { onAuthorizationUrl });
      // A config-supplied approval cannot masquerade as fresh authenticated consent.
      pendingAuthors.set(authorKey(config), approval);
      return approval;
    },
    async start(config) {
      checkRoot(config);
      if (config.resumeRunId) refuse('invalid_resume_run_id');
      const key = authorKey(config);
      const approval = pendingAuthors.get(key);
      if (!approval) refuse('author_approval_missing');
      pendingAuthors.delete(key);
      const approved = { ...config, authorApproval: approval };
      const run = await createController(approved, { onAuthorizationUrl }).start(approved);
      return status(run.runId);
    },
    async resume(runId, { revise } = {}) {
      if (revise) refuse('revision_unavailable');
      const config = configFor(runId);
      if (!config.authorApproval) refuse('author_approval_missing');
      await prepareAuthor(config, { userId: config.authorApproval.userId }, { onAuthorizationUrl });
      const run = await createController(config, { onAuthorizationUrl }).resume(runId);
      return status(run.runId);
    },
    status,
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
      for (const runId of ids()) {
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
      return aggregate(ids().map((runId) => withStore(runId, true, contributionOutcome)));
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
