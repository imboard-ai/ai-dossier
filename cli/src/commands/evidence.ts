/**
 * `ai-dossier evidence` — author, attach, fetch and display a dossier's `.evidence.json`
 * sidecar (RFC-0001 authoring evidence, #733/#734/#735). Never loaded by `ai-dossier run`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
}

/** Providers `evidence add` accepts — mirrors the schema's `evidence[].provider` enum. */
const EVIDENCE_PROVIDERS: EvidenceRef['provider'][] = [
  'claude-code',
  'codex',
  'opencode',
  'gemini-cli',
  'other',
];

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

/** Build a fresh evidence record for a dossier file, per `init`'s rules. */
function buildFreshRecord(dossierFile: string, namespace?: string): EvidenceRecord {
  const { frontmatter } = readDossier(dossierFile);

  if (!frontmatter.checksum?.hash) {
    console.error(
      "\n❌ Dossier has no checksum; run 'ai-dossier checksum <file> --update' or sign it first\n"
    );
    process.exit(1);
  }

  const ns = resolveNamespace(namespace);
  const name = frontmatter.name || frontmatter.title || path.basename(dossierFile, '.ds.md');
  const fullPath = `${ns}/${name}`;

  return createEvidenceRecord({
    dossier: fullPath,
    version: frontmatter.version,
    checksumHash: frontmatter.checksum.hash,
  });
}

/** Refresh `record.version` and `record.checksum.hash` from the dossier's current frontmatter. */
function refreshFromFrontmatter(record: EvidenceRecord, dossierFile: string): EvidenceRecord {
  const { frontmatter } = readDossier(dossierFile);
  if (!frontmatter.checksum?.hash) {
    console.error(
      "\n❌ Dossier has no checksum; run 'ai-dossier checksum <file> --update' or sign it first\n"
    );
    process.exit(1);
  }
  return {
    ...record,
    version: frontmatter.version,
    checksum: { algorithm: 'sha256', hash: frontmatter.checksum.hash },
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

      const record = buildFreshRecord(file, options.namespace);
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
    .option('--session <id>', 'Provider-native session id (defaults to AI_DOSSIER_SESSION_ID)')
    .addOption(
      new Option('--provider <provider>', 'Agent provider')
        .choices(EVIDENCE_PROVIDERS)
        .default('claude-code')
    )
    .option('--event <id>', 'Provider-native per-message/tool-call id')
    .option('--host <name>', 'Machine the session ran on (defaults to os.hostname())')
    .option('--extra <k=v...>', 'Tool-specific locator ids, repeatable')
    .option('--namespace <namespace>', 'Override namespace when creating a fresh sidecar')
    .action((file: string, options: AddOptions) => {
      const sidecarPath = siblingEvidencePath(file);

      let record: EvidenceRecord = fs.existsSync(sidecarPath)
        ? loadSidecar(sidecarPath)
        : buildFreshRecord(file, options.namespace);

      const session = options.session || process.env.AI_DOSSIER_SESSION_ID;
      if (!session) {
        console.error('\n❌ --session required (or set AI_DOSSIER_SESSION_ID)\n');
        process.exit(1);
      }

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
      record = refreshFromFrontmatter(record, file);

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
      console.log(`✅ Evidence entry added (${record.entries.length} entries)`);
    });
}

/** `evidence sync` — refresh version/checksum from the dossier's current frontmatter. */
function registerSyncSubcommand(cmd: Command): void {
  cmd
    .command('sync')
    .description("Refresh a sidecar's version/checksum from the dossier's current frontmatter")
    .argument('<file>', 'Dossier file (.ds.md)')
    .action((file: string) => {
      const sidecarPath = siblingEvidencePath(file);
      if (!fs.existsSync(sidecarPath)) {
        console.error(`\n❌ Evidence file not found: ${sidecarPath}\n`);
        process.exit(1);
      }

      let record = loadSidecar(sidecarPath);
      record = refreshFromFrontmatter(record, file);

      writeSidecarAtomic(sidecarPath, record);
      console.log(`✅ Evidence synced: version=${record.version} hash=${record.checksum.hash}`);
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
