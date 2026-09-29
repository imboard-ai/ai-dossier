/**
 * Visible engine-death alerts (#945 ask 2, #940 ask 2). `sched status` showing
 * a `stale-engine-lease` warning is not an alert — nobody runs it. These
 * helpers journal a durable event AND hand a message to a pluggable notifier
 * (the CLI wires stderr + an optional GitHub comment on a tracking issue), so a
 * dead engine is visible without anyone looking.
 *
 * Two triggers, both deduplicated:
 *  - `checkStaleLeaseAlert`: lease holder dead + unfinished work → ONE alert
 *    per stale episode (episode = lease id; a marker file remembers it).
 *    Called by watchers (`sched status --alert`, the `ensure-running` watchdog).
 *  - `reportCrashRestart`: a new `sched start` reclaimed a dead holder's lease
 *    → `engine-restarted-after-crash`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Journal } from './journal';
import type { ReclaimedEngineLease, SchedStore } from './persist';
import { countUnfinishedWork } from './status';

export interface EngineAlert {
  kind: 'stale-engine-lease' | 'engine-restarted-after-crash';
  message: string;
}

export type AlertNotifier = (alert: EngineAlert) => void;

const ALERT_MARKER_FILE = '.stale-lease-alerted';

export type StaleLeaseAlertOutcome =
  | 'no-lease'
  | 'alive'
  | 'no-work'
  | 'already-alerted'
  | 'alerted';

export function checkStaleLeaseAlert(
  store: SchedStore,
  journal: Journal,
  notify: AlertNotifier,
  now: Date = new Date()
): StaleLeaseAlertOutcome {
  const marker = path.join(store.dir, ALERT_MARKER_FILE);
  const clear = () => fs.rmSync(marker, { force: true });
  const lease = store.engineLeaseStatus();
  if (lease === null) {
    clear();
    return 'no-lease';
  }
  if (lease.alive) {
    clear();
    return 'alive';
  }
  const { unfinished, liveSlots } = countUnfinishedWork(store.load());
  if (unfinished === 0 && liveSlots === 0) return 'no-work';
  const episode = lease.id ?? `pid-${lease.pid}`;
  try {
    if (fs.readFileSync(marker, 'utf8').trim() === episode) return 'already-alerted';
  } catch {
    // no marker yet
  }
  const since = lease.updated_at ? ` (last heartbeat ${lease.updated_at})` : '';
  const message = `sched engine is DOWN: lease holder pid ${lease.pid} is not running${since} while ${unfinished} queue entr${unfinished === 1 ? 'y is' : 'ies are'} unfinished and ${liveSlots} slot(s) live — nothing is ticking. Restart with \`ai-dossier sched start\` (or install the supervised service: \`sched service install\`).`;
  journal.append(
    { event: 'stale-engine-lease-alert', pid: lease.pid, reason: 'stale-lease', detail: message },
    now
  );
  // Marker first: a throwing notifier must not turn one episode into an alert per poll.
  fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, `${episode}\n`, { mode: 0o600 });
  try {
    notify({ kind: 'stale-engine-lease', message });
  } catch (err) {
    process.stderr.write(`⚠ sched alert notifier failed: ${(err as Error).message}\n`);
  }
  return 'alerted';
}

export function reportCrashRestart(
  journal: Journal,
  reclaimed: ReclaimedEngineLease,
  notify: AlertNotifier,
  now: Date = new Date()
): void {
  const since = reclaimed.updated_at ? `; its last heartbeat was ${reclaimed.updated_at}` : '';
  const message = `sched engine restarted after an unexpected exit: previous engine pid ${reclaimed.pid} died without releasing its lease${since}. Check the journal for its final \`engine-exit\` line (none means SIGKILL/OOM).`;
  journal.append(
    {
      event: 'engine-restarted-after-crash',
      pid: reclaimed.pid,
      reason: 'lease-reclaimed',
      detail: message,
    },
    now
  );
  try {
    notify({ kind: 'engine-restarted-after-crash', message });
  } catch (err) {
    process.stderr.write(`⚠ sched alert notifier failed: ${(err as Error).message}\n`);
  }
}
