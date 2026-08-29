/**
 * Fake agent for sched integration tests (#464 test strategy: "a fake agent
 * (shell script that posts fake milestones / sleeps / dies) … no LLM calls").
 *
 * Reads the dispatch prompt on stdin (like the real headless agents), parses
 * `#<issue>` from it, and behaves per --mode:
 *   complete — posts a fake `report done` milestone JSON into --milestones-dir, exits 0
 *   die      — exits 1 having done nothing verifiable
 *   sleep    — sleeps --sleep-ms (default 30s) then exits
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

  if (mode === 'complete' && dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${issue}.json`),
      JSON.stringify(
        {
          phase: 'report',
          status: 'done',
          run: `r-${issue}-fake`,
          at: new Date().toISOString(),
          keys: {},
        },
        null,
        2
      )
    );
    console.log(`fake agent: posted report done for #${issue}`);
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
