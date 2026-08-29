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
