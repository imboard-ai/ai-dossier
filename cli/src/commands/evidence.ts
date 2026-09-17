/**
 * `ai-dossier evidence` — author, attach, fetch and display a dossier's `.evidence.json`
 * sidecar (RFC-0001 authoring evidence, #733/#734/#735). Never loaded by `ai-dossier run`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  calculateChecksum,
  createEvidenceRecord,
  type EvidenceRecord,
  type EvidenceRef,
  parseDossierContent,
  parseEvidence,
  validateEvidence,
} from '@ai-dossier/core';
import { type Command, Option } from 'commander';
import { loadCredentials } from '../credentials';
import { printRegistryErrors, siblingEvidencePath } from '../helpers';
import { multiRegistryGetEvidence } from '../multi-registry';
import { parseNameVersion } from '../registry-client';

interface ShowOptions {
  json?: boolean;
}

interface InitOptions {
  namespace?: string;
  output?: string;
  force?: boolean;
}

interface AddOptions {
  anchor: string;
  rationale: string;
  session?: string;
  provider: EvidenceRef['provider'];
  event?: string;
  host?: string;
  extra?: string[];
  namespace?: string;
  forceSession?: boolean;
}

/** Providers `evidence add` accepts — mirrors the schema's `evidence[].provider` enum. */
const EVIDENCE_PROVIDERS: EvidenceRef['provider'][] = [
  'claude-code',
  'codex',
  'opencode',
  'gemini-cli',
  'other',
];

/** Dossier file extension, hoisted since several places derive a name by stripping it. */
const DOSSIER_EXT = '.ds.md';

/** Filename (sans `.jsonl`) Claude Code uses for a transcript is the session UUID. */
const CLAUDE_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values that look like a placeholder/example instead of a real provider session id (#749). */
const PLACEHOLDER_SESSION_RE = /placeholder|session-fc|example|todo|xxx/i;

/** `--rationale` text that reads like the copied instruction rather than the agent's own words. */
const IMPERATIVE_RATIONALE_RE = /^(cite|record|add|write)\s/i;

/** How long an evidence-add run scans other project dirs, in the "any recent session" fallback. */
const RECENT_SESSION_WINDOW_MS = 60 * 60 * 1000;

/**
 * `fs.readdirSync(dir)`, treating a missing directory as empty. Any OTHER error (permission
 * denied, I/O error) is not silently swallowed — auto-detection still falls through to its
 * next source, but a warning on stderr says why, so an unreadable `~/.claude/projects/<slug>/`
 * doesn't read as "no transcript found" with no trace of the real cause.
 */
function safeReaddir(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir);
    return Array.isArray(entries) ? entries : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(
        `⚠️  could not read ${dir} while auto-detecting --session: ${(err as Error).message}\n`
      );
    }
    return [];
  }
}

/** Newest `*.jsonl` transcript directly inside `dir`, or undefined if there is none / it errors. */
function newestJsonlInDir(dir: string): { id: string; mtimeMs: number } | undefined {
  let newest: { id: string; mtimeMs: number } | undefined;
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const entryPath = path.join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(entryPath).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error(
          `⚠️  could not stat ${entryPath} while auto-detecting --session: ${(err as Error).message}\n`
        );
      }
      continue;
    }
    if (!newest || mtimeMs > newest.mtimeMs) {
      newest = { id: entry.slice(0, -'.jsonl'.length), mtimeMs };
    }
  }
  return newest;
}

/** A detected Claude Code session transcript: which directory it came from and how. */
interface ClaudeSessionMatch {
  id: string;
  /** `project` = this cwd's own transcript dir; `fallback` = the any-project recent-activity scan. */
  scope: 'project' | 'fallback';
  dir: string;
}

/**
 * Default `--session` for provider `claude-code`: the newest `*.jsonl` transcript under
 * `~/.claude/projects/<slug>/`, where `<slug>` is the current working directory path with
 * every `/` replaced by `-` — that is how Claude Code names its project directories. Falls
 * back to the newest jsonl under ANY project dir modified in the last hour, since a worktree's
 * cwd may not be the slug Claude Code actually wrote the transcript under — the caller labels
 * that fallback distinctly (`scope: 'fallback'`), since it can pick up an unrelated project.
 */
function findClaudeCodeSession(): ClaudeSessionMatch | undefined {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const slug = process.cwd().replace(/\//g, '-');
  const projectDir = path.join(projectsDir, slug);

  const primary = newestJsonlInDir(projectDir);
  if (primary) return { id: primary.id, scope: 'project', dir: projectDir };

  const cutoff = Date.now() - RECENT_SESSION_WINDOW_MS;
  let best: { id: string; mtimeMs: number; dir: string } | undefined;
  for (const name of safeReaddir(projectsDir)) {
    const dir = path.join(projectsDir, name);
    const candidate = newestJsonlInDir(dir);
    if (candidate && candidate.mtimeMs >= cutoff && (!best || candidate.mtimeMs > best.mtimeMs)) {
      best = { ...candidate, dir };
    }
  }
  return best ? { id: best.id, scope: 'fallback', dir: best.dir } : undefined;
}

interface ResolvedSession {
  session: string;
  source: 'flag' | 'env' | 'transcript-project' | 'transcript-fallback';
  /** The transcript directory the session id came from — only set for the two transcript sources. */
  dir?: string;
}

/**
 * Resolution order for `--session`: the explicit flag; `AI_DOSSIER_SESSION_ID`; for provider
 * `claude-code`, the newest transcript (`findClaudeCodeSession`). Returns undefined when none
 * of those produced a value — the caller prints the original "required" error in that case.
 */
function resolveSession(options: AddOptions): ResolvedSession | undefined {
  if (options.session) return { session: options.session, source: 'flag' };
  if (process.env.AI_DOSSIER_SESSION_ID) {
    return { session: process.env.AI_DOSSIER_SESSION_ID, source: 'env' };
  }
  if (options.provider === 'claude-code') {
    const detected = findClaudeCodeSession();
    if (detected) {
      return {
        session: detected.id,
        source: detected.scope === 'project' ? 'transcript-project' : 'transcript-fallback',
        dir: detected.dir,
      };
    }
  }
  return undefined;
}

/**
 * Reject a session id that cannot resolve to anything (#749: a placeholder like
 * `claude-session-fc749` recorded next to real UUIDs defeats the sidecar's purpose).
 * `--force-session` bypasses this entirely — for a provider whose session ids are
 * genuinely not UUIDs and don't happen to match the placeholder heuristic either.
 */
function validateSessionShape(
  session: string,
  provider: EvidenceRef['provider'],
  forceSession: boolean | undefined
): void {
  if (forceSession) return;

  if (provider === 'claude-code') {
    if (!CLAUDE_SESSION_UUID_RE.test(session)) {
      console.error(
        `\n❌ --session must be the Claude Code session UUID (the transcript filename under ~/.claude/projects); got "${session}"\n`
      );
      process.exit(1);
    }
    return;
  }

  if (session.length < 8 || PLACEHOLDER_SESSION_RE.test(session)) {
    console.error(
      `\n❌ --session looks like a placeholder, not a real ${provider} session id; got "${session}" (use --force-session to bypass)\n`
    );
    process.exit(1);
  }
}

/** Warn (never fail) when `--rationale` reads like copied instruction text, not the agent's own words. */
function warnIfImperativeRationale(rationale: string): void {
  const match = IMPERATIVE_RATIONALE_RE.exec(rationale.trim());
  if (match) {
    console.error(
      `⚠️  --rationale starts with "${match[1]} " — looks like copied instruction text; write why, in your own words\n`
    );
  }
}

/** Namespace resolution identical to `publish` — explicit flag, else credentials. */
function resolveNamespace(explicit?: string): string {
  if (explicit) return explicit;
  const credentials = loadCredentials();
  if (credentials) {
    return credentials.orgs.length > 0 ? credentials.orgs[0] : credentials.username;
  }
  console.error('\n❌ --namespace required (not logged in)\n');
  process.exit(1);
}

/**
 * Resolve the namespace segment of a sidecar's `dossier` field. An explicit `--namespace`
 * always wins. Otherwise, a sidecar that already has a `dossier` value KEEPS its current
 * namespace — a plain `evidence add`/`evidence sync` must never silently revert a deliberately
 * set namespace back to the account default; that is the exact mis-stamping trap (#736) this
 * command exists to let an author fix *in place*, by passing `--namespace` when they mean to
 * change it. Only a brand-new sidecar (`existingDossier` undefined) falls back to `publish`'s
 * own default chain — which also means a plain `sync`/`add` on an already-identified sidecar
 * needs no credentials at all.
 */
function resolveDossierNamespace(existingDossier: string | undefined, explicit?: string): string {
  if (explicit) return explicit;
  const existingNamespace = existingDossier?.includes('/')
    ? existingDossier.slice(0, existingDossier.lastIndexOf('/'))
    : undefined;
  return existingNamespace || resolveNamespace(explicit);
}

/** Read + parse a dossier file, exiting on failure. */
function readDossier(file: string): ReturnType<typeof parseDossierContent> {
  if (!fs.existsSync(file)) {
    console.error(`\n❌ File not found: ${file}\n`);
    process.exit(1);
  }
  try {
    return parseDossierContent(fs.readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    console.error(`\n❌ ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * Derive a dossier's identity fields — reads the file exactly once. `name` follows `publish`'s
 * own rule (`frontmatter.name || frontmatter.title || basename`). `checksumHash` falls back to
 * `calculateChecksum(body)` when the frontmatter has none: `publish-dossier`'s Step 2 deletes
 * `checksum`/`signature` on edit, restored later by Step 3's `sign`, so `init`/`add` (which may
 * run in between) must not error — the sidecar just records the hash the body currently has,
 * and `sync` after `sign` reconciles it. `sync` itself always runs after `sign`, so it checks
 * `frontmatter.checksum?.hash` itself before relying on this fallback (see its action below).
 */
function deriveIdentity(dossierFile: string): {
  frontmatter: ReturnType<typeof parseDossierContent>['frontmatter'];
  name: string;
  checksumHash: string;
} {
  const { frontmatter, body } = readDossier(dossierFile);
  const name = frontmatter.name || frontmatter.title || path.basename(dossierFile, DOSSIER_EXT);
  const checksumHash = frontmatter.checksum?.hash || calculateChecksum(body);
  return { frontmatter, name, checksumHash };
}

/**
 * Apply a derived identity (`deriveIdentity`) to a record's `dossier`/`version`/`checksum`
 * fields. `dossier`'s namespace segment is resolved via `resolveDossierNamespace` (preserved
 * unless `namespace` is given explicitly); `dossier`'s name segment, `version` and `checksum`
 * are always refreshed to the dossier's current frontmatter. Warns on stderr when an explicit
 * `--namespace` actually changes a namespace the sidecar already had — the change is intended
 * (that is the in-place fix this command exists to offer), but it should never be silent.
 */
function applyIdentity(
  record: EvidenceRecord,
  identity: ReturnType<typeof deriveIdentity>,
  namespace?: string
): EvidenceRecord {
  const previousNamespace = record.dossier?.includes('/')
    ? record.dossier.slice(0, record.dossier.lastIndexOf('/'))
    : undefined;
  const ns = resolveDossierNamespace(record.dossier, namespace);
  if (previousNamespace && ns !== previousNamespace) {
    console.error(`⚠️  dossier namespace changed: ${previousNamespace} → ${ns}`);
  }
  return {
    ...record,
    dossier: `${ns}/${identity.name}`,
    version: identity.frontmatter.version,
    checksum: { algorithm: 'sha256', hash: identity.checksumHash },
  };
}

/** Parse `--extra k=v` pairs into an object, exiting on a malformed entry. */
function parseExtra(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const extra: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) {
      console.error(`\n❌ Invalid --extra '${pair}' — expected k=v\n`);
      process.exit(1);
    }
    extra[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return extra;
}

/** Read + parse an existing sidecar file, exiting with a clean message on a corrupt one. */
function loadSidecar(sidecarPath: string): EvidenceRecord {
  try {
    return parseEvidence(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (err: unknown) {
    console.error(`\n❌ Evidence file is corrupt: ${sidecarPath}\n   ${(err as Error).message}\n`);
    process.exit(1);
  }
}

/** Write a sidecar record atomically — write to a per-process temp file, then rename. */
function writeSidecarAtomic(sidecarPath: string, record: EvidenceRecord): void {
  const tmpPath = `${sidecarPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, sidecarPath);
}

/** `evidence show` — fetch and render evidence from the registry. */
function registerShowSubcommand(cmd: Command): void {
  cmd
    .command('show')
    .description("Show a dossier's evidence sidecar from the registry")
    .argument('<name>', 'Dossier name (use name@version for a specific version)')
    .option('--json', 'Output the raw evidence record as JSON')
    .action(async (name: string, options: ShowOptions) => {
      const [dossierName, version] = parseNameVersion(name);
      const { result, errors } = await multiRegistryGetEvidence(dossierName, version || null);

      if (!result) {
        console.error(`❌ No evidence for ${name}`);
        printRegistryErrors(errors);
        process.exit(1);
      }

      let record: EvidenceRecord;
      try {
        record = parseEvidence(result.evidence);
      } catch (err: unknown) {
        console.error(`\n❌ Stored evidence record is corrupt: ${(err as Error).message}\n`);
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }

      console.log(
        `Evidence for ${record.dossier}@${record.version} (sha256:${record.checksum.hash})`
      );
      for (const entry of record.entries) {
        console.log(`• ${entry.anchor}`);
        console.log(`  ${entry.rationale}`);
        for (const ref of entry.evidence) {
          let line = `  refs: ${ref.provider}:${ref.session}`;
          if (ref.event) line += `#${ref.event}`;
          if (ref.host) line += ` @${ref.host}`;
          if (ref.extra) {
            for (const [key, value] of Object.entries(ref.extra)) {
              line += ` ${key}=${value}`;
            }
          }
          console.log(line);
        }
      }
    });
}

/** `evidence init` — create a fresh sidecar next to a dossier file. */
function registerInitSubcommand(cmd: Command): void {
  cmd
    .command('init')
    .description('Create a fresh evidence sidecar for a dossier file')
    .argument('<file>', 'Dossier file (.ds.md)')
    .option('--namespace <namespace>', 'Override namespace (e.g., imboard-ai/skills)')
    .option('-o, --output <path>', 'Output path (defaults to a sibling .evidence.json)')
    .option('--force', 'Overwrite an existing sidecar')
    .action((file: string, options: InitOptions) => {
      const outputPath = options.output ? path.resolve(options.output) : siblingEvidencePath(file);

      if (fs.existsSync(outputPath) && !options.force) {
        console.error(
          `\n❌ Evidence file already exists: ${outputPath} (use --force to overwrite)\n`
        );
        process.exit(1);
      }

      const identity = deriveIdentity(file);
      const ns = resolveDossierNamespace(undefined, options.namespace);
      const record = createEvidenceRecord({
        dossier: `${ns}/${identity.name}`,
        version: identity.frontmatter.version,
        checksumHash: identity.checksumHash,
      });
      writeSidecarAtomic(outputPath, record);
      console.log(`✅ Evidence sidecar created: ${outputPath}`);
    });
}

/** `evidence add` — append an entry, creating the sidecar via `init` logic if absent. */
function registerAddSubcommand(cmd: Command): void {
  cmd
    .command('add')
    .description('Append an evidence entry to a dossier’s sidecar')
    .argument('<file>', 'Dossier file (.ds.md)')
    .requiredOption('--anchor <text>', 'Rule/heading in the dossier body this entry documents')
    .requiredOption('--rationale <text>', 'Why the rule/section reads the way it does')
    .option(
      '--session <id>',
      'Provider-native session id (defaults to AI_DOSSIER_SESSION_ID, then — for claude-code — the newest transcript under ~/.claude/projects)'
    )
    .addOption(
      new Option('--provider <provider>', 'Agent provider')
        .choices(EVIDENCE_PROVIDERS)
        .default('claude-code')
    )
    .option('--event <id>', 'Provider-native per-message/tool-call id')
    .option('--host <name>', 'Machine the session ran on (defaults to os.hostname())')
    .option('--extra <k=v...>', 'Tool-specific locator ids, repeatable')
    .option(
      '--namespace <namespace>',
      'Override namespace (rewrites the sidecar’s dossier field; preserved across runs otherwise)'
    )
    .option(
      '--force-session',
      'Bypass session-id shape validation (for a provider whose session ids are genuinely not UUIDs)'
    )
    .action((file: string, options: AddOptions) => {
      const sidecarPath = siblingEvidencePath(file);
      const identity = deriveIdentity(file);

      let record: EvidenceRecord = fs.existsSync(sidecarPath)
        ? loadSidecar(sidecarPath)
        : createEvidenceRecord({
            dossier: `${resolveDossierNamespace(undefined, options.namespace)}/${identity.name}`,
            version: identity.frontmatter.version,
            checksumHash: identity.checksumHash,
          });

      const resolved = resolveSession(options);
      if (!resolved) {
        const slug = process.cwd().replace(/\//g, '-');
        const hint =
          options.provider === 'claude-code'
            ? ` (looked for a transcript under ~/.claude/projects/${slug}/, and any project dir modified in the last hour — found none)`
            : '';
        console.error(`\n❌ --session required (or set AI_DOSSIER_SESSION_ID)${hint}\n`);
        process.exit(1);
      }
      const { session } = resolved;
      if (resolved.source !== 'flag') {
        const sourceLabel =
          resolved.source === 'env'
            ? 'AI_DOSSIER_SESSION_ID'
            : resolved.source === 'transcript-fallback'
              ? `newest transcript — ${resolved.dir}, not this project's dir; pass --session explicitly if wrong`
              : 'newest transcript';
        console.log(`ℹ️  session=${session} (from ${sourceLabel})`);
      }
      validateSessionShape(session, options.provider, options.forceSession);
      warnIfImperativeRationale(options.rationale);

      const extra = parseExtra(options.extra);
      const ref: EvidenceRef = {
        provider: options.provider,
        session,
        ...(options.event ? { event: options.event } : {}),
        host: options.host || os.hostname(),
        ...(extra ? { extra } : {}),
      };

      record = {
        ...record,
        entries: [
          ...record.entries,
          {
            anchor: options.anchor,
            rationale: options.rationale,
            created_at: new Date().toISOString(),
            evidence: [ref],
          },
        ],
      };
      record = applyIdentity(record, identity, options.namespace);

      const errors = validateEvidence(record);
      if (errors.length > 0) {
        console.error('\n❌ Invalid evidence record:');
        for (const error of errors) {
          console.error(`   - ${error}`);
        }
        console.error('');
        process.exit(1);
      }

      writeSidecarAtomic(sidecarPath, record);
      console.log(
        `✅ Evidence entry added (dossier=${record.dossier} version=${record.version}, ${record.entries.length} entries)`
      );
    });
}

interface SyncOptions {
  namespace?: string;
}

/** `evidence sync` — refresh dossier/version/checksum from the dossier's current frontmatter. */
function registerSyncSubcommand(cmd: Command): void {
  cmd
    .command('sync')
    .description(
      "Refresh a sidecar's dossier/version/checksum from the dossier's current frontmatter"
    )
    .argument('<file>', 'Dossier file (.ds.md)')
    .option(
      '--namespace <namespace>',
      'Rewrite the dossier namespace (otherwise the sidecar’s existing namespace is preserved)'
    )
    .action((file: string, options: SyncOptions) => {
      const sidecarPath = siblingEvidencePath(file);
      if (!fs.existsSync(sidecarPath)) {
        console.error(`\n❌ Evidence file not found: ${sidecarPath}\n`);
        process.exit(1);
      }

      const identity = deriveIdentity(file);
      if (!identity.frontmatter.checksum?.hash) {
        // sync always runs after `sign` (which restores the checksum) — unlike `add`/`init`,
        // a missing checksum here is a real problem, not the publish-dossier Step 2/3 gap.
        console.error(
          `\n❌ ${file} has no checksum in frontmatter; run 'ai-dossier checksum ${file} --update' or sign it first\n`
        );
        process.exit(1);
      }

      let record = loadSidecar(sidecarPath);
      record = applyIdentity(record, identity, options.namespace);

      const errors = validateEvidence(record);
      if (errors.length > 0) {
        console.error('\n❌ Invalid evidence record:');
        for (const error of errors) {
          console.error(`   - ${error}`);
        }
        console.error('');
        process.exit(1);
      }

      writeSidecarAtomic(sidecarPath, record);
      console.log(
        `✅ Evidence synced: dossier=${record.dossier} version=${record.version} hash=${record.checksum.hash}`
      );
    });
}

/** `evidence validate` — deterministic schema validation of a sidecar file. */
function registerValidateSubcommand(cmd: Command): void {
  cmd
    .command('validate')
    .description('Validate an evidence sidecar file against the schema')
    .argument('<file>', 'Evidence sidecar file (.evidence.json)')
    .action((file: string) => {
      if (!fs.existsSync(file)) {
        console.error(`\n❌ File not found: ${file}\n`);
        process.exit(1);
      }
      try {
        parseEvidence(fs.readFileSync(file, 'utf8'));
      } catch (err: unknown) {
        console.error(`❌ ${(err as Error).message}`);
        process.exit(1);
      }
      console.log('✅ valid');
    });
}

/** Registers the `evidence` command tree (show, init, add, sync, validate). */
export function registerEvidenceCommand(program: Command): void {
  const evidenceCmd = program
    .command('evidence')
    .description("Author, attach, fetch and display a dossier's evidence sidecar");

  registerShowSubcommand(evidenceCmd);
  registerInitSubcommand(evidenceCmd);
  registerAddSubcommand(evidenceCmd);
  registerSyncSubcommand(evidenceCmd);
  registerValidateSubcommand(evidenceCmd);
}
