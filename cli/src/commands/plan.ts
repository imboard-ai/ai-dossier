/**
 * `ai-dossier plan` — post, read, and validate `plan:v1` artifacts on a GitHub issue.
 *
 * One canonical per-issue plan (#462, RFC-0001 C.6): posting is append-only (a new post
 * supersedes — readers always take the LAST plan:v1 comment), reading is `get`, and
 * `validate` runs the deterministic checks — referenced files exist at HEAD (unless marked
 * `(new)`), head-distance, risk-floor path scan — with no model call anywhere.
 */

import fs from 'node:fs';
import type { Command } from 'commander';
import {
  asString,
  exec,
  fail,
  gitFailure,
  isSafeArg,
  postIssueComment,
  printDryRun,
  requireIssueTarget,
  snippet,
  tryFetchComments,
} from '../gh';
import {
  buildPlanComment,
  findLatestPlan,
  isHeadSha,
  MAX_ARTIFACT_BODY_LENGTH,
  PLAN_SECTIONS,
  type PlanArtifact,
  type PlanSection,
  parsePredictedFileBullets,
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

/** One finding of `validate`, machine-parseable by design. */
export interface PlanValidationReason {
  /** Which check produced the finding. */
  check:
    | 'artifact'
    | 'sections'
    | 'missing-file'
    | 'stale-plan'
    | 'head-distance'
    | 'risk-floor'
    | 'git';
  /** `error` fails validity; `warn`/`info` are carried for the caller to act on. */
  severity: 'error' | 'warn' | 'info';
  message: string;
}

/**
 * snake_case JSON keys for section content, pinned by the format spec. Predicted Files
 * is deliberately absent: its JSON key carries the extracted path ARRAY, not the raw
 * section markdown, so it is assigned once outside this map.
 */
const SECTION_JSON_KEYS: Record<Exclude<PlanSection, 'Predicted Files'>, string> = {
  Problem: 'problem',
  'Acceptance Criteria': 'acceptance_criteria',
  Approach: 'approach',
  'Test Scope': 'test_scope',
};

/** `git cat-file -e` exits 1 when the raw object id itself is absent — a defensive fallback for git forms that use this exit code rather than 128 (below), which is what `HEAD:<path>` actually exits with. */
const GIT_NO_SUCH_OBJECT = 1;

/**
 * `git cat-file -e HEAD:<path>` exits 128 both when `<path>` is not present at HEAD (the
 * common case) and when HEAD itself does not resolve (no commits yet, corrupt ref, not a
 * repo) — the exit code alone cannot distinguish them. An earlier version of this check
 * tried to tell them apart by matching git's stderr wording (#579's original bug fix),
 * but that wording is gettext-translated and has changed across git versions — e.g. an
 * untracked path's "exists on disk, but not in 'HEAD'" never matched at all, silently
 * reproducing the original bug for that case. {@link headResolves} answers the same
 * question structurally instead: if HEAD resolves to a real commit, ANY 128 from the
 * `HEAD:<path>` probe can only mean the path is absent — regardless of git's wording.
 */
const GIT_FATAL = 128;

/**
 * Whether HEAD resolves to a real commit — the fact that disambiguates a 128 exit from
 * {@link fileExistsAtHead}'s probe. Only interesting on the failure path (`res.ok` is
 * `false`), and cheap enough to call once per path without memoizing.
 */
function headResolves(): boolean {
  return exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).ok;
}

/** Characters kept when quoting a network-derived path inside an error message. */
const PATH_SNIPPET_LENGTH = 80;

/** The latest plan artifact on an issue plus the comment metadata gh reported for it. */
interface FetchedPlan {
  artifact: PlanArtifact;
  url: string;
  createdAt: string;
  /** Author login, when gh reported one — part of the get --json output since 0.14.0. */
  author: string;
  /** gh's authorAssociation for the comment (MEMBER/OWNER/COLLABORATOR/BOT/…). */
  authorAssociation: string;
}

/** Author associations GitHub treats as having write access to the repository. */
const WRITE_ACCESS_ASSOCIATIONS = new Set(['MEMBER', 'OWNER', 'COLLABORATOR', 'BOT']);

/** Read the plan file, exiting with the errno when it cannot be read. */
function readPlanFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    fail([
      `Could not read plan file '${file}': ${e.code ?? 'error'} — ${snippet(e.message, PATH_SNIPPET_LENGTH)}.`,
    ]);
  }
}

/** Resolve the `head=` stamp: the `--head` override, else the repo's current HEAD. */
function resolveHead(override?: string): string {
  if (override !== undefined) return override;
  const res = exec('git', ['rev-parse', '--short', 'HEAD']);
  if (!res.ok) {
    fail([
      [
        `Could not stamp head= — 'git rev-parse --short HEAD' failed.`,
        `Fix: run from inside the repository the plan targets, or pass --head <sha> explicitly.`,
      ].join('\n'),
    ]);
  }
  return res.stdout;
}

/** Find the canonical (latest) plan on an issue, or `null` when none exists. */
function fetchLatestPlan(issue: string, repo?: string): FetchedPlan | null {
  const result = tryFetchComments(issue, repo);
  if (!result.ok) fail([result.error]);

  const bodies = result.comments.map((c) => (typeof c?.body === 'string' ? c.body : ''));
  const latest = findLatestPlan(bodies);
  if (latest === null) return null;

  const comment = result.comments[latest.index];
  return {
    artifact: latest.artifact,
    url: asString(comment?.url),
    createdAt: asString(comment?.createdAt),
    author: asString(comment?.author?.login),
    authorAssociation: asString(comment?.authorAssociation),
  };
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

      const markdown = readPlanFile(options.file);

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

      const head = resolveHead(options.head);
      if (!isHeadSha(head)) {
        fail([
          `Invalid head '${snippet(head, PATH_SNIPPET_LENGTH)}' — expected 7-40 lowercase hex characters, as printed by 'git rev-parse --short HEAD' (e.g. abc1234).\nFix: a plan posted with a malformed head= can never be read back — get and validate would silently ignore it.`,
        ]);
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
        printDryRun(body, options.json, { head });
        return;
      }

      postIssueComment({
        issue: options.issue,
        repo: options.repo,
        body,
        noun: 'plan',
        action: `Failed to post the plan artifact to issue #${options.issue}`,
        json: options.json,
        jsonExtras: { head },
        successLine: (url) => `✅ plan:v1 head=${head} → ${url}`,
      });
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
      error: `'${snippet(path, PATH_SNIPPET_LENGTH)}' is not a usable path (flag-like, spaced, or control characters)`,
    };
  }
  const res = exec('git', ['cat-file', '-e', `HEAD:${path}`]);
  if (res.ok) return { ok: true, exists: true };
  if (res.error.status === GIT_NO_SUCH_OBJECT) return { ok: true, exists: false };
  if (res.error.status === GIT_FATAL && headResolves()) return { ok: true, exists: false };
  return { ok: false, error: gitFailure(res.error) };
}

/** Commits between the artifact's `head=` and the local HEAD, or why git could not answer. */
function headDistance(head: string): { ok: true; count: number } | { ok: false; error: string } {
  if (!isSafeArg(head)) {
    return { ok: false, error: `head='${snippet(head, PATH_SNIPPET_LENGTH)}' is not a usable sha` };
  }
  const res = exec('git', ['rev-list', '--count', `${head}..HEAD`]);
  if (!res.ok) {
    return { ok: false, error: gitFailure(res.error) };
  }
  const count = Number(res.stdout);
  // A count line that is not a number means git answered something we did not ask —
  // report it rather than letting NaN silently read as "distance 0".
  if (!Number.isInteger(count) || count < 0) {
    return { ok: false, error: `git printed a non-numeric count: ${snippet(res.stdout)}` };
  }
  return { ok: true, count };
}

/** Strip terminal-control characters — comment bodies are network-reachable. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching (and stripping) control characters is exactly this regex's job
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

/**
 * The deterministic per-artifact checks: sections, predicted-file existence at HEAD,
 * head-distance, and the risk-floor scan. Pure assembly — every probe failure degrades
 * to a reason naming the cause, never a crash.
 */
function artifactReasons(artifact: PlanArtifact): PlanValidationReason[] {
  const reasons: PlanValidationReason[] = [];

  for (const error of validateArtifactBody(artifact.markdown)) {
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
  // Iterate parsed bullets, not `artifact.predictedFiles` + a path-keyed Set lookup — two
  // bullets naming the same path (one marked `(new)`, one not) would otherwise alias
  // through the Set and give both occurrences the same (wrong, for one of them) verdict.
  for (const bullet of parsePredictedFileBullets(artifact.sections['Predicted Files'])) {
    const path = snippet(bullet.path, PATH_SNIPPET_LENGTH);
    const exists = fileExistsAtHead(bullet.path);
    if (!exists.ok) {
      reasons.push({
        check: 'git',
        severity: 'error',
        message: `Cannot verify '${path}' at HEAD: ${exists.error} — run from inside the repository the plan targets.`,
      });
    } else if (!exists.exists && !bullet.isNew) {
      reasons.push({
        check: 'missing-file',
        severity: 'error',
        message: `Predicted file '${path}' does not exist at current HEAD. If this issue creates it, mark the bullet '(new)' — e.g. '- \`${path}\` (new) — why'.`,
      });
    } else if (exists.exists && bullet.isNew) {
      reasons.push({
        check: 'stale-plan',
        severity: 'warn',
        message: `Predicted file '${path}' is marked '(new)' but already exists at current HEAD — the plan may be stale.`,
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
  } else if (distance.count > 0) {
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

  return reasons;
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

      const { artifact, url, createdAt, author } = found;
      if (options.json) {
        const sections: Record<string, string> = {};
        for (const section of PLAN_SECTIONS) {
          if (section === 'Predicted Files') continue;
          sections[SECTION_JSON_KEYS[section]] = artifact.sections[section];
        }
        console.log(
          JSON.stringify(
            {
              head: artifact.head,
              ...sections,
              predicted_files: artifact.predictedFiles,
              new_files: [...artifact.newFiles],
              url,
              created_at: createdAt,
              author,
            },
            null,
            2
          )
        );
        return;
      }
      // The body is network-reachable; on a TTY, strip control sequences so a forged
      // comment cannot rewrite the terminal. Piped output stays byte-exact.
      const safe = process.stdout.isTTY ? artifact.raw.replace(CONTROL_CHARS_RE, '') : artifact.raw;
      process.stdout.write(safe);
    });
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
        reasons.push(...artifactReasons(found.artifact));
        // Authorship signal, not a gate: selection is last-plan-wins by design (the
        // runstate:v1 convention), but a canonical plan from an account without write
        // access deserves a flag a consumer can act on.
        if (!WRITE_ACCESS_ASSOCIATIONS.has(found.authorAssociation)) {
          reasons.push({
            check: 'artifact',
            severity: 'warn',
            message: `Latest plan was posted by '${found.author || 'unknown'}' (association ${found.authorAssociation || 'UNKNOWN'}) — an account without write access. Verify authorship before trusting this plan.`,
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
