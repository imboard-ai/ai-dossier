/**
 * Fake agent for sched integration tests (#464 test strategy: "a fake agent
 * (shell script that posts fake milestones / sleeps / dies) … no LLM calls").
 *
 * Reads the dispatch prompt on stdin (like the real headless agents), parses
 * `#<issue>` from it, and behaves per --mode:
 *   complete — posts a fake `report done` milestone JSON into --milestones-dir, exits 0
 *   die      — exits 1 having done nothing verifiable
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
 *                - "slot-cycle workflow" → a batch MEMBER. Posts `review done
 *                  mode=slot batch=<id>` UNLESS this member's issue is listed
 *                  in --evict-members (comma-separated), in which case it
 *                  posts `status=blocked mode=slot` with --evict-reason
 *                  (default `test-failures`) instead.
 *                - "batch review and ship tail" → the TAIL agent. Posts
 *                  `batch-review done` then the batch-ship park
 *                  (`awaiting-merge` with `pr=` from --pr=, default 9000) on
 *                  the ANCHOR issue.
 *                - "batch report phase" → the REPORT agent. Posts
 *                  `batch-report done` on the anchor issue.
 *                - anything else (the bounded fix agent) → exits 0 having
 *                  posted nothing; the engine verifies a fix by re-running
 *                  the (injected, fake) suite, never by trusting this exit.
 */
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
    if (/slot-cycle workflow/i.test(input)) {
      const batchMatch = input.match(/batch=(\S+)/);
      const batchId = batchMatch ? batchMatch[1].replace(/[.,]+$/, '') : 'unknown';
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
    if (/batch review and ship tail/i.test(input)) {
      post('batch-review', 'done', {});
      const pr = opt('pr') ?? '9000';
      post('batch-ship', 'awaiting-merge', { pr: String(pr), head: 'abc1234' });
      console.log(
        `fake batch tail: posted batch-review done then batch-ship awaiting-merge (pr=${pr}) for anchor #${issue}`
      );
      process.exit(0);
    }
    if (/batch report phase/i.test(input)) {
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
