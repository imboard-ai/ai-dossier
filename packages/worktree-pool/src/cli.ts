#!/usr/bin/env node

import {
  claim,
  detect,
  findBrokenEntries,
  findMissingWarmEntries,
  formatAge,
  gc,
  init,
  type PoolDirEntryReport,
  ReturnFailure,
  reap,
  refresh,
  replenish,
  returnWorktree,
  status,
} from './pool-actions';
import type { KilledProcess } from './process-scan';

/**
 * Print the processes a `return`/`gc` kill step killed, any non-fatal kill
 * failures, and any matching pids excluded as this process or an ancestor of
 * it — the one block `return`, `gc`, and a failed `return`'s error handler
 * all need (imboard-ai/ai-dossier#760, #763).
 */
function printKilledProcesses(
  killed: KilledProcess[],
  killErrors: string[],
  skippedSelfOrAncestor: number[] = [],
  headerIndent = '',
  itemIndent = '  '
): void {
  if (killed.length > 0) {
    console.error(`${headerIndent}Killed ${killed.length} process(es):`);
    for (const p of killed) {
      console.error(`${itemIndent}pid ${p.pid} (${p.signal})  ${p.command.slice(0, 80)}`);
    }
  }
  if (killErrors.length > 0) {
    console.error(
      `${headerIndent}Kill failures (${killErrors.length}) — process may still be running:`
    );
    for (const e of killErrors) {
      console.error(`${itemIndent}${e}`);
    }
  }
  if (skippedSelfOrAncestor.length > 0) {
    console.error(`${headerIndent}skipped self/ancestors: ${skippedSelfOrAncestor.join(', ')}`);
  }
}

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

/**
 * Print warm entries whose directory is gone from disk — removed outside the
 * pool. Never fatal: claim skips them; `gc` drops the stale state entries.
 */
function reportMissing(missing: string[]): void {
  if (missing.length === 0) return;
  console.error(`Missing from disk (skipped): ${missing.length}`);
  for (const name of missing) {
    console.error(`  ${name} — recorded as warm, directory no longer exists`);
  }
  console.error("Run 'worktree-pool gc --yes' to drop stale pool entries.");
}

function usage(): void {
  console.error(`Usage: worktree-pool <command> [options]

Commands:
  status [--json]                 Show pool inventory (--json for callers)
  replenish [--count N]             Pre-warm spares up to target
  claim --issue N --branch B      Claim a warm worktree, print path
  return --path P [--json]        Return worktree to pool (kills its processes first)
  refresh                         Fetch + rebuild all warm worktrees
  gc [--dry-run] [--yes]          Remove stale/orphaned worktrees (kills their processes first)
  reap [--older-than H] [--dry-run] [--yes]
                                   Kill processes orphaned by removed/non-assigned
                                   worktrees, older than H hours (default 24)
  init                            Configure pool directory for this project
  detect [dir]                    Print detected package manager env as JSON

The pool only ever removes worktrees it created. Worktrees sharing the pool
directory that the pool did not create are reported as "foreign, skipped" and
are never touched. gc and reap require --yes when stdin is not a TTY.

A failed 'return' leaves its pool entry marked 'broken' (never 'assigned' or
'warm') and exits non-zero naming the step that failed — except for a path that
is not in the pool at all, which fails before there is any entry to mark. The
worktree directory is left on disk for inspection; 'status --json' carries the
failed step, and gc clears the entry.

'return' and 'gc' kill any process still running out of a worktree before
recycling/removing it (a dev server, jest run, or vite server a verification
step started and never stopped — imboard-ai/ai-dossier#760). 'reap' is the
sweep for what escaped that: processes rooted in worktrees that are already
gone, or in pool entries that are not actively assigned/recycling/creating/
warming, regardless of when they were last touched by return/gc. It never
touches a worktree the pool did not create, and never a currently-registered
worktree in an active pool status — that is active work, not an orphan.`);
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
          reportMissing(result.missing);
          console.log(result.path);
        } else {
          reportCorrupted(findBrokenEntries());
          reportMissing(findMissingWarmEntries());
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
        const returned = await returnWorktree(wtPath);
        if (boolFlag(flags.json)) {
          console.log(JSON.stringify(returned, null, 2));
          break;
        }
        printKilledProcesses(
          returned.killedProcesses,
          returned.killErrors,
          returned.skippedSelfOrAncestor,
          '',
          '  '
        );
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
          printKilledProcesses(
            result.killedProcesses,
            [],
            result.skippedSelfOrAncestor,
            '  ',
            '    '
          );
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

      case 'reap': {
        const dryRun = boolFlag(flags['dry-run']);
        const yes = boolFlag(flags.yes) || flags.force === true;
        let olderThanHours: number | undefined;
        if (flags['older-than'] !== undefined) {
          olderThanHours = Number.parseFloat(String(flags['older-than']));
          if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
            console.error(
              `Error: --older-than must be a non-negative number of hours, got "${flags['older-than']}"`
            );
            process.exit(1);
          }
        }
        const result = await reap({ dryRun, yes, olderThanHours });
        if (!result.dryRun && !result.aborted && result.candidates.length > 0) {
          console.error(`Killed ${result.killed.length}/${result.candidates.length} process(es):`);
          for (const c of result.candidates) {
            const label = result.killed.some((k) => k.pid === c.pid) ? 'killed' : 'FAILED';
            console.error(
              `  pid ${c.pid}  age ${formatAge(c.ageMs)}  worktree ${c.worktree}  [${label}]  ${c.command.slice(0, 80)}`
            );
          }
        }
        if (result.skippedSelfOrAncestor.length > 0) {
          console.error(`skipped self/ancestors: ${result.skippedSelfOrAncestor.join(', ')}`);
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
      printKilledProcesses(
        err.killedProcesses,
        err.killErrors,
        err.skippedSelfOrAncestor,
        '',
        '  '
      );
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
