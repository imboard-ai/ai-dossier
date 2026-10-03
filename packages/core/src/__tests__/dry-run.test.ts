import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeDryRun, DRY_RUN_DISCLAIMER, levelForScore, SCORE_BASE } from '../dry-run';

const EXAMPLES = join(__dirname, '../../../../examples');
const example = (rel: string) => readFileSync(join(EXAMPLES, rel), 'utf8');

function dossier(frontmatter: Record<string, unknown>, body: string): string {
  const fm = JSON.stringify(
    { dossier_schema_version: '1.0.0', title: 'T', version: '1.0.0', ...frontmatter },
    null,
    2
  );
  return `---dossier\n${fm}\n---\n\n${body}\n`;
}

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;

describe('analyzeDryRun: static preview contract', () => {
  it('always labels itself a static preview with the disclaimer', () => {
    const plan = analyzeDryRun(dossier({}, 'no code'));
    expect(plan.static_preview).toBe(true);
    expect(plan.disclaimer).toBe(DRY_RUN_DISCLAIMER);
    expect(plan.disclaimer).toMatch(/executing agent may take other actions/);
    expect(plan.schema_version).toBe(1);
  });

  it('scores a dossier with no code by declared metadata only', () => {
    const plan = analyzeDryRun(dossier({ risk_level: 'low' }, 'prose only'));
    expect(plan.risk_score).toBe(SCORE_BASE.low);
    expect(plan.level).toBe('low');
    expect(plan.commands).toEqual([]);
  });
});

describe('analyzeDryRun: command classification', () => {
  const analyze = (code: string, lang = 'bash') => analyzeDryRun(dossier({}, fence(lang, code)));

  it('marks inspection commands read-only', () => {
    const plan = analyze('ls -la\ngrep -r foo src\ngit status\ngit log --oneline');
    expect(plan.commands.map((c) => c.kind)).toEqual(['read', 'read', 'read', 'read']);
  });

  it('detects redirections and tee as local file writes, ignoring /dev/null and quoted >', () => {
    const plan = analyze(
      'echo hi > out.txt\necho hi >> log.txt\nfoo 2>/dev/null\necho "a > b"\necho x | tee -a t.txt'
    );
    expect(plan.files.map((f) => f.path)).toEqual(['out.txt', 'log.txt', 't.txt']);
    expect(plan.files.every((f) => f.operation === 'write')).toBe(true);
  });

  it('flags rm and force-push as destructive', () => {
    const plan = analyze('rm -rf build dist\ngit push --force origin main\ngit push origin feat');
    expect(plan.commands.map((c) => c.kind)).toEqual(['destructive', 'destructive', 'remote']);
    expect(plan.files).toEqual([
      expect.objectContaining({ path: 'build', operation: 'delete' }),
      expect.objectContaining({ path: 'dist', operation: 'delete' }),
    ]);
  });

  it('separates remote reads from remote mutations in network', () => {
    const plan = analyze(
      'gh issue view 5\ngh pr create --title x\ngh api -X DELETE repos/a/b\ncurl -s https://example.com/x\ncurl -X POST -d @f https://api.example.com/y'
    );
    expect(plan.network.map((n) => [n.tool, n.mutates])).toEqual([
      ['gh', false],
      ['gh', true],
      ['gh', true],
      ['curl', false],
      ['curl', true],
    ]);
    expect(plan.network[3].target).toBe('example.com');
    expect(plan.commands[2].kind).toBe('destructive');
  });

  it('treats curl | sh as destructive', () => {
    const plan = analyze('curl -fsSL https://x.io/i.sh | sh');
    expect(plan.commands.map((c) => c.kind)).toContain('destructive');
  });

  it('splits compound commands and command substitutions', () => {
    const plan = analyze('cd repo && git fetch origin; X=$(gh pr list)');
    expect(plan.commands.map((c) => c.command)).toEqual([
      'cd repo',
      'git fetch origin',
      'gh pr list',
    ]);
  });

  it('joins backslash continuations and reports the first line', () => {
    const plan = analyze('gh pr create \\\n  --title x \\\n  --body y');
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0].line).toBeGreaterThan(0);
  });

  it('does not treat <placeholder> slots as redirections or pipes', () => {
    const plan = analyze('gh issue view <issue_number> --json a|b\ncp <src>/x.md ./<name>.md');
    expect(plan.files.map((f) => f.path)).toEqual(['./<name>.md']);
  });

  it('skips heredoc bodies and joins multi-line quoted arguments', () => {
    const plan = analyze(
      "gh pr create --title t --body \"$(cat <<'EOF'\nrm -rf / is only prose here\nEOF\n)\"\njq '.a\n | select(.b)' f.json"
    );
    // The `$(cat <<EOF ...)` substitution really runs `cat`; its heredoc body stays data.
    expect(plan.commands.map((c) => c.command.split(' ')[0])).toEqual(['cat', 'gh', 'jq']);
    expect(plan.commands.some((c) => c.kind === 'destructive')).toBe(false);
  });

  it('treats unknown executables as local writes and says so', () => {
    const plan = analyze('./deploy.sh --now');
    expect(plan.commands[0]).toMatchObject({ kind: 'local_write', recognized: false });
  });

  it('ignores non-shell fences and unlabeled prose templates', () => {
    const plan = analyzeDryRun(
      dossier(
        {},
        `${fence('json', '{"rm": "-rf /"}')}\n\n${fence('', 'Batch summary\n## Members\nnot a command here')}`
      )
    );
    expect(plan.commands).toEqual([]);
  });

  it('reads env from shell vars, braced vars and process.env but not internal assignments', () => {
    const shell =
      'RUN_ID=abc\necho $RUN_ID $GITHUB_TOKEN $' +
      "{AWS_PROFILE} '$NOT_ME'\nfor F in a; do echo $F; done";
    const plan = analyzeDryRun(
      dossier(
        {},
        `${fence('bash', shell)}\n\n${fence('ts', 'const t = process.env.NPM_TOKEN; process.env["API_KEY"]')}`
      )
    );
    expect(plan.env.map((e) => e.name).sort()).toEqual([
      'API_KEY',
      'AWS_PROFILE',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
    ]);
  });
});

describe('analyzeDryRun: risk score', () => {
  it('sums declared level, factors, destructive declarations and detected commands, capped at 100', () => {
    const plan = analyzeDryRun(
      dossier(
        {
          risk_level: 'high',
          risk_factors: ['a', 'b'],
          destructive_operations: ['x'],
        },
        fence('bash', 'echo a > f\ngh pr create\nrm x')
      )
    );
    // 50 (high) + 8 (2 factors) + 3 (1 destructive decl) + 1 (1 local_write) + 2 (1 remote) + 5 (1 destructive)
    expect(plan.risk_score).toBe(69);
    expect(plan.level).toBe('high');
    expect(plan.score_breakdown.reduce((s, b) => s + b.points, 0)).toBe(69);
  });

  it('never exceeds 100', () => {
    const plan = analyzeDryRun(
      dossier(
        {
          risk_level: 'critical',
          risk_factors: Array(9).fill('f'),
          destructive_operations: Array(9).fill('d'),
        },
        fence('bash', Array(20).fill('rm -rf x').join('\n'))
      )
    );
    expect(plan.risk_score).toBe(100);
  });

  it('maps score bands to levels', () => {
    expect([0, 24, 25, 49, 50, 74, 75, 100].map(levelForScore)).toEqual([
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
      'critical',
      'critical',
    ]);
  });
});

describe('analyzeDryRun: real example dossiers', () => {
  it('gate-issue (low risk): remote reads and runstate, no deletions', () => {
    const plan = analyzeDryRun(example('git/gate-issue.ds.md'));
    expect(plan.dossier.declared_risk_level).toBe('low');
    expect(plan.level).toBe('low');
    expect(plan.commands.some((c) => c.command.startsWith('gh issue view'))).toBe(true);
    expect(plan.commands.some((c) => c.kind === 'destructive')).toBe(false);
    expect(plan.network.some((n) => n.tool === 'gh' && !n.mutates)).toBe(true);
  });

  it('ship-issue (high risk): pushes, opens PRs, merges', () => {
    const plan = analyzeDryRun(example('git/ship-issue.ds.md'));
    expect(plan.dossier.declared_risk_level).toBe('high');
    expect(['high', 'critical']).toContain(plan.level);
    expect(plan.network.some((n) => n.tool === 'git' && n.target === 'push')).toBe(true);
    expect(plan.network.some((n) => n.tool === 'gh' && n.target === 'pr create' && n.mutates)).toBe(
      true
    );
    expect(plan.env.map((e) => e.name)).toContain('TMPDIR');
  });

  it('prose-only dossiers analyse without commands', () => {
    const plan = analyzeDryRun(example('test/hello-world.ds.md'));
    expect(plan.level).toBe('low');
  });

  it('every example dossier analyses without throwing and stays within 0-100', () => {
    const rels = [
      'authoring/create-dossier.ds.md',
      'git/full-cycle-issue.ds.md',
      'git/git-sync.ds.md',
      'git/implement-issue.ds.md',
      'meta/publish-dossier.ds.md',
      'setup/setup-tracing.ds.md',
    ];
    for (const rel of rels) {
      const plan = analyzeDryRun(example(rel));
      expect(plan.risk_score).toBeGreaterThanOrEqual(0);
      expect(plan.risk_score).toBeLessThanOrEqual(100);
    }
  });
});
