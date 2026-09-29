/**
 * Notifier for engine-death alerts (#945): always stderr (a supervisor's
 * journal/log captures it), plus a comment on a configured tracking issue
 * (`--alert-issue <n>` / DOSSIER_SCHED_ALERT_ISSUE) so it is visible without
 * anyone running `sched status`. The comment is best-effort: a failed `gh`
 * call is reported on stderr and never breaks the engine or the watcher.
 */

import { execFileSync } from 'node:child_process';
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

export function createAlertNotifier(
  project: string,
  repo: string | undefined,
  alertIssue: number | undefined,
  comment: (repo: string, issue: number, body: string) => void = ghComment
): AlertNotifier {
  return (alert) => {
    process.stderr.write(`⚠ sched alert [${project}] ${alert.kind}: ${alert.message}\n`);
    if (alertIssue === undefined) return;
    if (repo === undefined) {
      process.stderr.write(
        `⚠ sched alert: not commenting on #${alertIssue} — the current directory is not ${project}'s GitHub repository\n`
      );
      return;
    }
    try {
      comment(repo, alertIssue, `**sched alert (${alert.kind})** — ${alert.message}`);
    } catch (err) {
      process.stderr.write(
        `⚠ sched alert: could not comment on #${alertIssue}: ${(err as Error).message}\n`
      );
    }
  };
}

function ghComment(repo: string, issue: number, body: string): void {
  execFileSync('gh', ['issue', 'comment', String(issue), '--repo', repo, '--body', body], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 30_000,
  });
}
