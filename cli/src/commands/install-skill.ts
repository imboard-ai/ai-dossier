import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDossierContent } from '@ai-dossier/core';
import type { Command } from 'commander';
import {
  parseMaxAgeOption,
  readCachedContent,
  resolveCachedVersion,
  writeCachedContent,
} from '../cache-resolver';
import { multiRegistryGetContent, multiRegistryList } from '../multi-registry';
import {
  isDossierFrontmatter,
  listOpencodeSkills,
  OPENCODE_SKILLS_DIR,
  removeOpencodeWrapper,
  resolveTargets,
  type SyncTarget,
  writeOpencodeWrapper,
} from '../opencode-sync';
import { parseNameVersion } from '../registry-client';
import { checkSkillCollision, collisionMessage, writeSourceSidecar } from '../skill-collision';
import { toSkillFrontmatter } from '../skill-frontmatter';
import {
  classify,
  type InstalledSkill,
  type PlanItem,
  planSync,
  type RegistrySkill,
  readInstalledSkills,
  type SkillStatus,
} from '../skill-sync';

/** Valid values for --for. Anything else is rejected up front. */
const VALID_TARGETS = new Set<SyncTarget>(['claude', 'opencode', 'both']);

interface InstallCtx {
  skillsDir: string;
  targets: ReturnType<typeof resolveTargets>;
  fresh?: boolean;
  maxAge?: string;
}

interface InstallResult {
  skillName: string;
  skillFile: string;
  source: string;
  version: string | null;
  fileSize: number;
  summary: string;
  cached: boolean;
  opencode: 'created' | 'updated' | 'unchanged' | 'skipped' | 'off';
}

/**
 * Fetch one dossier and write it as a skill (claude and/or opencode copy), recording its
 * registry path (`x_source` in a legacy copy's frontmatter, and `SOURCE_SIDECAR` beside
 * it). Throws on any failure; callers decide how to report it.
 */
async function installOne(
  dossierName: string,
  version: string | undefined,
  ctx: InstallCtx
): Promise<InstallResult> {
  const skillName = dossierName.split('/').pop() ?? dossierName;
  const skillDir = path.join(ctx.skillsDir, skillName);
  const skillFile = path.join(skillDir, 'SKILL.md');
  let resolvedVersion = version;

  // For versionless installs: resolve which version to use via the TTL'd resolver.
  if (!version) {
    const maxAgeSeconds = parseMaxAgeOption(ctx.maxAge);
    const resolved = await resolveCachedVersion(dossierName, {
      fresh: ctx.fresh,
      maxAgeSeconds,
    });
    resolvedVersion = resolved.version;
  }

  let content: string | null = null;
  let fromCache = false;

  if (!ctx.fresh) {
    const cached = readCachedContent(dossierName, resolvedVersion as string);
    if (cached !== null) {
      content = cached;
      fromCache = true;
    }
  }

  if (!content) {
    const { result: fetchedContent } = await multiRegistryGetContent(dossierName, resolvedVersion);
    if (!fetchedContent) {
      throw { statusCode: 404, message: `Not found: ${dossierName}` };
    }
    content = fetchedContent.content;
    // Write to cache so future installs hit it.
    if (!ctx.fresh) {
      writeCachedContent(dossierName, resolvedVersion as string, content, fetchedContent._registry);
    }
  }

  // Write the primary claude skill. Always true today; the flag exists so
  // future flows (e.g. opencode-only refreshes via sync-skills) can opt out.
  if (ctx.targets.writeClaude) {
    fs.mkdirSync(skillDir, { recursive: true });
    // Emit YAML frontmatter so the runtime can read `name`/`description`: a legacy
    // dossier is re-serialized, a spec-shaped one copied as is. The signed payload
    // is unchanged either way — see skill-frontmatter.ts.
    fs.writeFileSync(skillFile, toSkillFrontmatter(content, dossierName), 'utf8');
    // A spec-shaped copy cannot carry `x_source`; record provenance beside it.
    writeSourceSidecar(skillDir, dossierName);
  }

  // Dual-write the opencode wrapper when requested. YAML-native sources are
  // skipped because opencode reads them directly from ~/.claude/skills/.
  let opencode: InstallResult['opencode'] = 'off';
  if (ctx.targets.writeOpencode) {
    opencode = writeOpencodeWrapper(skillName, content, dossierName);
  }

  let summary = '';
  try {
    const parsed = parseDossierContent(content);
    const fm = parsed.frontmatter as Record<string, unknown>;
    summary = (fm.objective as string) || '';
    if (!summary) {
      const firstLine = parsed.body.split('\n').find((l) => l.trim().length > 0);
      summary = firstLine?.replace(/^#+\s*/, '').trim() || '';
    }
  } catch {
    // Could not parse — skip summary
  }

  return {
    skillName,
    skillFile,
    source: dossierName,
    version: resolvedVersion || null,
    fileSize: Buffer.byteLength(content, 'utf8'),
    summary,
    cached: fromCache,
    opencode,
  };
}

const LIST_PAGE_SIZE = 500;
const LIST_MAX_PAGES = 20;

/**
 * Every dossier the configured registries list, paginated. Throws when nothing could be
 * listed at all; partial registry failures are returned so the caller can warn.
 */
async function fetchRegistryDossiers(): Promise<{
  dossiers: RegistrySkill[];
  errors: Array<{ registry: string; error: string }>;
}> {
  const seen = new Map<string, RegistrySkill>();
  const errors: Array<{ registry: string; error: string }> = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const res = await multiRegistryList({ page, perPage: LIST_PAGE_SIZE });
    for (const e of res.errors) {
      if (!errors.some((x) => x.registry === e.registry)) errors.push(e);
    }
    let added = 0;
    for (const d of res.dossiers) {
      if (seen.has(d.name)) continue;
      seen.set(d.name, {
        name: d.name,
        version: d.version,
        tags: d.tags,
      });
      added++;
    }
    if (added === 0 || res.dossiers.length < LIST_PAGE_SIZE) break;
  }
  if (seen.size === 0 && errors.length > 0) {
    throw new Error(errors.map((e) => `${e.registry}: ${e.error}`).join('; '));
  }
  return { dossiers: [...seen.values()], errors };
}

interface BatchOptions {
  all?: boolean;
  outdated?: boolean;
  owner?: string;
  force?: boolean;
  fresh?: boolean;
  maxAge?: string;
  json?: boolean;
}

interface BatchRow {
  name: string;
  skill: string;
  status: 'ok' | 'skipped' | 'failed' | 'collision';
  installedVersion: string | null;
  version: string | null;
  message?: string;
}

/** `--all` / `--outdated`: plan against the registry, install what the plan says, report each. */
async function runBatchInstall(opts: BatchOptions, ctx: InstallCtx): Promise<void> {
  const fail = (message: string): never => {
    if (opts.json) console.log(JSON.stringify({ success: false, error: message }, null, 2));
    else console.error(`\n❌ ${message}\n`);
    process.exit(1);
  };

  let registry: RegistrySkill[];
  try {
    const listed = await fetchRegistryDossiers();
    registry = listed.dossiers;
    if (!opts.json) {
      for (const e of listed.errors) console.error(`⚠️  Registry ${e.registry}: ${e.error}`);
    }
  } catch (err) {
    return fail(`Could not list registry: ${(err as Error).message}`);
  }

  const plan = planSync({
    registry,
    installed: readInstalledSkills(ctx.skillsDir),
    skillsDir: ctx.skillsDir,
    owner: opts.owner,
    all: !!opts.all,
    outdated: !!opts.outdated,
    force: opts.force,
  });

  const rows: BatchRow[] = [];
  for (const item of plan as PlanItem[]) {
    const base = {
      name: item.name,
      skill: item.skill,
      installedVersion: item.installedVersion ?? null,
      version: item.latestVersion ?? null,
    };
    if (item.action === 'collision') {
      rows.push({ ...base, status: 'collision', message: item.reason });
      continue;
    }
    if (item.action === 'skip') {
      rows.push({ ...base, status: 'skipped', message: item.reason });
      continue;
    }
    try {
      const r = await installOne(item.name, item.latestVersion, ctx);
      rows.push({ ...base, version: r.version, status: 'ok' });
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      rows.push({
        ...base,
        status: 'failed',
        message: e.statusCode === 404 ? 'not found in registry' : (e.message ?? String(err)),
      });
    }
  }

  const count = (s: BatchRow['status']) => rows.filter((r) => r.status === s).length;
  const summary = {
    ok: count('ok'),
    skipped: count('skipped'),
    failed: count('failed'),
    collisions: count('collision'),
  };
  const success = summary.failed === 0 && summary.collisions === 0;

  if (opts.json) {
    console.log(JSON.stringify({ success, summary, results: rows }, null, 2));
  } else {
    console.log('');
    if (rows.length === 0) console.log('No matching skills.');
    for (const r of rows) {
      const ver =
        r.installedVersion && r.version && r.installedVersion !== r.version
          ? `${r.installedVersion} -> ${r.version}`
          : (r.version ?? '');
      const tail = r.message ? ` — ${r.message}` : '';
      const tag =
        r.status === 'ok'
          ? 'ok'
          : r.status === 'skipped'
            ? 'skip'
            : r.status === 'failed'
              ? 'FAIL'
              : 'COLLISION';
      console.log(`  ${tag.padEnd(9)} ${r.name}${ver ? ` (${ver})` : ''}${tail}`);
    }
    console.log(
      `\n${summary.ok} installed, ${summary.skipped} skipped, ${summary.failed} failed, ${summary.collisions} collisions\n`
    );
  }
  process.exit(success ? 0 : 1);
}

/** Installed vs latest for one installed skill. */
function describeDrift(
  s: InstalledSkill,
  latestByName: Map<string, RegistrySkill> | null
): { status: SkillStatus; latest?: string } {
  if (!s.source) return { status: 'unknown-source' };
  const latest = latestByName?.get(s.source)?.version;
  return { status: classify(s.version, latest), latest };
}

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install a registry dossier as a Claude Code skill')
    .argument('[name]', 'Dossier name to install (use name@version for specific version)')
    .option('--force', 'Overwrite if skill already exists')
    .option('--fresh', 'Skip cache, fetch fresh from registry')
    .option(
      '--max-age <seconds>',
      'Max age of cached version resolution before re-checking the registry (default: 300, 0 = always check)'
    )
    .option('--list', 'List currently installed skills (with installed vs latest version)')
    .option(
      '--all',
      'Install/refresh every registry skill (a dossier named *-skill or tagged skill)'
    )
    .option(
      '--outdated',
      'Reinstall only skills whose registry version is newer (alone: installed skills with a recorded source)'
    )
    .option('--owner <owner>', 'Limit --all / --outdated / --list to one registry owner')
    .option('--remove <skill>', 'Remove an installed skill')
    .option(
      '--for <target>',
      'Install targets: claude | opencode | both (default: claude + auto-detect opencode)'
    )
    .option('--json', 'Output as JSON')
    .action(
      async (
        name: string | undefined,
        options: {
          force?: boolean;
          fresh?: boolean;
          maxAge?: string;
          list?: boolean;
          all?: boolean;
          outdated?: boolean;
          owner?: string;
          remove?: string;
          for?: string;
          json?: boolean;
        }
      ) => {
        const skillsDir = path.join(os.homedir(), '.claude', 'skills');

        // Validate --for early — surfaces typos before any I/O.
        if (options.for && !VALID_TARGETS.has(options.for as SyncTarget)) {
          console.error(
            `\n❌ Invalid --for value: ${options.for}. Must be one of: claude, opencode, both\n`
          );
          process.exit(1);
        }
        const targets = resolveTargets(options.for as SyncTarget | undefined);

        if (options.list) {
          const installedAll = readInstalledSkills(skillsDir).filter(
            (sk) => !options.owner || sk.source?.split('/')[0] === options.owner
          );

          if (installedAll.length === 0) {
            if (options.json) console.log(JSON.stringify({ skills: [] }, null, 2));
            else console.log('\nNo installed skills.\n');
            process.exit(0);
          }

          // Latest versions need the registry; if it is unreachable, --list still works offline.
          let latestByName: Map<string, RegistrySkill> | null = null;
          let registryError: string | undefined;
          try {
            const listed = await fetchRegistryDossiers();
            latestByName = new Map(listed.dossiers.map((d) => [d.name, d]));
          } catch (err) {
            registryError = (err as Error).message;
          }

          // Cross-reference opencode installs so we can badge dual-installed skills.
          const opencodeInstalled = new Set(listOpencodeSkills());

          const rows = installedAll.map((sk) => {
            const content = fs.readFileSync(path.join(skillsDir, sk.dir, 'SKILL.md'), 'utf8');
            let description = '';
            const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (yamlMatch) {
              const descMatch = yamlMatch[1].match(/description:\s*(.+?)(?:\n|$)/);
              if (descMatch) description = descMatch[1].trim();
            }
            const drift = describeDrift(sk, latestByName);
            return {
              skill: sk.dir,
              source: sk.source ?? null,
              installedVersion: sk.version ?? null,
              latestVersion: drift.latest ?? null,
              status: drift.status,
              targets: opencodeInstalled.has(sk.dir) ? ['claude', 'opencode'] : ['claude'],
              description,
            };
          });

          if (options.json) {
            console.log(
              JSON.stringify({ skills: rows, registryError: registryError ?? null }, null, 2)
            );
            process.exit(0);
          }

          console.log(`\n📋 Installed skills (${rows.length}):\n`);
          if (registryError) {
            console.log(`  (registry unreachable — latest versions unknown: ${registryError})\n`);
          }
          for (const r of rows) {
            const badge = r.targets.length > 1 ? ' [claude, opencode]' : ' [claude]';
            let drift = '';
            if (r.status === 'unknown-source') drift = ' — unknown source';
            else if (r.installedVersion || r.latestVersion) {
              drift = ` v${r.installedVersion ?? '?'}`;
              if (r.status === 'behind') drift += ` (latest ${r.latestVersion}) BEHIND`;
              else if (r.status === 'ahead') drift += ` (registry has ${r.latestVersion}) AHEAD`;
            }
            console.log(`  ${r.skill}${badge}${drift}`);
            if (r.description) {
              const snippet =
                r.description.length > 80 ? `${r.description.slice(0, 80)}...` : r.description;
              console.log(`  ${snippet}`);
            }
            console.log('');
          }
          process.exit(0);
        }

        if (options.remove) {
          const skillDir = path.join(skillsDir, options.remove);
          const claudePresent = fs.existsSync(skillDir);
          const opencodePresent = fs.existsSync(path.join(OPENCODE_SKILLS_DIR, options.remove));

          if (!claudePresent && !opencodePresent) {
            console.error(`\n❌ Skill not found: ${options.remove}\n`);
            process.exit(1);
          }

          if (claudePresent) {
            fs.rmSync(skillDir, { recursive: true, force: true });
          }
          const removedWrapper = removeOpencodeWrapper(options.remove);

          const parts: string[] = [];
          if (claudePresent) parts.push('claude');
          if (removedWrapper) parts.push('opencode');
          console.log(`\n✅ Removed skill: ${options.remove} (${parts.join(', ')})\n`);
          process.exit(0);
        }

        if (options.all || options.outdated) {
          if (name) {
            console.error(
              '\n❌ --all / --outdated install by registry listing; do not pass a name\n'
            );
            process.exit(1);
          }
          await runBatchInstall(
            { ...options },
            { skillsDir, targets, fresh: options.fresh, maxAge: options.maxAge }
          );
          return;
        }
        if (options.owner) {
          console.error('\n❌ --owner only applies with --all, --outdated or --list\n');
          process.exit(1);
        }

        if (!name) {
          console.error(
            '\n❌ Please provide a dossier name to install, or use --all / --outdated / --list / --remove\n'
          );
          process.exit(1);
        }

        const [dossierName, version] = parseNameVersion(name);
        const skillName = dossierName.split('/').pop() ?? dossierName;
        const skillDir = path.join(skillsDir, skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');

        // Reinstalling or upgrading the SAME dossier is the common case and should not
        // need --force; requiring it there taught everyone to pass --force reflexively,
        // which is precisely what made the dangerous case dangerous. A DIFFERENT dossier
        // occupying the directory (two registry paths sharing a basename) still stops,
        // and now says which one it is instead of just "already installed".
        if (fs.existsSync(skillFile)) {
          const collision = checkSkillCollision(skillFile, dossierName);
          if (collision.collides && !options.force) {
            console.error(
              collisionMessage(
                skillName,
                collision.existingSource as string,
                dossierName,
                skillFile
              )
            );
            process.exit(1);
          }
        }

        try {
          const r = await installOne(dossierName, version ?? undefined, {
            skillsDir,
            targets,
            fresh: options.fresh,
            maxAge: options.maxAge,
          });
          const { fileSize, summary, opencode: opencodeResult } = r;
          const resolvedVersion = r.version;
          const fromCache = r.cached;

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  skill: skillName,
                  source: dossierName,
                  version: resolvedVersion || null,
                  location: skillFile,
                  fileSize,
                  summary: summary || null,
                  cached: fromCache,
                  opencode: opencodeResult,
                  opencodeLocation:
                    opencodeResult !== 'off' && opencodeResult !== 'skipped'
                      ? path.join(OPENCODE_SKILLS_DIR, skillName, 'SKILL.md')
                      : null,
                },
                null,
                2
              )
            );
          } else {
            console.log(
              `\n✅ Installed skill '${skillName}'${resolvedVersion ? ` (v${resolvedVersion})` : ''}`
            );
            console.log(`   Location: ${skillFile}`);
            console.log(`   Source: ${dossierName}`);
            console.log(`   Size: ${fileSize} bytes`);
            if (summary) {
              const snippet = summary.length > 80 ? `${summary.slice(0, 80)}...` : summary;
              console.log(`   Summary: ${snippet}`);
            }
            if (opencodeResult === 'created' || opencodeResult === 'updated') {
              console.log(
                `   opencode: ${opencodeResult} at ${path.join(OPENCODE_SKILLS_DIR, skillName, 'SKILL.md')}`
              );
            } else if (opencodeResult === 'unchanged') {
              console.log('   opencode: unchanged (already in sync)');
            } else if (opencodeResult === 'skipped') {
              // Source was YAML-native — opencode reads the claude copy directly.
              console.log('   opencode: source is YAML — no wrapper needed');
            }
            console.log('');
          }
        } catch (err: unknown) {
          const e = err as { statusCode?: number; message: string };
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  success: false,
                  error: e.statusCode === 404 ? 'not_found' : 'install_failed',
                  message: e.statusCode === 404 ? `Not found: ${name}` : e.message,
                },
                null,
                2
              )
            );
          } else if (e.statusCode === 404) {
            console.error(`\n❌ Not found in registry: ${name}\n`);
          } else {
            console.error(`\n❌ Install failed: ${e.message}\n`);
          }
          process.exit(1);
        }
      }
    );
}

// Re-export for tests / external tools that want the isDossierFrontmatter check.
export { isDossierFrontmatter };
