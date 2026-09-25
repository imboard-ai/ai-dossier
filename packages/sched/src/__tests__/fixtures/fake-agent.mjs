/**
 * Fake agent for sched integration tests (#464 test strategy: "a fake agent
 * (shell script that posts fake milestones / sleeps / dies) … no LLM calls").
 *
 * Reads the dispatch prompt on stdin (like the real headless agents), parses
 * `#<issue>` from it, and behaves per --mode:
 *   complete — posts a fake `report done` milestone JSON into --milestones-dir, exits 0
 *   die      — exits 1 having done nothing verifiable
 *   emit-progress — emits a stream-JSON tool-use event before its mode behavior,
 *                   representing an agent that actually began work
 *   sleep    — sleeps --sleep-ms (default 30s) then exits
 *   tail     — #468: a detached-ship agent. Decides by prompt: a REPORT
 *              dispatch ("report phase") posts `report done`; a full-cycle
 *              dispatch posts the ship phase's `awaiting-merge` milestone
 *              (with `pr=` from --pr=, defaulting to the issue number) —
 *              the park — and exits 0.
 *   batch    — #523: a single command template dispatches members, the tail
 *              agent, the fix agent and the report agent, so this mode
 *              decides its behavior from the PROMPT TEXT (mirroring `tail`'s
 *              own report-vs-park detection):
 *                - "member-cycle workflow" → a batch MEMBER (#677: the
 *              scheduler's default member prompt dispatches member-cycle; the
 *              regex matched "slot-cycle" before it). Its FIRST action,
 *                  when --require-dep=<name> is set (#561 AC3 — opt-in so
 *                  every other test's cwd-less batch worktree is unaffected),
 *                  is to resolve `node_modules/<name>` under the worktree the
 *                  prompt names (`worktree=...`, same as a real agent `cd`ing
 *                  in as its first tool call) — a member whose worktree is
 *                  cold dies exactly as `env-cold` would, before posting
 *                  anything. Otherwise posts `review done mode=slot
 *                  batch=<id>` UNLESS this member's issue is listed in
 *                  --evict-members (comma-separated), in which case it posts
 *                  `status=blocked mode=slot` with --evict-reason (default
 *                  `test-failures`) instead. #809: --member-sleep-ms holds
 *                  every member before it works (concurrency is observable),
 *                  --slow-members/--slow-ms override the hold per issue, and
 *                  `{issue}` in --commit-file names a per-member file.
 *                - "batch review and ship tail" → the TAIL agent. Posts
 *                  `batch-review done` then the batch-ship park
 *                  (`awaiting-merge` with `pr=` from --pr=, default 9000) on
 *                  the ANCHOR issue. #832: first appends the prompt's
 *                  `Members:` list as one line to `<anchor>.tail-members`
 *                  (so a test can read what each tail dispatch was told);
 *                  --tail-blocked=<reason> posts `batch-review blocked
 *                  reason=<reason>` instead and exits, and --tail-die=1 exits 1
 *                  having posted nothing (an unverified exit).
 *                - "batch report phase" → the REPORT agent. Posts
 *                  `batch-report done` on the anchor issue; #832:
 *                  --report-die=1 exits 1 having posted nothing instead.
 *                - anything else (the bounded fix agent) → exits 0 having
 *                  posted nothing; the engine verifies a fix by re-running
 *                  the (injected, fake) suite, never by trusting this exit.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

let input = '';
process.stdin.on('data', (d) => {
  input += d;
});
process.stdin.on('end', () => {
  const match = input.match(/#(\d+)/);
  const issue = match ? match[1] : '0';
  const mode = opt('mode') ?? 'complete';
  const dir = opt('milestones-dir');

  const post = (phase, status, keys = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${issue}.json`),
      JSON.stringify(
        {
          phase,
          status,
          run: `r-${issue}-fake`,
          at: new Date().toISOString(),
          keys,
        },
        null,
        2
      )
    );
  };

  if (opt('emit-progress') !== undefined) {
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      })
    );
  }

  if (mode === 'complete' && dir) {
    post('report', 'done');
    console.log(`fake agent: posted report done for #${issue}`);
    process.exit(0);
  }
  if (mode === 'tail' && dir) {
    if (/report phase/i.test(input)) {
      post('report', 'done');
      console.log(`fake report agent: posted report done for #${issue}`);
      process.exit(0);
    }
    const pr = opt('pr') ?? issue;
    post('ship', 'awaiting-merge', { pr: String(pr), head: 'abc1234', ci_fix_attempts: '0' });
    console.log(`fake agent: parked PR #${pr} for #${issue}`);
    process.exit(0);
  }
  if (mode === 'batch' && dir) {
    if (/member-cycle workflow/i.test(input)) {
      // #809: `--member-sleep-ms=<n>` holds every member n ms before it does
      // its work (so concurrent members are observably alive at once);
      // `--slow-members=<a,b>` + `--slow-ms=<n>` override the hold for those
      // issues (out-of-order completion, for the ordered-landing tests).
      const slowMembers = (opt('slow-members') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const holdMs = slowMembers.includes(issue)
        ? Number(opt('slow-ms') ?? 0)
        : Number(opt('member-sleep-ms') ?? 0);
      setTimeout(() => runMember(), holdMs);
      return;
    }
    if (/batch review and ship tail/i.test(input)) {
      const members = input.match(/Members: ([\d,]*)/);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${issue}.tail-members`), `${members ? members[1] : ''}\n`);
      if (opt('tail-die') !== undefined) {
        console.error(`fake batch tail: dying unverified for anchor #${issue}`);
        process.exit(1);
      }
      const blocked = opt('tail-blocked');
      if (blocked !== undefined) {
        post('batch-review', 'blocked', { reason: blocked });
        console.log(
          `fake batch tail: posted batch-review blocked (${blocked}) for anchor #${issue}`
        );
        process.exit(0);
      }
      post('batch-review', 'done', {});
      const pr = opt('pr') ?? '9000';
      post('batch-ship', 'awaiting-merge', { pr: String(pr), head: 'abc1234' });
      console.log(
        `fake batch tail: posted batch-review done then batch-ship awaiting-merge (pr=${pr}) for anchor #${issue}`
      );
      process.exit(0);
    }
    if (/batch report phase/i.test(input)) {
      if (opt('report-die') !== undefined) {
        console.error(`fake batch report: dying unverified for anchor #${issue}`);
        process.exit(1);
      }
      post('batch-report', 'done', {});
      console.log(`fake batch report: posted batch-report done for anchor #${issue}`);
      process.exit(0);
    }
    // The bounded fix agent: commits nothing verifiable here — the engine
    // verifies the fix by re-running the (fake, test-injected) suite, never
    // by trusting this exit.
    console.log(`fake batch fix agent: exiting for #${issue}`);
    process.exit(0);
  }

  function runMember() {
    const requireDep = opt('require-dep');
    if (requireDep) {
      const worktreeMatch = input.match(/worktree=(\S+)/);
      const worktree = worktreeMatch ? worktreeMatch[1].replace(/[.,]+$/, '') : null;
      const depPath = worktree ? path.join(worktree, 'node_modules', requireDep) : null;
      if (!depPath || !fs.existsSync(depPath)) {
        console.error(
          `fake batch member: env-cold — ${depPath ?? '<no worktree in prompt>'} not found, dying before doing any work`
        );
        process.exit(1);
      }
    }
    const batchMatch = input.match(/batch=(\S+)/);
    const batchId = batchMatch ? batchMatch[1].replace(/[.,]+$/, '') : 'unknown';
    // #686: opt-in REAL member work — write `--commit-file=<name>` into the
    // worktree the prompt names and commit it with the `(#<issue>)` subject
    // trailer `boundaryCommits` attributes by, so `memberRanges` records a
    // genuine range for this member (a member with no commits is
    // indistinguishable from one that never ran). Runs BEFORE the
    // milestone lands, exactly like a real member committing before it
    // posts `review done`.
    // #809: `{issue}` in the name is replaced by the member's issue, so each
    // member of a parallel batch can commit a DISJOINT file; a fixed name
    // makes every member touch the same file (the landing-conflict tests).
    const commitFile = opt('commit-file')?.replaceAll('{issue}', issue);
    if (commitFile) {
      const worktreeMatch = input.match(/worktree=(\S+)/);
      const worktree = worktreeMatch ? worktreeMatch[1].replace(/[.,]+$/, '') : null;
      if (worktree) {
        fs.writeFileSync(path.join(worktree, commitFile), `member #${issue}\n`);
        execFileSync('git', ['add', commitFile], { cwd: worktree, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', `feat: ${commitFile} (#${issue})`], {
          cwd: worktree,
          stdio: 'ignore',
        });
      }
    }
    // #810: `--die-members=<a,b>` — the member exits WITHOUT any terminal
    // milestone (after its optional commit): the engine's unverified-exit
    // eviction, as opposed to `--evict-members`' explicit hand-back.
    const dieMembers = (opt('die-members') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (dieMembers.includes(issue)) {
      console.log(`fake batch member: exiting without a milestone for #${issue}`);
      process.exit(1);
    }
    const evictMembers = (opt('evict-members') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (evictMembers.includes(issue)) {
      const reason = opt('evict-reason') ?? 'test-failures';
      post('review', 'blocked', { mode: 'slot', batch: batchId, reason });
      console.log(`fake batch member: posted blocked (${reason}) for #${issue} batch=${batchId}`);
    } else {
      post('review', 'done', { mode: 'slot', batch: batchId });
      console.log(`fake batch member: posted review done for #${issue} batch=${batchId}`);
    }
    process.exit(0);
  }
  if (mode === 'die') {
    console.error('fake agent: dying without doing anything');
    process.exit(1);
  }
  if (mode === 'sleep') {
    const ms = Number(opt('sleep-ms') ?? 30_000);
    console.log(`fake agent: sleeping ${ms}ms for #${issue}`);
    setTimeout(() => process.exit(0), ms);
    return;
  }
  process.exit(0);
});
