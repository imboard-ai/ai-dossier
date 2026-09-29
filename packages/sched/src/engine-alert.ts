/**
 * Visible engine-death alerts (#945 ask 2, #940 ask 2). `sched status` showing
 * a `stale-engine-lease` warning is not an alert — nobody runs it. These
 * helpers journal a durable event AND hand a message to a pluggable notifier
 * (the CLI wires stderr + an optional GitHub comment on a tracking issue), so a
 * dead or hung engine is visible without anyone looking.
 *
 * Triggers, all deduplicated:
 *  - `checkStaleLeaseAlert`: lease holder dead + unfinished work → ONE alert
 *    per stale episode; lease holder alive but its heartbeat older than the
 *    hung threshold → ONE `engine-hung` alert per episode. An episode is
 *    remembered by an `O_EXCL` marker file, so two concurrent watchers cannot
 *    both alert. Called by watchers (`sched status --alert`, cron-able).
 *  - `reportCrashRestart`: a new `sched start` reclaimed a dead holder's lease
 *    → `engine-restarted-after-crash` (or `engine-restarted-after-stop-timeout`
 *    when the previous engine had begun a graceful stop first).
 *
 * A watcher runs unattended: an unwritable store or journal downgrades to a
 * stderr warning (and possibly a repeat alert) — it never throws.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Journal } from './journal';
import type { ReclaimedEngineLease, SchedStore } from './persist';
import { countUnfinishedWork, engineHungForMs, resolveHungAfterMs } from './status';

export interface EngineAlert {
  kind:
    | 'stale-engine-lease'
    | 'engine-hung'
    | 'engine-restarted-after-crash'
    | 'engine-restarted-after-stop-timeout';
  message: string;
}

export type AlertNotifier = (alert: EngineAlert) => void;

const ALERT_MARKER_PREFIX = '.alerted-';
const LEGACY_MARKER_FILE = '.stale-lease-alerted';

export type StaleLeaseAlertOutcome =
  | 'no-lease'
  | 'alive'
  | 'no-work'
  | 'already-alerted'
  | 'alerted';

/** Episode ids come from lease ids (`pid-ms-random`); keep the marker name filesystem-safe. */
function markerName(episode: string): string {
  return `${ALERT_MARKER_PREFIX}${episode.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function clearMarkers(dir: string): void {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(ALERT_MARKER_PREFIX) || f === LEGACY_MARKER_FILE) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  } catch {
    // no store dir yet / unreadable: nothing to clear
  }
}

/** True when this caller won the episode (marker created); false when it already existed. Throws only on an unwritable store. */
function claimEpisode(dir: string, episode: string): boolean {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.closeSync(fs.openSync(path.join(dir, markerName(episode)), 'wx', 0o600));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function checkStaleLeaseAlert(
  store: SchedStore,
  journal: Journal,
  notify: AlertNotifier,
  now: Date = new Date(),
  opts: { hungAfterMs?: number } = {}
): StaleLeaseAlertOutcome {
  const lease = store.engineLeaseStatus();
  if (lease === null) {
    clearMarkers(store.dir);
    return 'no-lease';
  }
  const hungAfterMs = opts.hungAfterMs ?? resolveHungAfterMs(0);
  const hungFor = engineHungForMs(lease, now, hungAfterMs);
  if (lease.alive && hungFor === null) {
    clearMarkers(store.dir);
    return 'alive';
  }
  const { unfinished, liveSlots } = countUnfinishedWork(store.load());
  if (unfinished === 0 && liveSlots === 0) return 'no-work';

  const hung = lease.alive;
  const baseEpisode = lease.id ?? `pid-${lease.pid}`;
  const episode = hung ? `${baseEpisode}-hung` : baseEpisode;
  try {
    if (!claimEpisode(store.dir, episode)) return 'already-alerted';
  } catch (err) {
    // Cannot remember the episode: still alert (a repeat beats silence).
    process.stderr.write(
      `⚠ sched alert: could not record alert marker: ${(err as Error).message}\n`
    );
  }

  const queue = `${unfinished} queue entr${unfinished === 1 ? 'y is' : 'ies are'} unfinished and ${liveSlots} slot(s) live`;
  const message = hung
    ? `sched engine looks HUNG: pid ${lease.pid} is alive but its last heartbeat was ${lease.updated_at} (${Math.round((hungFor ?? 0) / 60_000)} min ago) while ${queue} — a tick is probably wedged. Stop it (SIGTERM; SIGKILL if it ignores that) and run \`ai-dossier sched start\`.`
    : `sched engine is DOWN: lease holder pid ${lease.pid} is not running${lease.updated_at ? ` (last heartbeat ${lease.updated_at})` : ''} while ${queue} — nothing is ticking. Restart with \`ai-dossier sched start\`.`;
  try {
    journal.append(
      {
        event: 'stale-engine-lease-alert',
        pid: lease.pid,
        reason: hung ? 'engine-hung' : 'stale-lease',
        detail: message,
      },
      now
    );
  } catch (err) {
    process.stderr.write(`⚠ sched alert: could not journal alert: ${(err as Error).message}\n`);
  }
  try {
    notify({ kind: hung ? 'engine-hung' : 'stale-engine-lease', message });
  } catch (err) {
    process.stderr.write(`⚠ sched alert notifier failed: ${(err as Error).message}\n`);
  }
  return 'alerted';
}

export function reportCrashRestart(
  journal: Journal,
  reclaimed: ReclaimedEngineLease,
  notify: AlertNotifier,
  now: Date = new Date(),
  stopping?: { signal: string; at: string } | null
): void {
  const since = reclaimed.updated_at ? `; its last heartbeat was ${reclaimed.updated_at}` : '';
  const stopGoneWrong = stopping !== undefined && stopping !== null;
  const message = stopGoneWrong
    ? `sched engine restarted after a stop that never finished: previous engine pid ${reclaimed.pid} began a graceful stop on ${stopping.signal} at ${stopping.at} and was then killed${since}. This is a wedged stop, not a crash.`
    : `sched engine restarted after an unexpected exit: previous engine pid ${reclaimed.pid} died without releasing its lease${since}. Check the journal for its final \`engine-exit\` line (none means SIGKILL/OOM).`;
  journal.append(
    {
      event: 'engine-restarted-after-crash',
      pid: reclaimed.pid,
      reason: stopGoneWrong ? 'stop-interrupted' : 'lease-reclaimed',
      detail: message,
    },
    now
  );
  try {
    notify({
      kind: stopGoneWrong ? 'engine-restarted-after-stop-timeout' : 'engine-restarted-after-crash',
      message,
    });
  } catch (err) {
    process.stderr.write(`⚠ sched alert notifier failed: ${(err as Error).message}\n`);
  }
}
