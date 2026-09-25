import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The publish workflow's side of publish-guard's fail-safe contract (#846).
// publish-guard.mjs exits 0 for an undecidable package under
// --defer-collision and signals "do not publish" only through its `skip`
// output. So a publish step must run on an explicit `skip == 'false'` — a
// check that wrote no output (a crash, a future early return) must never
// publish. `skip != 'true'` would publish in exactly that case.
//
// Steps are found by what they RUN, not by name: any step that runs
// `npm publish` is a publish step, whatever it is called.
const WORKFLOW = fileURLToPath(
  new URL('../.github/workflows/publish-packages.yml', import.meta.url)
);

const readWorkflow = () => readFileSync(WORKFLOW, 'utf8');

/** A step's `if:` with an optional `${{ }}` wrapper and whitespace removed. */
const condition = (step) =>
  String(step.if ?? '')
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1')
    .replace(/\s+/g, ' ');

/** Violations of the fail-safe contract; [] when the workflow is safe. */
function failSafeViolations(text) {
  const steps = parse(text)?.jobs?.publish?.steps ?? [];
  const runOf = (s) => String(s.run ?? '');
  const checks = steps.filter((s) => /scripts\/publish-guard\.mjs --dir /.test(runOf(s)));
  const publishes = steps.filter((s) => /\bnpm publish\b/.test(runOf(s)));
  const checkIds = new Set(checks.map((s) => s.id));

  const problems = [];
  if (checks.length === 0 || publishes.length === 0) problems.push('no check/publish steps found');
  for (const check of checks) {
    if (!/--defer-collision /.test(runOf(check))) {
      problems.push(`${check.name}: not run through publish-guard with --defer-collision`);
    }
  }
  for (const pub of publishes) {
    const cond = condition(pub);
    const m = /^steps\.([\w-]+)\.outputs\.skip == 'false'$/.exec(cond);
    if (!m || !checkIds.has(m[1])) {
      problems.push(`${pub.name}: must run only on skip == 'false' (got ${cond || 'no if:'})`);
    }
  }
  const report = steps.find((s) => /--report-collisions/.test(runOf(s)));
  if (!report) problems.push('no --report-collisions step');
  else if (condition(report) !== '!cancelled()') {
    problems.push(`${report.name}: must run if: \${{ !cancelled() }}`);
  }
  return problems;
}

describe('publish-packages.yml fail-safe contract (#846)', () => {
  it('the real workflow satisfies it, over all 5 packages', () => {
    const steps = parse(readWorkflow()).jobs.publish.steps;
    expect(steps.filter((s) => /\bnpm publish\b/.test(String(s.run ?? '')))).toHaveLength(5);
    expect(failSafeViolations(readWorkflow())).toEqual([]);
  });

  it("flags a publish step that runs on skip != 'true' (publishes when output is missing)", () => {
    const text = readWorkflow().replace(
      "steps.check-cli.outputs.skip == 'false'",
      "steps.check-cli.outputs.skip != 'true'"
    );
    expect(failSafeViolations(text)).toEqual([
      "Publish @ai-dossier/cli: must run only on skip == 'false' (got steps.check-cli.outputs.skip != 'true')",
    ]);
  });

  it('finds a publish step by what it runs, however it is named', () => {
    const text = readWorkflow()
      .replace('- name: Publish @ai-dossier/cli', "- name: 'Ship the CLI'")
      .replace("steps.check-cli.outputs.skip == 'false'", "steps.check-cli.outputs.skip != 'true'");
    expect(failSafeViolations(text)).toHaveLength(1);
  });

  it('flags a check step that dropped --defer-collision', () => {
    const text = readWorkflow().replace(
      'publish-guard.mjs --dir cli --defer-collision "$RUNNER_TEMP/publish-collisions"',
      'publish-guard.mjs --dir cli'
    );
    expect(failSafeViolations(text)).toEqual([
      'Check if @ai-dossier/cli needs publishing: not run through publish-guard with --defer-collision',
    ]);
  });

  it('flags a report step that a failed publish step would skip', () => {
    const text = readWorkflow().replace(/\n[ \t]*if: \$\{\{ !cancelled\(\) \}\}/, '');
    expect(failSafeViolations(text)).toEqual([
      'Fail on version collisions: must run if: ${{ !cancelled() }}',
    ]);
  });

  it('ignores a commented-out condition', () => {
    const text = readWorkflow().replace(
      /\n([ \t]*)if: \$\{\{ !cancelled\(\) \}\}/,
      '\n$1# was: if: ${{ !cancelled() }}'
    );
    expect(failSafeViolations(text)).toHaveLength(1);
  });

  it('does not pass vacuously on a workflow with no publish steps', () => {
    expect(failSafeViolations('jobs:\n  publish:\n    steps: []\n')).toContain(
      'no check/publish steps found'
    );
  });
});
