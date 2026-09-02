/**
 * Plan artifact protocol (`plan:v1`) — the canonical per-issue plan stored as a GitHub
 * issue comment (#462 / RFC-0001 C.6).
 *
 * Issues used to be planned up to three times (triage, fleet prep, plan-issue). The
 * artifact replaces that with ONE plan on the issue that consumers validate-and-refine
 * instead of recreating. It lives on the issue — not a file — because batch preparation
 * runs before any branch exists.
 *
 * Everything here is pure and dependency-free (no `gh`, network, or fs) so it can be unit
 * tested directly — the same discipline as `runstate.ts`. Subprocess access lives in the
 * command layer (`commands/plan.ts`).
 */

import { MAX_BODY_LENGTH } from './runstate';

/**
 * Opens every plan artifact comment. Unlike the runstate marker, it carries `head=` — the
 * repo HEAD the plan was written against — because `validate` measures how far the repo
 * has moved since (head-distance) as a staleness signal.
 *
 * The marker must be the FIRST characters of the comment body; readers filter on that so
 * a plan quoted inside another comment cannot impersonate an artifact.
 */
export const PLAN_MARKER_PREFIX = '<!-- plan:v1 ';

/** Closes the marker line. */
const MARKER_SUFFIX = ' -->';

/** The five sections a plan artifact must carry, in canonical order. */
export const PLAN_SECTIONS = [
  'Problem',
  'Acceptance Criteria',
  'Predicted Files',
  'Approach',
  'Test Scope',
] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

/** `head=<7-40 hex chars>` — the short-sha form `git rev-parse --short HEAD` prints. */
const HEAD_IN_MARKER_RE = /^<!-- plan:v1 head=([0-9a-f]{7,40}) -->$/;

/**
 * Whether a value is a well-formed `head=` stamp: 7–40 lowercase hex characters.
 * `post --head` validates its override with this, so a plan can never be posted in a
 * form its own readers would refuse to recognize.
 */
export function isHeadSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(value);
}

/**
 * GitHub rejects an issue comment over 65536 characters with an opaque 422, and
 * `execFileSync` can hit E2BIG even earlier — the same cap `runstate` defends, imported
 * so the two protocols can never drift apart on it. Checked pre-flight so the failure
 * names the size instead of surfacing as "gh failed".
 */
export const MAX_ARTIFACT_BODY_LENGTH = MAX_BODY_LENGTH;

/** A parsed plan artifact. */
export interface PlanArtifact {
  /** Repo HEAD (short sha) the plan was posted against, from the marker. */
  head: string;
  /** The full comment body, marker included — what `get` prints in text mode. */
  raw: string;
  /** The comment body without the marker line — the plan's own markdown. */
  markdown: string;
  /** Raw markdown of each required section, keyed by section name. */
  sections: Record<PlanSection, string>;
  /** Repo-relative paths extracted from the Predicted Files section. */
  predictedFiles: string[];
  /**
   * Predicted-file paths whose bullet carries the `(new)` marker — the issue's scope is to
   * create them, so `validate` skips the missing-at-HEAD check for exactly these paths.
   */
  newFiles: Set<string>;
}

/**
 * Parse the marker line of a comment body.
 *
 * Returns the `head` sha when `body` OPENS with a well-formed marker, else `null` — a
 * body that merely contains the marker somewhere does not count, which is what keeps
 * quoted plans from being read as artifacts.
 */
export function parsePlanMarker(body: string): { head: string } | null {
  const firstLine = body.split('\n', 1)[0].trim();
  const match = HEAD_IN_MARKER_RE.exec(firstLine);
  return match ? { head: match[1] } : null;
}

/**
 * Extract the body of one `## <name>` section: everything from its header to the next
 * `## ` header or end of input. An `## ` at the very start of a line is a section header;
 * deeper nesting (`###`) belongs to the enclosing section.
 */
function extractSection(markdown: string, name: PlanSection): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start === -1) return null;
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    collected.push(line);
  }
  return collected.join('\n').trim();
}

/**
 * One parsed Predicted Files bullet: its path, and whether it carries the `(new)` marker
 * — see {@link parsePredictedFileBullets} for the bullet grammar.
 */
export interface PredictedFileBullet {
  path: string;
  isNew: boolean;
}

/**
 * Parse one Predicted Files bullet line, or `null` when the line is not a bullet / has no
 * path.
 *
 * The format (pinned in docs/reference/plan-artifact.md) is a bullet whose path is either
 * backticked — `- `path/to/file.ts` — why` — or the first bare token — `- path/to/file.ts
 * — why`. Backticks win when present so a reason containing slashes cannot masquerade as
 * a path. A path immediately followed by `(new)` (case-insensitive, before the `—`/`-`
 * separator if any) declares the file does not exist yet — the issue's scope is to create
 * it — e.g. `- \`path/to/new-file.ts\` (new) — why`.
 */
function parseOneBullet(line: string): PredictedFileBullet | null {
  const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
  if (!bullet) return null;
  const item = bullet[1].trim();
  if (item === '') return null;

  const codeSpan = /^`([^`]+)`/.exec(item);
  const candidate = codeSpan ? codeSpan[1] : item.split(/\s+/)[0];
  const path = candidate.replace(/[,;:]$/, '').trim();
  if (path === '') return null;

  const rest = item.slice(codeSpan ? codeSpan[0].length : candidate.length);
  const isNew = /^\s*\(new\)/i.test(rest);
  return { path, isNew };
}

/**
 * Every Predicted Files bullet, one per line — see {@link parseOneBullet} for the bullet
 * grammar. The single parse pass `extractPredictedFiles`, `extractNewPredictedFiles`, and
 * `plan validate`'s per-file loop all derive their answer from, so the section is only
 * ever split and matched once.
 */
export function parsePredictedFileBullets(sectionBody: string): PredictedFileBullet[] {
  const bullets: PredictedFileBullet[] = [];
  for (const line of sectionBody.split('\n')) {
    const bullet = parseOneBullet(line);
    if (bullet) bullets.push(bullet);
  }
  return bullets;
}

/** Repo-relative paths from the Predicted Files section, one per bullet — see {@link parsePredictedFileBullets}. */
export function extractPredictedFiles(sectionBody: string): string[] {
  return parsePredictedFileBullets(sectionBody).map((b) => b.path);
}

/**
 * Paths whose Predicted Files bullet carries the `(new)` marker — see
 * {@link parsePredictedFileBullets}. These declare a file the issue's scope is to CREATE,
 * so `plan validate` skips the missing-at-HEAD check for exactly these paths and instead
 * warns when one already exists. Never a superset of {@link extractPredictedFiles}'s
 * result.
 */
export function extractNewPredictedFiles(sectionBody: string): Set<string> {
  return new Set(
    parsePredictedFileBullets(sectionBody)
      .filter((b) => b.isNew)
      .map((b) => b.path)
  );
}

/**
 * Validate a markdown document as artifact content BEFORE it is posted: every required
 * section must be present as an `## <name>` header. Returns one error line per missing
 * section; empty means postable.
 */
export function validateArtifactBody(markdown: string): string[] {
  const missing = PLAN_SECTIONS.filter((section) => extractSection(markdown, section) === null);
  return missing.map((section) => `Missing required section '## ${section}'.`);
}

/** Build the comment body for a plan: marker line, then the validated markdown. */
export function buildPlanComment(head: string, markdown: string): string {
  return `${PLAN_MARKER_PREFIX}head=${head}${MARKER_SUFFIX}\n\n${markdown.trim()}\n`;
}

/**
 * Parse a full comment body into a {@link PlanArtifact}.
 *
 * A body whose marker is well-formed but whose sections are incomplete still parses
 * (readers must be able to read a malformed artifact in order to report it) — section
 * gaps surface as empty strings, and `validateArtifactBody` on the content is what
 * judges them.
 */
export function parsePlanArtifact(body: string): PlanArtifact | null {
  const marker = parsePlanMarker(body);
  if (!marker) return null;

  const markdown = body.split('\n').slice(1).join('\n').trim();
  const sections = {} as Record<PlanSection, string>;
  for (const section of PLAN_SECTIONS) {
    sections[section] = extractSection(markdown, section) ?? '';
  }
  const predictedFileBullets = parsePredictedFileBullets(sections['Predicted Files']);
  return {
    head: marker.head,
    raw: body,
    markdown,
    sections,
    predictedFiles: predictedFileBullets.map((b) => b.path),
    newFiles: new Set(predictedFileBullets.filter((b) => b.isNew).map((b) => b.path)),
  };
}

/** The canonical (latest) plan and the index of the comment carrying it. */
export interface LatestPlan {
  artifact: PlanArtifact;
  /** Index into the `commentBodies` array that was passed in. */
  index: number;
}

/**
 * The latest plan artifact across an issue's comments, oldest first.
 *
 * Supersede semantics are append-only like runstate: `post` never edits, so the LAST
 * parseable plan:v1 comment is the canonical plan and everything before it is history.
 * The index is returned so the caller can lift comment metadata (url, createdAt) from
 * the same comment without re-scanning for it.
 */
export function findLatestPlan(commentBodies: string[]): LatestPlan | null {
  let latest: LatestPlan | null = null;
  commentBodies.forEach((body, index) => {
    const parsed = parsePlanArtifact(body);
    if (parsed !== null) latest = { artifact: parsed, index };
  });
  return latest;
}

/**
 * Deterministic risk-floor patterns for the Predicted Files scan (#462 AC3).
 *
 * "Risk floor" is review vocabulary: the minimum review effort a change deserves. Paths
 * touching these surfaces lift the floor — the verdict carries the flag so a caller (a
 * dossier, a human) can pick a stronger review tier. Path-only by design: a deterministic
 * check must not read file contents or call a model.
 */
export interface RiskFloorPattern {
  /** Name reported in the verdict reason. */
  name: string;
  /** True when any path segment or the file stem matches. */
  matches: (path: string) => boolean;
}

/** True when any `/`-separated segment matches `re`; the file stem counts as a segment. */
function segmentMatches(path: string, re: RegExp): boolean {
  const segments = path.split('/').filter((s) => s !== '');
  // `protocol.ts` should match a `protocol` rule the same way a `protocol/` directory
  // does, so the last segment is also tested without its extension.
  const last = segments[segments.length - 1];
  if (last?.includes('.')) {
    segments.push(last.slice(0, last.lastIndexOf('.')));
  }
  return segments.some((segment) => re.test(segment));
}

export const RISK_FLOOR_PATTERNS: readonly RiskFloorPattern[] = [
  {
    name: 'auth-secrets',
    matches: (p) =>
      segmentMatches(
        p,
        /^(auth|oauth|sso|session|credential|credentials|secret|secrets|token|login|logout)$/i
      ) || /\.(pem|key|p12|pfx)$/i.test(p),
  },
  {
    name: 'payments-billing',
    matches: (p) =>
      segmentMatches(p, /^(payments?|billing|invoices?|checkout|stripe|charges?|refunds?)$/i),
  },
  {
    name: 'migrations-schema',
    matches: (p) =>
      segmentMatches(p, /^(migrations?|migrate|schema|prisma|drizzle|knex|sequelize)$/i) ||
      /\.sql$/i.test(p),
  },
  {
    name: 'protocol-contract',
    matches: (p) => segmentMatches(p, /^(protocol|wire|openapi|swagger|grpc|proto|contracts?)$/i),
  },
];

/** Every risk-floor pattern a path hits, in pattern order. */
export function scanRiskFloor(paths: readonly string[]): Array<{ path: string; pattern: string }> {
  const hits: Array<{ path: string; pattern: string }> = [];
  for (const path of paths) {
    for (const pattern of RISK_FLOOR_PATTERNS) {
      if (pattern.matches(path)) hits.push({ path, pattern: pattern.name });
    }
  }
  return hits;
}
