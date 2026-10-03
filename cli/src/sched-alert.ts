/**
 * Notifier for engine-death alerts (#945): always stderr (a supervisor's
 * journal/log captures it), plus a comment on a configured tracking issue
 * (`--alert-issue <n>` / DOSSIER_SCHED_ALERT_ISSUE) so it is visible without
 * anyone running `sched status`. The comment is best-effort: a failed `gh`
 * call is reported on stderr and never breaks the engine or the watcher.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AlertNotifier } from '@ai-dossier/sched';

export const ALERT_ISSUE_ENV = 'DOSSIER_SCHED_ALERT_ISSUE';

export function parseAlertIssue(flag: string | undefined, env = process.env): number | undefined {
  const raw = flag ?? env[ALERT_ISSUE_ENV];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`alert issue must be a positive integer, got '${raw}'`);
  }
  return n;
}

/** The two `gh` operations the notifier needs — injectable so tests never call GitHub. */
export interface AlertCommentApi {
  /** Create a comment; returns its id, or null when the id could not be determined. */
  create(repo: string, issue: number, body: string): number | null;
  /** Edit an existing comment; false when it no longer exists / the call failed. */
  update(repo: string, commentId: number, body: string): boolean;
}

/**
 * A crash loop produces one crash alert per restart. Alerts of the same kind
 * closer together than this are ONE episode: the first creates the tracking
 * comment, every later one edits it (count + latest message) instead of adding
 * another.
 */
export const ALERT_EPISODE_GAP_MS = 60 * 60 * 1000;
const ALERT_COMMENTS_FILE = '.alert-comments.json';

interface EpisodeRecord {
  comment_id: number;
  count: number;
  first_at: string;
  last_at: string;
}

function readEpisodes(dir: string): Record<string, EpisodeRecord> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, ALERT_COMMENTS_FILE), 'utf8'));
    return raw !== null && typeof raw === 'object' ? (raw as Record<string, EpisodeRecord>) : {};
  } catch {
    return {};
  }
}

function writeEpisodes(dir: string, episodes: Record<string, EpisodeRecord>): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, ALERT_COMMENTS_FILE), `${JSON.stringify(episodes)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Best effort: without the record the next alert simply opens a new comment.
  }
}

export interface AlertNotifierOptions {
  /** Where the per-kind episode record lives (the sched store dir). Without it every alert is its own comment. */
  stateDir?: string;
  api?: AlertCommentApi;
  now?: () => Date;
}

/**
 * `repo` may be a thunk: resolving it shells out to `gh repo view`, which a
 * per-minute watchdog must not pay unless an alert is actually raised.
 */
export function createAlertNotifier(
  project: string,
  repo: string | undefined | (() => string | undefined),
  alertIssue: number | undefined,
  opts: AlertNotifierOptions = {}
): AlertNotifier {
  const api = opts.api ?? ghCommentApi;
  const now = opts.now ?? (() => new Date());
  return (alert) => {
    process.stderr.write(`⚠ sched alert [${project}] ${alert.kind}: ${alert.message}\n`);
    if (alertIssue === undefined) return;
    const resolvedRepo = typeof repo === 'function' ? repo() : repo;
    if (resolvedRepo === undefined) {
      process.stderr.write(
        `⚠ sched alert: not commenting on #${alertIssue} — the current directory is not ${project}'s GitHub repository\n`
      );
      return;
    }
    const at = now();
    const body = (count: number, first: string) =>
      `**sched alert (${alert.kind})** — ${alert.message}${
        count > 1 ? `\n\n_Repeated ${count} times since ${first}; latest ${at.toISOString()}._` : ''
      }`;
    try {
      const episodes = opts.stateDir ? readEpisodes(opts.stateDir) : {};
      const prev = episodes[alert.kind];
      if (
        prev &&
        at.getTime() - Date.parse(prev.last_at) < ALERT_EPISODE_GAP_MS &&
        api.update(resolvedRepo, prev.comment_id, body(prev.count + 1, prev.first_at))
      ) {
        episodes[alert.kind] = { ...prev, count: prev.count + 1, last_at: at.toISOString() };
        if (opts.stateDir) writeEpisodes(opts.stateDir, episodes);
        return;
      }
      const id = api.create(resolvedRepo, alertIssue, body(1, at.toISOString()));
      if (id !== null && opts.stateDir) {
        episodes[alert.kind] = {
          comment_id: id,
          count: 1,
          first_at: at.toISOString(),
          last_at: at.toISOString(),
        };
        writeEpisodes(opts.stateDir, episodes);
      }
    } catch (err) {
      process.stderr.write(
        `⚠ sched alert: could not comment on #${alertIssue}: ${(err as Error).message}\n`
      );
    }
  };
}

const ghCommentApi: AlertCommentApi = {
  create(repo, issue, body) {
    const out = execFileSync(
      'gh',
      [
        'api',
        '--method',
        'POST',
        `repos/${repo}/issues/${issue}/comments`,
        '-f',
        `body=${body}`,
        '--jq',
        '.id',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
    );
    const id = Number(out.trim());
    return Number.isInteger(id) && id > 0 ? id : null;
  },
  update(repo, commentId, body) {
    try {
      execFileSync(
        'gh',
        [
          'api',
          '--method',
          'PATCH',
          `repos/${repo}/issues/comments/${commentId}`,
          '-f',
          `body=${body}`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 }
      );
      return true;
    } catch {
      return false;
    }
  },
};
