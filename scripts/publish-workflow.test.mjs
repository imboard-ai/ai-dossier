import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The publish workflow's side of publish-guard's fail-safe contract (#846).
// publish-guard.mjs exits 0 for an undecidable package under
// --defer-collision and signals "do not publish" only through its `skip`
// output. So a publish step must run on an explicit `skip == 'false'` — a
// check that wrote no output (a crash, a future early return) must never
// publish. `skip != 'true'` would publish in exactly that case.
const WORKFLOW = fileURLToPath(
  new URL('../.github/workflows/publish-packages.yml', import.meta.url)
);

/** Each `- name:` step of the workflow as { name, body }. */
function steps(text) {
  return text
    .split(/\n(?=[ \t]*- name: )/)
    .slice(1)
    .map((chunk) => ({ name: /- name: (.*)/.exec(chunk)[1].trim(), body: chunk }));
}

/** Violations of the fail-safe contract; [] when the workflow is safe. */
function failSafeViolations(text) {
  const all = steps(text);
  const checks = all.filter((s) => /^Check if @ai-dossier\/.+ needs publishing$/.test(s.name));
  const publishes = all.filter((s) => /^Publish @ai-dossier\//.test(s.name));
  const problems = [];
  if (checks.length === 0 || publishes.length === 0) problems.push('no check/publish steps found');
  for (const check of checks) {
    if (!/publish-guard\.mjs --dir \S+ --defer-collision /.test(check.body)) {
      problems.push(`${check.name}: not run through publish-guard with --defer-collision`);
    }
  }
  for (const pub of publishes) {
    const cond = /\n[ \t]*if: (.*)/.exec(pub.body)?.[1]?.trim();
    if (!/^steps\.check-[\w-]+\.outputs\.skip == 'false'$/.test(cond ?? '')) {
      problems.push(`${pub.name}: must run only on skip == 'false' (got ${cond ?? 'no if:'})`);
    }
  }
  const report = all.find((s) => /--report-collisions/.test(s.body));
  if (!report) problems.push('no --report-collisions step');
  else if (!/if: \$\{\{ !cancelled\(\) \}\}/.test(report.body)) {
    problems.push(`${report.name}: must run if: \${{ !cancelled() }}`);
  }
  return problems;
}

describe('publish-packages.yml fail-safe contract (#846)', () => {
  it('the real workflow satisfies it', () => {
    expect(failSafeViolations(readFileSync(WORKFLOW, 'utf8'))).toEqual([]);
  });

  it("flags a publish step that runs on skip != 'true' (publishes when output is missing)", () => {
    const text = readFileSync(WORKFLOW, 'utf8').replace(
      "steps.check-cli.outputs.skip == 'false'",
      "steps.check-cli.outputs.skip != 'true'"
    );
    expect(failSafeViolations(text)).toEqual([
      "Publish @ai-dossier/cli: must run only on skip == 'false' (got steps.check-cli.outputs.skip != 'true')",
    ]);
  });

  it('flags a report step that a failed publish step would skip', () => {
    const text = readFileSync(WORKFLOW, 'utf8').replace(
      /\n[ \t]*if: \$\{\{ !cancelled\(\) \}\}/,
      ''
    );
    expect(failSafeViolations(text)).toHaveLength(1);
  });
});
