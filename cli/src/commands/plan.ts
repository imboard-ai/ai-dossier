/**
 * `ai-dossier plan` — post, read, and validate `plan:v1` artifacts on a GitHub issue.
 *
 * One canonical per-issue plan (#462, RFC-0001 C.6): posting is append-only (a new post
 * supersedes — readers always take the LAST plan:v1 comment), reading is `get`, and
 * `validate` runs the deterministic checks — referenced files exist at HEAD, head-distance,
 * risk-floor path scan — with no model call anywhere.
 */

import fs from 'node:fs';
import type { Command } from 'commander';
import {
  asString,
  exec,
  fail,
  ghFailure,
  isSafeArg,
  parseGhJson,
  repoArgs,
  requireIssueTarget,
  snippet,
} from '../gh';
import {
  buildPlanComment,
  findLatestPlan,
  MAX_ARTIFACT_BODY_LENGTH,
  PLAN_SECTIONS,
  type PlanArtifact,
  type PlanSection,
  parsePlanMarker,
  scanRiskFloor,
  validateArtifactBody,
} from '../plan-artifact';

interface PostOptions {
  issue: string;
  file: string;
  head?: string;
  repo?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface GetOptions {
  issue: string;
  repo?: string;
  json?: boolean;
}

interface ValidateOptions {
  issue: string;
  repo?: string;
}

/** A comment as gh reports it; every field but `body` may be absent. */
interface GhComment {
  body?: unknown;
  url?: unknown;
  createdAt?: unknown;
}

/** One finding of `validate`, machine-parseable by design. */
export interface PlanValidationReason {
  /** Which check produced the finding. */
  check: 'artifact' | 'sections' | 'missing-file' | 'head-distance' | 'risk-floor' | 'git';
  /** `error` fails validity; `warn`/`info` are carried for the caller to act on. */
  severity: 'error' | 'warn' | 'info';
  message: string;
}

/** snake_case JSON keys for section content, pinned by the format spec. */
const SECTION_JSON_KEYS: Record<PlanSection, string> = {
  Problem: 'problem',
  'Acceptance Criteria': 'acceptance_criteria',
  'Predicted Files': 'predicted_files',
  Approach: 'approach',
  'Test Scope': 'test_scope',
};

/** The latest plan artifact on an issue plus the comment metadata gh reported for it. */
interface FetchedPlan {
  artifact: PlanArtifact;
  url: string;
  createdAt: string;
}

/** Fetch an issue's comments through gh, exiting with the shared failure taxonomy. */
function fetchComments(issue: string, repo?: string): GhComment[] {
  const res = exec('gh', ['issue', 'view', issue, '--json', 'comments', ...repoArgs(repo)]);
  if (!res.ok) {
    fail([ghFailure(`Could not read issue #${issue}`, res.error, repo)]);
  }
  const parsed = parseGhJson<{ comments?: unknown }>(res.stdout);
  if (parsed === null || !Array.isArray(parsed?.comments)) {
    // Same discipline as runstate: "no plans yet" and "unreadable response" must not
    // look alike — the first is a normal answer, the second means the tool is broken.
    fail([
      [
        `Could not read issue #${issue}: gh exited 0 but did not print a comments array.`,
        `Fix: run 'gh issue view ${issue} --json comments' by hand to see what gh returns.`,
        `gh printed: ${snippet(res.stdout)}`,
      ].join('\n'),
    ]);
  }
  return parsed.comments as GhComment[];
}

/** Find the canonical (latest) plan on an issue, or `null` when none exists. */
function fetchLatestPlan(issue: string, repo?: string): FetchedPlan | null {
  const comments = fetchComments(issue, repo);
  const bodies = comments.map((c) => (typeof c?.body === 'string' ? c.body : ''));
  const artifact = findLatestPlan(bodies);
  if (artifact === null) return null;
  // findLatestPlan identified the LAST parseable body; find the comment carrying it so
  // url/createdAt belong to that exact comment.
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = typeof comments[i]?.body === 'string' ? (comments[i].body as string) : '';
    if (parsePlanMarker(body)?.head === artifact.head && body === artifact.raw) {
      return {
        artifact,
        url: asString(comments[i]?.url),
        createdAt: asString(comments[i]?.createdAt),
      };
    }
  }
  return { artifact, url: '', createdAt: '' };
}

/** `plan post` — validate a markdown file, stamp it with head=, comment it onto the issue. */
function registerPostSubcommand(cmd: Command): void {
  cmd
    .command('post')
    .description('Post a plan:v1 artifact comment (validates sections first; supersedes = append)')
    .requiredOption('--issue <number>', 'GitHub issue number')
    .requiredOption('--file <path>', 'Markdown file with the five required sections')
    .option('--head <sha>', 'Override the head= stamp (defaults to current HEAD)')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--dry-run', 'Print the comment body without posting it')
    .option('--json', 'Output the result as JSON')
    .action((options: PostOptions) => {
      requireIssueTarget(options);

      let markdown: string;
      try {
        markdown = fs.readFileSync(options.file, 'utf8');
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        fail([
          `Could not read plan file '${options.file}': ${e.code ?? 'error'} — ${snippet(e.message, 160)}.`,
        ]);
      }

      const sectionErrors = validateArtifactBody(markdown);
      if (sectionErrors.length > 0) {
        fail([
          [
            `Plan file '${options.file}' is not a postable plan:v1 artifact.`,
            'Fix: give it all five sections — ' +
              PLAN_SECTIONS.map((s) => `## ${s}`).join(', ') +
              ' — as documented in docs/reference/plan-artifact.md.',
          ].join('\n'),
          ...sectionErrors,
        ]);
      }

      let head = options.head;
      if (head === undefined) {
        const res = exec('git', ['rev-parse', '--short', 'HEAD']);
        if (!res.ok) {
          fail([
            [
              `Could not stamp head= — 'git rev-parse --short HEAD' failed.`,
              `Fix: run from inside the repository the plan targets, or pass --head <sha> explicitly.`,
            ].join('\n'),
          ]);
        }
        head = res.stdout;
      }

      const body = buildPlanComment(head, markdown);
      if (body.length > MAX_ARTIFACT_BODY_LENGTH) {
        fail([
          [
            `Plan is ${body.length} characters — GitHub rejects an issue comment over ${MAX_ARTIFACT_BODY_LENGTH}.`,
            `Fix: trim the plan; an artifact is a plan, not a report — details belong in linked documents.`,
          ].join('\n'),
        ]);
      }

      if (options.dryRun) {
        if (options.json) {
          console.log(JSON.stringify({ posted: false, dryRun: true, head, body }, null, 2));
        } else {
          process.stdout.write(body);
        }
        return;
      }

      const res = exec('gh', [
        'issue',
        'comment',
        options.issue,
        '--body',
        body,
        ...repoArgs(options.repo),
      ]);
      if (!res.ok) {
        fail([
          ghFailure(
            `Failed to post the plan artifact to issue #${options.issue}`,
            res.error,
            options.repo
          ),
          // Hand back the body: re-deriving a plan is far more expensive than a retry.
          `The plan was NOT posted. Retry, or post it by hand:\ngh issue comment ${options.issue}${options.repo ? ` --repo ${options.repo}` : ''} --body ${JSON.stringify(body)}`,
        ]);
      }

      if (options.json) {
        console.log(JSON.stringify({ posted: true, head, url: res.stdout }, null, 2));
      } else {
        console.log(`✅ plan:v1 head=${head} → ${res.stdout}`);
      }
    });
}

/** `plan get` — print the latest artifact; exit 1 distinguishably when none exists. */
function registerGetSubcommand(cmd: Command): void {
  cmd
    .command('get')
    .description('Print the latest plan:v1 artifact on an issue (read-only)')
    .requiredOption('--issue <number>', 'GitHub issue number')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--json', 'Output the parsed artifact as JSON')
    .action((options: GetOptions) => {
      requireIssueTarget(options);
      const found = fetchLatestPlan(options.issue, options.repo);

      if (found === null) {
        // Distinguishable "no plan" exit (#462 AC2): stderr message + exit code 1, so a
        // caller can fall back to full planning without parsing output text.
        console.error(`No plan:v1 artifact on issue #${options.issue}.`);
        console.error(`Fix: post one — ai-dossier plan post --issue ${options.issue} --file <md>`);
        process.exit(1);
      }

      const { artifact, url, createdAt } = found;
      if (options.json) {
        const sections: Record<string, string> = {};
        for (const section of PLAN_SECTIONS) {
          sections[SECTION_JSON_KEYS[section]] = artifact.sections[section];
        }
        console.log(
          JSON.stringify(
            {
              head: artifact.head,
              ...sections,
              predicted_files: artifact.predictedFiles,
              url,
              created_at: createdAt,
            },
            null,
            2
          )
        );
        return;
      }
      process.stdout.write(artifact.raw);
    });
}

/**
 * Whether `git cat-file -e HEAD:<path>` says the path exists at HEAD, or why git could
 * not answer. A path that failed the {@link isSafeArg} guard never reaches git: marker
 * values are network-reachable, and a `-`-prefixed or spaced value would be read as a
 * flag or split into arguments.
 */
function fileExistsAtHead(
  path: string
): { ok: true; exists: boolean } | { ok: false; error: string } {
  if (!isSafeArg(path)) {
    return {
      ok: false,
      error: `'${snippet(path, 80)}' is not a usable path (flag-like, spaced, or control characters)`,
    };
  }
  const res = exec('git', ['cat-file', '-e', `HEAD:${path}`]);
  if (res.ok) return { ok: true, exists: true };
  // `cat-file -e` exits 1 for "no such object at HEAD" — an answer, not a fault.
  // (stderr is not usable here: exec's message fallback means it is never empty.)
  // Anything else (128, signals, ENOENT) means git could not answer.
  if (res.error.status === 1) return { ok: true, exists: false };
  return {
    ok: false,
    error: res.error.notFound
      ? 'git is not installed or not on PATH'
      : `git exited ${res.error.status ?? 'abnormally'}: ${snippet(res.error.stderr, 120)}`,
  };
}

/** Commits between the artifact's `head=` and the local HEAD, or why git could not answer. */
function headDistance(head: string): { ok: true; count: string } | { ok: false; error: string } {
  if (!isSafeArg(head)) {
    return { ok: false, error: `head='${snippet(head, 80)}' is not a usable sha` };
  }
  const res = exec('git', ['rev-list', '--count', `${head}..HEAD`]);
  if (!res.ok) {
    return {
      ok: false,
      error: res.error.notFound
        ? 'git is not installed or not on PATH'
        : `git exited ${res.error.status ?? 'abnormally'}: ${snippet(res.error.stderr, 120)}`,
    };
  }
  return { ok: true, count: res.stdout };
}

/** `plan validate` — deterministic checks and a `{valid, reasons[]}` JSON verdict. */
function registerValidateSubcommand(cmd: Command): void {
  cmd
    .command('validate')
    .description(
      'Deterministically validate the latest plan artifact (JSON verdict, no model call)'
    )
    .requiredOption('--issue <number>', 'GitHub issue number')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .action((options: ValidateOptions) => {
      requireIssueTarget(options);
      const reasons: PlanValidationReason[] = [];

      const found = fetchLatestPlan(options.issue, options.repo);
      if (found === null) {
        reasons.push({
          check: 'artifact',
          severity: 'error',
          message: `No plan:v1 artifact on issue #${options.issue} — post one with 'ai-dossier plan post'.`,
        });
      } else {
        const { artifact } = found;

        for (const error of validateArtifactBody(artifact.raw.split('\n').slice(1).join('\n'))) {
          reasons.push({ check: 'sections', severity: 'error', message: error });
        }

        if (artifact.predictedFiles.length === 0) {
          reasons.push({
            check: 'sections',
            severity: 'warn',
            message:
              "Predicted Files section produced no paths — expected one '- `path`' bullet per file.",
          });
        }
        for (const path of artifact.predictedFiles) {
          const exists = fileExistsAtHead(path);
          if (!exists.ok) {
            reasons.push({
              check: 'git',
              severity: 'error',
              message: `Cannot verify '${path}' at HEAD: ${exists.error}.`,
            });
          } else if (!exists.exists) {
            reasons.push({
              check: 'missing-file',
              severity: 'error',
              message: `Predicted file '${path}' does not exist at current HEAD.`,
            });
          }
        }

        const distance = headDistance(artifact.head);
        if (!distance.ok) {
          reasons.push({
            check: 'git',
            severity: 'warn',
            message: `Cannot measure head-distance: ${distance.error} — run from inside the repository the plan targets.`,
          });
        } else if (Number(distance.count) > 0) {
          reasons.push({
            check: 'head-distance',
            severity: 'info',
            message: `${distance.count} commit(s) on HEAD since the plan's head=${artifact.head} — re-check Predicted Files against what changed.`,
          });
        }

        for (const hit of scanRiskFloor(artifact.predictedFiles)) {
          reasons.push({
            check: 'risk-floor',
            severity: 'info',
            message: `Predicted file '${hit.path}' touches '${hit.pattern}' — elevated-risk surface; review tier should not go below the risk floor.`,
          });
        }
      }

      const valid = reasons.every((r) => r.severity !== 'error');
      console.log(JSON.stringify({ valid, reasons }, null, 2));
      if (!valid) process.exit(1);
    });
}

/** Registers the `plan` command tree (post, get, validate). */
export function registerPlanCommand(program: Command): void {
  const planCmd = program
    .command('plan')
    .description('Post, read, and validate plan:v1 artifacts on a GitHub issue');

  registerPostSubcommand(planCmd);
  registerGetSubcommand(planCmd);
  registerValidateSubcommand(planCmd);
}
