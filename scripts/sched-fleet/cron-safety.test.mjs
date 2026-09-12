import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS_DIR = import.meta.dirname;
const tempRoots = [];

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function sandbox({ crontabScript } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sched-cron-'));
  tempRoots.push(home);
  const fleet = join(home, 'fleet');
  const bin = join(home, '.local', 'bin');
  const cronFile = join(home, 'crontab');
  const cronLog = join(home, 'crontab.log');
  const aiLog = join(home, 'ai-dossier.log');
  const curlLog = join(home, 'curl.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(fleet, { recursive: true });
  mkdirSync(join(home, '.nvm', 'versions', 'node', 'v24.20.0', 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(home, '.nvm', 'versions', 'node', 'v24.20.0', 'bin', 'node'));
  writeFileSync(
    join(fleet, 'telegram.env'),
    'HANEST_TELEGRAM_BOT_TOKEN=test\nHANEST_TELEGRAM_CHAT_ID=test\n'
  );
  writeFileSync(join(fleet, 'projects.txt'), '');
  writeFileSync(join(fleet, 'issues.txt'), '');
  executable(join(bin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_LOG"\nexit 0\n');
  executable(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'at'), '#!/bin/sh\nexit 1\n');
  executable(
    join(bin, 'ai-dossier'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$AI_DOSSIER_LOG"\nif [ "$1" = "--version" ]; then printf \'0.39.0\\n\'; fi\nexit 0\n'
  );
  executable(
    join(bin, 'crontab'),
    crontabScript ??
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CRONTAB_LOG"\nprintf \'crontab unavailable\\n\' >&2\nexit 42\n'
  );
  return { home, fleet, cronFile, cronLog, aiLog, curlLog, bin };
}

function runScript(script, box, extraEnv = {}) {
  return () =>
    execFileSync('bash', [join(SCRIPTS_DIR, script)], {
      env: {
        ...process.env,
        AI_DOSSIER_LOG: box.aiLog,
        CRONTAB_LOG: box.cronLog,
        CRONTAB_FILE: box.cronFile,
        CURL_LOG: box.curlLog,
        HOME: box.home,
        SCHED_FLEET_HOME: box.fleet,
        SCHED_CRON_READ_ATTEMPTS: '1',
        ...extraEnv,
      },
      encoding: 'utf8',
    });
}

function runScriptAsync(script, box, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(SCRIPTS_DIR, script)], {
      env: {
        ...process.env,
        AI_DOSSIER_LOG: box.aiLog,
        CRONTAB_LOG: box.cronLog,
        CRONTAB_FILE: box.cronFile,
        CURL_LOG: box.curlLog,
        HOME: box.home,
        SCHED_FLEET_HOME: box.fleet,
        SCHED_CRON_READ_ATTEMPTS: '1',
        ...extraEnv,
      },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fleet cron safety', () => {
  it('fails closed when tick.sh cannot read the existing crontab', () => {
    const box = sandbox();

    expect(runScript('tick.sh', box)).not.toThrow();
    expect(readFileSync(box.cronLog, 'utf8')).toBe('-l\n');
    expect(existsSync(box.aiLog)).toBe(true);
  });

  it('retries a transient crontab read before changing the report trigger', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nCOUNT_FILE="$HOME/crontab-count"\nif [ "$1" = "-l" ]; then count=0; [ -f "$COUNT_FILE" ] && count=$(cat "$COUNT_FILE"); count=$((count + 1)); printf \'%s\\n\' "$count" > "$COUNT_FILE"; [ "$count" -gt 1 ] || exit 42; cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    mkdirSync(join(box.home, 'projects', 'ai-dossier', 'main'), { recursive: true });
    writeFileSync(
      box.cronFile,
      `0 4 * * * ${box.fleet}/enqueue-report.sh\n# keep this job\n0 1 * * * unrelated.sh\n`
    );

    expect(
      runScript('enqueue-report.sh', box, {
        SCHED_CRON_READ_ATTEMPTS: '2',
        SCHED_CRON_READ_DELAY_SECONDS: '0',
      })
    ).not.toThrow();

    const cron = readFileSync(box.cronFile, 'utf8');
    expect(cron).toContain('0 1 * * * unrelated.sh');
    expect(cron).not.toContain(`${box.fleet}/enqueue-report.sh`);
  });

  it('uses an independent retry when the report crontab remains unreadable', () => {
    const box = sandbox();
    const originalCron = `0 4 * * * ${box.fleet}/enqueue-report.sh\n0 1 * * * unrelated.sh\n`;
    const atCommand = join(box.home, 'at-command');
    const atArgs = join(box.home, 'at-args');
    writeFileSync(box.cronFile, originalCron);
    executable(
      join(box.bin, 'at'),
      '#!/bin/sh\ncat > "$AT_COMMAND"\nprintf \'%s\\n\' "$*" > "$AT_ARGS"\nexit 0\n'
    );

    expect(
      runScript('enqueue-report.sh', box, {
        AT_ARGS: atArgs,
        AT_COMMAND: atCommand,
      })
    ).toThrow();

    expect(readFileSync(box.cronFile, 'utf8')).toBe(originalCron);
    expect(readFileSync(atArgs, 'utf8')).toContain('now + 5 minutes');
    expect(readFileSync(atCommand, 'utf8')).toContain(`SCHED_FLEET_HOME=${box.fleet}`);
    expect(existsSync(join(box.fleet, '.enqueue-report.retry'))).toBe(true);
    expect(existsSync(box.aiLog)).toBe(false);
  });

  it('does not enqueue the report when enqueue-report.sh cannot remove its cron entry', () => {
    const box = sandbox();

    expect(runScript('enqueue-report.sh', box)).toThrow();
    expect(readFileSync(box.cronLog, 'utf8')).toBe('-l\n-l\n');
    expect(existsSync(box.aiLog)).toBe(false);
  });

  it('keeps the ticker alive after it schedules a newly appended issue', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    writeFileSync(join(box.fleet, 'issues.txt'), 'imboard-ai/ai-dossier#526\n');
    writeFileSync(box.cronFile, `*/2 * * * * ${box.fleet}/tick.sh\n`);
    executable(
      join(box.bin, 'gh'),
      '#!/bin/sh\ncase "$*" in\n  *"issue view 526"*) printf \'CLOSED\\n\' ;;\n  *"pr list"*) printf \'123\\n\' ;;\n  *) exit 1 ;;\nesac\n'
    );

    expect(runScript('tick.sh', box)).not.toThrow();

    const cron = readFileSync(box.cronFile, 'utf8');
    expect(cron).toContain(`${box.fleet}/tick.sh`);
    expect(cron).toContain(`${box.fleet}/enqueue-report.sh`);
    expect(readFileSync(join(box.fleet, 'issues.txt'), 'utf8')).toContain(
      'imboard-ai/ai-dossier#529'
    );
    expect(existsSync(join(box.fleet, 'report-scheduled'))).toBe(true);
    expect(existsSync(join(box.fleet, 'done.imboard-ai_ai-dossier_526'))).toBe(true);
  });

  it('does not acknowledge a closure when the report marker cannot be written', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    writeFileSync(join(box.fleet, 'issues.txt'), 'imboard-ai/ai-dossier#526\n');
    writeFileSync(box.cronFile, `*/2 * * * * ${box.fleet}/tick.sh\n`);
    executable(
      join(box.bin, 'gh'),
      '#!/bin/sh\ncase "$*" in\n  *"issue view 526"*) printf \'CLOSED\\n\' ;;\n  *"pr list"*) printf \'123\\n\' ;;\n  *) exit 1 ;;\nesac\n'
    );
    executable(
      join(box.bin, 'touch'),
      '#!/bin/sh\ncase "$1" in *report-scheduled) exit 7 ;; esac\nexec /usr/bin/touch "$@"\n'
    );

    expect(runScript('tick.sh', box)).not.toThrow();

    expect(existsSync(join(box.fleet, 'report-scheduled'))).toBe(false);
    expect(existsSync(join(box.fleet, 'done.imboard-ai_ai-dossier_526'))).toBe(false);
    expect(readFileSync(box.cronFile, 'utf8')).toContain(`${box.fleet}/enqueue-report.sh`);
  });

  it('does not announce a closure when its completion marker cannot be written', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    writeFileSync(join(box.fleet, 'issues.txt'), 'imboard-ai/ai-dossier#526\n');
    writeFileSync(box.cronFile, `*/2 * * * * ${box.fleet}/tick.sh\n`);
    executable(
      join(box.bin, 'gh'),
      '#!/bin/sh\ncase "$*" in\n  *"issue view 526"*) printf \'CLOSED\\n\' ;;\n  *"pr list"*) printf \'123\\n\' ;;\n  *) exit 1 ;;\nesac\n'
    );
    executable(
      join(box.bin, 'touch'),
      '#!/bin/sh\ncase "$1" in *done.*) exit 7 ;; esac\nexec /usr/bin/touch "$@"\n'
    );

    expect(runScript('tick.sh', box)).not.toThrow();

    expect(existsSync(join(box.fleet, 'report-scheduled'))).toBe(true);
    expect(existsSync(join(box.fleet, 'done.imboard-ai_ai-dossier_526'))).toBe(false);
    expect(readFileSync(box.curlLog, 'utf8')).not.toContain('closed (PR');
  });

  it('leaves the report cron installed when scheduler enqueue fails', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    mkdirSync(join(box.home, 'projects', 'ai-dossier', 'main'), { recursive: true });
    const originalCron = `0 4 * * * ${box.fleet}/enqueue-report.sh\n`;
    writeFileSync(box.cronFile, originalCron);
    executable(
      join(box.bin, 'ai-dossier'),
      '#!/bin/sh\nif [ "$2" = "status" ]; then printf \'{"queue":[],"failed":[]}\\n\'; else exit 7; fi\n'
    );

    expect(runScript('enqueue-report.sh', box)).toThrow();
    expect(readFileSync(box.cronFile, 'utf8')).toContain(
      `*/5 * * * * ${box.fleet}/enqueue-report.sh >> ${box.fleet}/enqueue-report.log 2>&1`
    );
    expect(readFileSync(box.cronFile, 'utf8')).not.toBe(originalCron);
    expect(existsSync(box.curlLog)).toBe(false);
  });

  it('does not mark #526 complete when #529 cannot be tracked', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    const issuesFile = join(box.fleet, 'issues.txt');
    writeFileSync(issuesFile, 'imboard-ai/ai-dossier#526\n');
    chmodSync(issuesFile, 0o444);
    writeFileSync(box.cronFile, `*/2 * * * * ${box.fleet}/tick.sh\n`);
    executable(
      join(box.bin, 'gh'),
      '#!/bin/sh\ncase "$*" in\n  *"issue view 526"*) printf \'CLOSED\\n\' ;;\n  *"pr list"*) printf \'123\\n\' ;;\n  *) exit 1 ;;\nesac\n'
    );

    expect(runScript('tick.sh', box)).not.toThrow();

    expect(existsSync(join(box.fleet, 'report-scheduled'))).toBe(false);
    expect(existsSync(join(box.fleet, 'done.imboard-ai_ai-dossier_526'))).toBe(false);
    expect(readFileSync(box.cronFile, 'utf8')).toContain(`${box.fleet}/enqueue-report.sh`);
  });

  it('does not report a successful enqueue as failed when Telegram is unavailable', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    mkdirSync(join(box.home, 'projects', 'ai-dossier', 'main'), { recursive: true });
    writeFileSync(box.cronFile, `0 4 * * * ${box.fleet}/enqueue-report.sh\n`);
    executable(join(box.bin, 'curl'), '#!/bin/sh\nexit 7\n');

    expect(runScript('enqueue-report.sh', box)).not.toThrow();
    expect(readFileSync(box.cronFile, 'utf8')).not.toContain(`${box.fleet}/enqueue-report.sh`);
  });

  it('re-arms a near-term retry when the report checkout is unavailable', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    writeFileSync(box.cronFile, `0 4 * * * ${box.fleet}/enqueue-report.sh\n`);

    expect(runScript('enqueue-report.sh', box)).toThrow();
    expect(readFileSync(box.cronFile, 'utf8')).toContain(
      `*/5 * * * * ${box.fleet}/enqueue-report.sh >> ${box.fleet}/enqueue-report.log 2>&1`
    );
  });

  it('re-arms a near-term retry when removing the report cron fails', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nCOUNT_FILE="$HOME/crontab-count"\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then count=0; [ -f "$COUNT_FILE" ] && count=$(cat "$COUNT_FILE"); count=$((count + 1)); printf \'%s\\n\' "$count" > "$COUNT_FILE"; [ "$count" -gt 1 ] || exit 42; cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    mkdirSync(join(box.home, 'projects', 'ai-dossier', 'main'), { recursive: true });
    writeFileSync(box.cronFile, `0 4 * * * ${box.fleet}/enqueue-report.sh\n`);

    expect(runScript('enqueue-report.sh', box)).toThrow();
    expect(readFileSync(box.cronFile, 'utf8')).toContain(
      `*/5 * * * * ${box.fleet}/enqueue-report.sh >> ${box.fleet}/enqueue-report.log 2>&1`
    );
  });

  it('reports a failed tick-cron removal instead of hiding it', () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then exit 42; else exit 2; fi\n',
    });
    const doneMarker = join(box.fleet, 'done.imboard-ai_ai-dossier_526');
    writeFileSync(join(box.fleet, 'issues.txt'), 'imboard-ai/ai-dossier#526\n');
    writeFileSync(doneMarker, 'done\n');
    writeFileSync(box.cronFile, `*/2 * * * * ${box.fleet}/tick.sh\n`);
    executable(
      join(box.bin, 'gh'),
      '#!/bin/sh\ncase "$*" in *"issue view 526"*) printf \'CLOSED\\n\' ;; *) exit 1 ;; esac\n'
    );

    expect(runScript('tick.sh', box)).not.toThrow();

    expect(readFileSync(box.cronFile, 'utf8')).toContain(`${box.fleet}/tick.sh`);
    expect(readFileSync(box.curlLog, 'utf8')).toContain('could not be removed');
  });

  it('serializes concurrent cron updates from bootstrap and report retries', async () => {
    const box = sandbox({
      crontabScript:
        '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then cat "$CRONTAB_FILE"; elif [ "$1" = "-" ]; then sleep 0.1; cat > "$CRONTAB_FILE"; else exit 2; fi\n',
    });
    writeFileSync(
      box.cronFile,
      `0 1 * * * unrelated.sh\n0 4 1 9 * ${box.fleet}/bootstrap.sh\n0 4 * * * ${box.fleet}/enqueue-report.sh\n`
    );

    const codes = await Promise.all([
      runScriptAsync('bootstrap.sh', box),
      runScriptAsync('enqueue-report.sh', box),
    ]);

    expect(codes).toEqual([1, 1]);
    const cron = readFileSync(box.cronFile, 'utf8');
    expect(cron).toContain('0 1 * * * unrelated.sh');
    expect(cron).toContain(
      `*/5 * * * * ${box.fleet}/bootstrap.sh >> ${box.fleet}/bootstrap.log 2>&1`
    );
    expect(cron).toContain(
      `*/5 * * * * ${box.fleet}/enqueue-report.sh >> ${box.fleet}/enqueue-report.log 2>&1`
    );
  });
});
