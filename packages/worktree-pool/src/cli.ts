#!/usr/bin/env node

import {
  claim,
  detect,
  findBrokenEntries,
  gc,
  init,
  type PoolDirEntryReport,
  ReturnFailure,
  refresh,
  replenish,
  returnWorktree,
  status,
} from './pool-actions';

/**
 * Print corrupted pool directories (#443) — a directory on disk whose git
 * admin dir is gone. Distinct from a #453 `broken` *entry*, which is a pool
 * entry a `return` failed on; the wording keeps the two apart. Never fatal:
 * a corrupted directory is reported and skipped, and the command it
 * interrupted carries on.
 */
function reportCorrupted(corrupted: PoolDirEntryReport[]): void {
  if (corrupted.length === 0) return;
  console.error(`Corrupted (no git admin dir, skipped): ${corrupted.length}`);
  for (const b of corrupted) {
    console.error(`  ${b.name} — ${b.reason}`);
  }
  console.error("Run 'worktree-pool gc --yes' to clear corrupted pool directories.");
}

function usage(): void {
  console.error(`Usage: worktree-pool <command> [options]

Commands:
  status [--json]                 Show pool inventory (--json for callers)
  replenish [--count N]             Pre-warm spares up to target
  claim --issue N --branch B      Claim a warm worktree, print path
  return --path P [--json]        Return worktree to pool
  refresh                         Fetch + rebuild all warm worktrees
  gc [--dry-run] [--yes]          Remove stale/orphaned worktrees
  init                            Configure pool directory for this project
  detect [dir]                    Print detected package manager env as JSON

The pool only ever removes worktrees it created. Worktrees sharing the pool
directory that the pool did not create are reported as "foreign, skipped" and
are never touched. gc requires --yes when stdin is not a TTY.

A failed 'return' leaves its pool entry marked 'broken' (never 'assigned' or
'warm') and exits non-zero naming the step that failed — except for a path that
is not in the pool at all, which fails before there is any entry to mark. The
worktree directory is left on disk for inspection; 'status --json' carries the
failed step, and gc clears the entry.`);
}

/** A flag is set when present as `--x` or given the literal string 'true'. */
function boolFlag(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
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
        // Machine-readable inventory (#453): `worktrees[]` already carries a
        // per-entry `status`, so a caller can assert that a `return` actually
        // landed instead of trusting the exit code of whoever claimed it did.
        if (boolFlag(flags.json)) {
          console.log(JSON.stringify(s, null, 2));
          break;
        }
        console.log(`Pool directory: ${s.pool_dir}`);
        console.log(
          `Warm: ${s.warm}  Assigned: ${s.assigned}  Creating: ${s.creating}  ` +
            `Broken: ${s.broken_entries}  Other: ${s.other}  Total: ${s.total}`
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
            // A `broken` entry says which step of `return` failed (#453) —
            // otherwise the operator has to go read the directory to find out.
            // Git errors are routinely multi-line; collapse them so one
            // worktree stays one line and cannot be misread as two entries.
            const reason = (wt.broken_reason ?? 'unknown').replace(/\s+/g, ' ').trim();
            const shortReason = reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
            const failure = wt.broken_step ? ` failed at '${wt.broken_step}': ${shortReason}` : '';
            console.log(`  ${wt.id}  [${wt.status}]  ${wt.path}${info}${failure}`);
          }
        }
        if (s.foreign.length > 0) {
          console.log(`\nOther (foreign, never touched by the pool): ${s.foreign.length}`);
          for (const f of s.foreign) {
            console.log(`  ${f.name}  [${f.branch ?? 'detached'}]  ${f.reason}`);
          }
        }
        if (s.broken_entries > 0) {
          console.log(
            "\nBroken entries (a failed `return`): run 'worktree-pool status --json' for the " +
              "full reason, or 'worktree-pool gc' to clear them."
          );
        }
        if (s.broken.length > 0) {
          // A *different* problem from a broken entry above: the directory is
          // there but git has no admin dir for it (#443).
          console.log(
            `\nCorrupted directories (no git admin dir, skipped by claim): ${s.broken.length}`
          );
          for (const b of s.broken) {
            console.log(`  ${b.name}  ${b.reason}`);
          }
          console.log("Run 'worktree-pool gc --yes' to clear corrupted pool directories.");
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
          reportCorrupted(result.broken);
          console.log(result.path);
        } else {
          reportCorrupted(findBrokenEntries());
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
        // Failures fall through to the outer catch, which prints the step and
        // exits 1 (#453). The entry is left `broken`, never `assigned`.
        const returned = returnWorktree(wtPath);
        if (boolFlag(flags.json)) {
          console.log(JSON.stringify(returned, null, 2));
          break;
        }
        const v = returned.verification;
        console.error('Worktree returned to pool');
        console.error('Self-check:');
        console.error(`  entry ${returned.id}: ${v.entry_status}`);
        console.error(`  directory clean: ${v.directory_clean ? 'yes' : 'no'} (${returned.path})`);
        console.error(`  checked out: ${v.checked_out_branch ?? 'detached HEAD'}`);
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
        const dryRun = boolFlag(flags['dry-run']);
        const yes = boolFlag(flags.yes) || flags.force === true;
        console.error(dryRun ? 'Garbage collection (dry run)...' : 'Running garbage collection...');
        const result = await gc({ dryRun, yes });
        if (!result.dryRun && !result.aborted) {
          console.error(`Removed ${result.removed} item(s)`);
          if (result.staleIds.length > 0) {
            console.error(`  Stale: ${result.staleIds.join(', ')}`);
          }
          if (result.brokenIds.length > 0) {
            console.error(`  Broken (failed return): ${result.brokenIds.join(', ')}`);
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
    if (err instanceof ReturnFailure) {
      // Say plainly what state the pool is in, so a caller cannot read a
      // non-zero exit as "nothing happened" (#453). Never assert the entry was
      // marked without knowing it was — that claim being false is the bug.
      if (err.entryId === null) {
        console.error('No pool entry was modified.');
      } else if (err.markError !== null) {
        console.error(
          `WARNING: pool entry ${err.entryId} could NOT be marked 'broken': ${err.markError}`
        );
        console.error(
          "  Pool state may be stale — check 'worktree-pool status --json' before the next claim."
        );
      } else {
        console.error(`Pool entry ${err.entryId} is now marked 'broken' and was NOT destroyed.`);
      }
      console.error(`  Worktree left at: ${err.worktreePath}`);
      console.error("  Inspect with 'worktree-pool status --json'; clear with 'worktree-pool gc'.");
    }
    process.exit(1);
  }
}

main();
