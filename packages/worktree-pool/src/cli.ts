#!/usr/bin/env node

import {
  claim,
  detect,
  findBrokenEntries,
  gc,
  init,
  type PoolDirEntryReport,
  refresh,
  replenish,
  returnWorktree,
  status,
} from './pool-actions';

/**
 * Print corrupted pool directories (#443). Never fatal: a broken entry is
 * reported and skipped, and the command it interrupted carries on.
 */
function reportBroken(broken: PoolDirEntryReport[]): void {
  if (broken.length === 0) return;
  console.error(`Broken (corrupted, skipped): ${broken.length}`);
  for (const b of broken) {
    console.error(`  ${b.name} — ${b.reason}`);
  }
  console.error("Run 'worktree-pool gc --yes' to clear broken pool entries.");
}

function usage(): void {
  console.error(`Usage: worktree-pool <command> [options]

Commands:
  status                          Show pool inventory
  replenish [--count N]             Pre-warm spares up to target
  claim --issue N --branch B      Claim a warm worktree, print path
  return --path P                 Return worktree to pool
  refresh                         Fetch + rebuild all warm worktrees
  gc [--dry-run] [--yes]          Remove stale/orphaned worktrees
  init                            Configure pool directory for this project
  detect [dir]                    Print detected package manager env as JSON

The pool only ever removes worktrees it created. Worktrees sharing the pool
directory that the pool did not create are reported as "foreign, skipped" and
are never touched. gc requires --yes when stdin is not a TTY.`);
}

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean> } {
  const command = args[0];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const { command, flags } = parseArgs(args);

  try {
    switch (command) {
      case 'status': {
        const s = status();
        console.log(`Pool directory: ${s.pool_dir}`);
        console.log(
          `Warm: ${s.warm}  Assigned: ${s.assigned}  Creating: ${s.creating}  Other: ${s.other}  Total: ${s.total}`
        );
        console.log(
          `Spares needed: ${s.spares_needed}  Target: ${s.config.target_spares}  Max: ${s.config.max_pool_size}`
        );
        if (s.worktrees.length > 0) {
          console.log('\nWorktrees:');
          for (const wt of s.worktrees) {
            const info =
              wt.assigned_to_issue !== null
                ? ` -> issue #${wt.assigned_to_issue} (${wt.assigned_branch})`
                : '';
            console.log(`  ${wt.id}  [${wt.status}]  ${wt.path}${info}`);
          }
        }
        if (s.foreign.length > 0) {
          console.log(`\nOther (foreign, never touched by the pool): ${s.foreign.length}`);
          for (const f of s.foreign) {
            console.log(`  ${f.name}  [${f.branch ?? 'detached'}]  ${f.reason}`);
          }
        }
        if (s.broken.length > 0) {
          console.log(`\nBroken (corrupted, skipped by claim): ${s.broken.length}`);
          for (const b of s.broken) {
            console.log(`  ${b.name}  ${b.reason}`);
          }
          console.log("Run 'worktree-pool gc --yes' to clear broken pool entries.");
        }
        break;
      }

      case 'replenish': {
        const count = flags.count ? Number.parseInt(String(flags.count), 10) : undefined;
        console.error(`Replenishing pool${count ? ` (count: ${count})` : ''}...`);
        const result = await replenish(count);
        console.error(`Created ${result.created} worktree(s)`);
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.error(`  Error: ${err}`);
          }
        }
        console.log(JSON.stringify(result));
        break;
      }

      case 'claim': {
        const issue = typeof flags.issue === 'string' ? Number.parseInt(flags.issue, 10) : NaN;
        const branch = typeof flags.branch === 'string' ? flags.branch : null;
        if (!Number.isInteger(issue) || branch === null) {
          console.error('Error: --issue N and --branch B are required');
          process.exit(1);
        }
        const result = claim(issue, branch);
        if (result) {
          reportBroken(result.broken);
          console.log(result.path);
        } else {
          reportBroken(findBrokenEntries());
          console.error("No warm worktrees available. Run 'worktree-pool replenish' first.");
          process.exit(1);
        }
        break;
      }

      case 'return': {
        const wtPath = flags.path ? String(flags.path) : null;
        if (!wtPath) {
          console.error('Error: --path P is required');
          process.exit(1);
        }
        returnWorktree(wtPath);
        console.error('Worktree returned to pool');
        break;
      }

      case 'refresh': {
        console.error('Refreshing warm worktrees...');
        const result = refresh();
        console.error(`Refreshed ${result.refreshed} worktree(s)`);
        if (result.skipped.length > 0) {
          console.error(`Foreign, skipped: ${result.skipped.length}`);
          for (const f of result.skipped) {
            console.error(`  ${f.path} — ${f.reason}`);
          }
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.error(`  Error: ${err}`);
          }
        }
        break;
      }

      case 'gc': {
        const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true';
        const yes = flags.yes === true || flags.yes === 'true' || flags.force === true;
        console.error(dryRun ? 'Garbage collection (dry run)...' : 'Running garbage collection...');
        const result = await gc({ dryRun, yes });
        if (!result.dryRun && !result.aborted) {
          console.error(`Removed ${result.removed} item(s)`);
          if (result.staleIds.length > 0) {
            console.error(`  Stale: ${result.staleIds.join(', ')}`);
          }
          if (result.orphanIds.length > 0) {
            console.error(`  Orphans: ${result.orphanIds.join(', ')}`);
          }
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.error(`  Error: ${err}`);
          }
        }
        if (result.aborted) {
          process.exit(1);
        }
        break;
      }

      case 'detect': {
        const dir = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
        console.log(JSON.stringify(detect(dir), null, 2));
        break;
      }

      case 'init': {
        const result = await init();
        console.log(`Pool directory: ${result.pool_dir}`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
