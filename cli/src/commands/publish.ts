import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  type DossierFrontmatter,
  type EvidenceEntry,
  type EvidenceRecord,
  evidenceMatchesDossier,
  parseDossierContent,
  parseEvidence,
  sha256Hex,
  validateFrontmatter,
} from '@ai-dossier/core';
import type { Command } from 'commander';
import { collectRepeatable, siblingEvidencePath } from '../helpers';
import { getClientForRegistry } from '../registry-client';
import { handleRegistryWriteError, requireWriteAuth } from '../write-auth';

/** How long to wait for the previous version's evidence sidecar before giving up on it. */
const EVIDENCE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Anchors from the PREVIOUS published version's evidence sidecar whose section still exists
 * in the new dossier body, but whose entry is missing from the new sidecar being published.
 * Silent by construction for an anchor whose section was removed — it's excluded before the
 * "missing from the new sidecar" check even runs. See #817 (batch-integrate 1.4.0: 5 of 7
 * evidence entries silently dropped even though their sections survived, restored in 1.5.1).
 *
 * `anchor` is matched as a plain substring of the body, not against extracted headings —
 * this mirrors how the rest of the evidence system treats an anchor (free text "written
 * exactly as it appears in the dossier body" per authoring-evidence.md, never parsed as
 * markdown). Tightening this to heading-only matching would be a broader redefinition of
 * what an anchor is, not a fix scoped to this check.
 */
export function findDroppedEvidenceAnchors(
  previousEntries: EvidenceEntry[],
  newBody: string,
  newEntries: EvidenceEntry[]
): string[] {
  const newAnchors = new Set(newEntries.map((entry) => entry.anchor));
  return previousEntries
    .filter((entry) => newBody.includes(entry.anchor) && !newAnchors.has(entry.anchor))
    .map((entry) => entry.anchor);
}

/** Strip control/escape characters before echoing an untrusted string (a registry-sourced
 * anchor or error message) to the terminal — defends against terminal/ANSI injection from a
 * evidence sidecar the local user did not author. */
function sanitizeForDisplay(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping them
  return value.replace(/[\x00-\x1f\x7f]/g, '');
}

/** Race a promise against a timeout, rejecting with `message` if it loses. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Resolve, read, and validate the evidence sidecar to attach to a publish — the sibling
 * `.evidence.json` by default, an explicit `--evidence <path>`, or none under `--no-evidence`.
 * Exits the process (with a `❌` message) on a missing explicit file, an unparsable sidecar,
 * or one that does not match the dossier being published. Returns both the raw text (sent to
 * the registry as-is) and the already-parsed record, so callers never need to re-parse it.
 */
function resolveEvidenceForPublish(
  dossierFile: string,
  evidenceOption: string | false | undefined,
  frontmatter: DossierFrontmatter,
  fullPath: string
): { raw: string; record: EvidenceRecord } | null {
  if (evidenceOption === false) return null;

  const explicitEvidencePath = typeof evidenceOption === 'string';
  const evidencePath = explicitEvidencePath
    ? path.resolve(evidenceOption as string)
    : siblingEvidencePath(dossierFile);

  if (!fs.existsSync(evidencePath)) {
    if (explicitEvidencePath) {
      console.error(`\n❌ Evidence file not found: ${evidencePath}\n`);
      process.exit(1);
    }
    return null;
  }

  const rawEvidence = fs.readFileSync(evidencePath, 'utf8');
  let evidenceRecord: EvidenceRecord;
  try {
    evidenceRecord = parseEvidence(rawEvidence);
  } catch (err: unknown) {
    console.error(`\n❌ Invalid evidence file: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const mismatches = evidenceMatchesDossier(evidenceRecord, frontmatter, fullPath);
  if (mismatches.length > 0) {
    console.error('\n❌ Evidence does not match dossier:');
    for (const mismatch of mismatches) {
      console.error(`   - ${mismatch}`);
    }
    console.error("\n   Run 'ai-dossier evidence sync <file>' to update version/checksum\n");
    process.exit(1);
  }

  return { raw: rawEvidence, record: evidenceRecord };
}

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publish a dossier to the registry')
    .argument('<file>', 'Dossier file to publish')
    .option('--changelog <message>', 'Changelog message for this version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--namespace <namespace>', 'Override namespace (e.g., imboard-ai/skills)')
    .option('--registry <name>', 'Target registry to publish to')
    .option(
      '--evidence <path>',
      'Attach an evidence sidecar (defaults to a sibling .evidence.json)'
    )
    .option('--no-evidence', 'Skip attaching evidence, even if a sibling sidecar exists')
    .option(
      '--drop-evidence <anchor>',
      'Acknowledge intentionally dropping the evidence entry for this anchor (repeatable)',
      collectRepeatable,
      [] as string[]
    )
    .option('--json', 'Output as JSON')
    .action(
      async (
        file: string,
        options: {
          changelog?: string;
          yes?: boolean;
          namespace?: string;
          registry?: string;
          evidence?: string | false;
          dropEvidence: string[];
          json?: boolean;
        }
      ) => {
        const { targetRegistry, credentials } = requireWriteAuth({
          registryFlag: options.registry,
          json: options.json,
          jsonResultKey: 'published',
        });

        const dossierFile = path.resolve(file);
        if (!fs.existsSync(dossierFile)) {
          console.error(`\n❌ File not found: ${dossierFile}\n`);
          process.exit(1);
        }

        const content = fs.readFileSync(dossierFile, 'utf8');

        let frontmatter: DossierFrontmatter;
        let body: string;
        try {
          const parsed = parseDossierContent(content);
          frontmatter = parsed.frontmatter;
          body = parsed.body;
        } catch (err: unknown) {
          console.error(`\n❌ ${(err as Error).message}\n`);
          process.exit(1);
        }

        const errors = validateFrontmatter(frontmatter as DossierFrontmatter);
        if (errors.length > 0) {
          console.error('\n❌ Validation errors:');
          for (const err of errors) {
            console.error(`   - ${err}`);
          }
          console.error('');
          process.exit(1);
        }

        const existingHash = frontmatter.checksum?.hash;
        if (existingHash) {
          const actualHash = sha256Hex(body);
          if (existingHash !== actualHash) {
            console.error(
              '\n❌ Checksum mismatch - content has been modified without updating checksum'
            );
            console.error(`   Expected: ${existingHash}`);
            console.error(`   Actual:   ${actualHash}`);
            console.error(`\n   Run 'dossier checksum ${file} --update' to fix\n`);
            process.exit(1);
          }
        }

        const namespace =
          options.namespace ||
          (credentials.orgs.length > 0 ? credentials.orgs[0] : credentials.username);
        const name = frontmatter.name || frontmatter.title || path.basename(dossierFile, '.ds.md');
        const version = frontmatter.version || 'unknown';
        const fullPath = `${namespace}/${name}`;
        const registryPath = `${fullPath}@${version}`;

        // Resolve, read, and validate the evidence sidecar (if one is going to be sent).
        const evidence = resolveEvidenceForPublish(
          dossierFile,
          options.evidence,
          frontmatter,
          fullPath
        );

        // Pre-publish existence check — version-specific via registry API
        const client = getClientForRegistry(targetRegistry.url, credentials.token);
        let existingVersion: string | null = null;
        let versionExists = false;
        try {
          const existing = await client.getDossier(fullPath, version);
          if (existing && existing.version === version) {
            versionExists = true;
          }
        } catch {
          // 404 = version doesn't exist (expected), other errors = warn but don't block
        }

        if (versionExists) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  published: false,
                  error: `${registryPath} already exists`,
                  code: 'version_exists',
                  name: fullPath,
                  version,
                },
                null,
                2
              )
            );
          } else {
            console.error(`\n❌ Version collision: ${registryPath} already exists.`);
            console.error('   Bump the version in your dossier and try again.\n');
          }
          process.exit(1);
          return;
        }

        // Check if dossier exists at any version (for overwrite warning)
        try {
          const existing = await client.getDossier(fullPath);
          if (existing) {
            existingVersion = existing.version || null;
          }
        } catch {
          // Ignore — dossier doesn't exist or check failed
        }

        // Evidence-regression check (#817): compare the sidecar about to be published against
        // the PREVIOUS published version's sidecar. Never blocks the publish when the previous
        // sidecar can't be established — first publish, no prior evidence, a fetch timeout, or
        // any other fetch failure (offline) all skip with an informational note (`evidenceCheck`)
        // instead, which is also what carries the outcome through to the --json result below.
        //
        // The fetch/parse of the PREVIOUS sidecar is the only part wrapped in try/catch —
        // `droppedAnchors` stays `null` (meaning "nothing to check") on any failure there. The
        // block-or-proceed decision below runs outside that try, so `process.exit(1)` is never
        // caught by the fetch-failure handler.
        let droppedAnchors: string[] | null = null;
        let evidenceCheck: { status: string; reason?: string } = { status: 'skipped' };
        if (!existingVersion) {
          evidenceCheck = { status: 'skipped', reason: 'first-publish' };
          if (!options.json) {
            console.log(`\nℹ️  First publish of ${fullPath} — skipping evidence-regression check\n`);
          }
        } else {
          try {
            const previous = await withTimeout(
              client.getDossierEvidence(fullPath, existingVersion),
              EVIDENCE_FETCH_TIMEOUT_MS,
              `timed out after ${EVIDENCE_FETCH_TIMEOUT_MS / 1000}s fetching previous evidence`
            );
            const previousRecord = parseEvidence(previous.evidence);
            const newEntries = evidence ? evidence.record.entries : [];
            droppedAnchors = findDroppedEvidenceAnchors(previousRecord.entries, body, newEntries);
            // evidenceCheck is finalized just below, once we know clean vs. overridden vs. blocked.
          } catch (err: unknown) {
            const is404 = (err as { statusCode?: number }).statusCode === 404;
            const reason = is404 ? 'no-prior-evidence' : 'fetch-failed';
            evidenceCheck = { status: 'skipped', reason };
            if (!options.json) {
              const detail = is404
                ? `No evidence recorded for ${fullPath}@${existingVersion}`
                : `Could not establish previous evidence for ${fullPath}@${existingVersion} (${sanitizeForDisplay((err as Error).message)})`;
              console.log(`\nℹ️  ${detail} — skipping evidence-regression check\n`);
            }
          }
        }

        if (droppedAnchors && droppedAnchors.length > 0 && existingVersion) {
          const dropOverrides = new Set(options.dropEvidence);
          const blockedAnchors = droppedAnchors.filter((anchor) => !dropOverrides.has(anchor));
          const acknowledgedAnchors = droppedAnchors.filter((anchor) => dropOverrides.has(anchor));

          if (blockedAnchors.length > 0) {
            if (options.json) {
              console.log(
                JSON.stringify(
                  {
                    published: false,
                    error:
                      'Evidence entries dropped for anchor(s) still present in the new dossier',
                    code: 'evidence_regression',
                    name: fullPath,
                    version,
                    previous_version: existingVersion,
                    anchors: blockedAnchors,
                  },
                  null,
                  2
                )
              );
            } else {
              const noun = blockedAnchors.length === 1 ? 'entry' : 'entries';
              console.error(
                `\n❌ Evidence ${noun} dropped for anchor(s) still present in the new dossier:`
              );
              for (const anchor of blockedAnchors) {
                console.error(`   - "${sanitizeForDisplay(anchor)}"`);
              }
              console.error(
                `\n   These anchors have evidence in ${fullPath}@${existingVersion} but not in this publish's sidecar, even though their sections remain in the body.`
              );
              console.error(
                '   Re-add the entries (ai-dossier evidence add), or pass --drop-evidence "<anchor>" once per anchor to confirm the drop is intentional.\n'
              );
            }
            process.exit(1);
            return;
          }

          evidenceCheck = { status: 'overridden' };
          if (!options.json) {
            console.log(
              `\nℹ️  Dropping evidence for ${acknowledgedAnchors.length} anchor(s) as confirmed via --drop-evidence: ${acknowledgedAnchors.map((anchor) => `"${sanitizeForDisplay(anchor)}"`).join(', ')}\n`
            );
          }
        } else if (droppedAnchors) {
          evidenceCheck = { status: 'clean' };
        }

        if (!options.yes) {
          if (!process.stdin.isTTY) {
            console.error(
              '\n❌ Non-interactive session detected. Use -y/--yes to skip confirmation.\n'
            );
            process.exit(1);
          }

          console.log('\n📦 Publishing dossier:\n');
          console.log(`   Registry:  ${targetRegistry.name} (${targetRegistry.url})`);
          console.log(`   Path:      ${registryPath}`);
          console.log(`   File:      ${path.basename(dossierFile)}`);
          if (options.changelog) {
            console.log(`   Changelog: ${options.changelog}`);
          }
          if (existingVersion) {
            console.log(
              `\n   ⚠️  ${fullPath} already exists (latest: v${existingVersion}). Publishing will add v${version}.`
            );
          }
          console.log('');

          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          const answer = await new Promise<string>((resolve) => {
            rl.question('Proceed with publishing? (y/N) ', resolve);
          });
          rl.close();

          if (answer.toString().toLowerCase() !== 'y') {
            console.log('\nAborted.\n');
            process.exit(0);
          }
        }

        try {
          const result = await client.publishDossier(
            namespace,
            content,
            options.changelog || null,
            evidence ? evidence.raw : null
          );

          const verifyCommand = `dossier info ${fullPath}@${version}`;
          const cdnDelaySeconds = 30;

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  published: true,
                  name: result.name || fullPath,
                  version,
                  registry: targetRegistry.name,
                  content_url: result.content_url || null,
                  evidence_url: result.evidence_url || null,
                  evidence_check: evidenceCheck,
                  verification: {
                    verify_command: verifyCommand,
                    cdn_delay_seconds: cdnDelaySeconds,
                  },
                },
                null,
                2
              )
            );
          } else {
            console.log(`\n✅ Published ${registryPath} [${targetRegistry.name}]`);
            if (existingVersion) {
              console.log(`   Updated from v${existingVersion}`);
            }
            if (result.content_url) {
              console.log(`   URL: ${result.content_url}`);
            }
            if (result.evidence_url) {
              console.log(`   Evidence: ${result.evidence_url}`);
            }
            console.log(
              `\n   ⏳ CDN propagation may take up to ${cdnDelaySeconds}s. Verify with:\n   $ ${verifyCommand}\n`
            );
          }
        } catch (err: unknown) {
          handleRegistryWriteError(err, {
            json: options.json,
            jsonResultKey: 'published',
            actionLabel: 'Publish',
          });
        }
      }
    );
}
