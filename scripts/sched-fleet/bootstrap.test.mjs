import { execFileSync } from 'node:child_process';
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

const SCRIPT_PATH = join(import.meta.dirname, 'bootstrap.sh');
const PROFILE_PATH = join(import.meta.dirname, 'dispatch-profiles.json');
const tempRoots = [];

function executable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bootstrapBox(status = '{"queue":[],"failed":[]}\n') {
  const home = mkdtempSync(join(tmpdir(), 'sched-bootstrap-'));
  tempRoots.push(home);
  const fleet = join(home, 'fleet');
  const bin = join(home, '.local', 'bin');
  const cronFile = join(home, 'crontab');
  const cronLog = join(home, 'crontab.log');
  const statusFile = join(home, 'status.json');
  mkdirSync(join(home, 'projects', 'ai-dossier', 'main'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(fleet, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(
    join(fleet, 'telegram.env'),
    'HANEST_TELEGRAM_BOT_TOKEN=test\nHANEST_TELEGRAM_CHAT_ID=test\n'
  );
  writeFileSync(join(fleet, 'dispatch-profiles.json'), readFileSync(PROFILE_PATH));
  writeFileSync(statusFile, status);

  executable(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
  executable(
    join(bin, 'ai-dossier'),
    '#!/bin/sh\nif [ "$2" = "status" ]; then cat "$STATUS_FILE"; else if [ -n "${MANIFEST_CAPTURE:-}" ] && [ "$5" = "--from-manifest" ]; then cat "$6" > "$MANIFEST_CAPTURE"; fi; printf \'enqueue ok\\n\'; fi\n'
  );
  executable(
    join(bin, 'crontab'),
    '#!/bin/sh\nset -eu\nif [ "$1" = "-l" ]; then\n  cat "$CRONTAB_FILE"\nelif [ "$1" = "-" ]; then\n  cat > "$CRONTAB_FILE"\nelse\n  exit 2\nfi\n'
  );
  return { home, fleet, cronFile, cronLog, statusFile, bin };
}

function runBootstrap(box, extraEnv = {}) {
  execFileSync('bash', [SCRIPT_PATH], {
    env: {
      ...process.env,
      CRONTAB_FILE: box.cronFile,
      CRONTAB_LOG: box.cronLog,
      HOME: box.home,
      SCHED_FLEET_HOME: box.fleet,
      STATUS_FILE: box.statusFile,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

describe('bootstrap.sh', () => {
  it('keeps the installed tick cron line and removes only the bootstrap line', () => {
    const box = bootstrapBox();
    const { fleet, cronFile } = box;
    writeFileSync(
      cronFile,
      `0 4 1 9 * ${fleet}/bootstrap.sh >> ${fleet}/bootstrap.log 2>&1\n*/2 * * * * ${fleet}/tick.sh >> ${fleet}/old.log 2>&1\n`
    );

    runBootstrap(box);

    const cron = readFileSync(cronFile, 'utf8');
    expect(cron).toContain(`*/2 * * * * ${fleet}/tick.sh >> ${fleet}/tick.log 2>&1`);
    expect(cron.split('\n').filter((line) => line.includes(`${fleet}/tick.sh`))).toHaveLength(1);
    expect(cron).not.toContain(`${fleet}/bootstrap.sh`);
    expect(existsSync(join(fleet, 'bootstrap.completed'))).toBe(true);
  });

  it('re-enqueues failed entries while leaving active entries out of the manifest', () => {
    const box = bootstrapBox(
      '{"queue":[{"issue":496,"status":"failed"},{"issue":500,"status":"queued"}],"failed":[{"issue":496,"status":"failed"}]}\n'
    );
    const manifestCapture = join(box.home, 'manifest.json');
    writeFileSync(box.cronFile, '0 4 1 9 * ' + box.fleet + '/bootstrap.sh\n');

    runBootstrap(box, { MANIFEST_CAPTURE: manifestCapture });

    const manifest = JSON.parse(readFileSync(manifestCapture, 'utf8'));
    expect(manifest.entries.map((entry) => entry.issue)).toEqual([496, 505, 507]);
  });

  it('arms a near-term retry cron when bootstrap fails', () => {
    const box = bootstrapBox();
    writeFileSync(box.cronFile, `0 4 1 9 * ${box.fleet}/bootstrap.sh\n`);
    executable(join(box.bin, 'npm'), '#!/bin/sh\nexit 7\n');

    expect(() => runBootstrap(box)).toThrow();

    expect(readFileSync(box.cronFile, 'utf8')).toContain(
      `*/5 * * * * ${box.fleet}/bootstrap.sh >> ${box.fleet}/bootstrap.log 2>&1`
    );
    expect(existsSync(join(box.fleet, 'bootstrap.completed'))).toBe(false);
  });

  it('uses an independent retry when bootstrap cannot read the crontab', () => {
    const box = bootstrapBox();
    const originalCron = `0 4 1 9 * ${box.fleet}/bootstrap.sh\n0 1 * * * unrelated.sh\n`;
    const atCommand = join(box.home, 'at-command');
    const atArgs = join(box.home, 'at-args');
    writeFileSync(box.cronFile, originalCron);
    executable(join(box.bin, 'npm'), '#!/bin/sh\nexit 7\n');
    executable(
      join(box.bin, 'crontab'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CRONTAB_LOG"\nprintf \'crontab unavailable\\n\' >&2\nexit 42\n'
    );
    executable(
      join(box.bin, 'at'),
      '#!/bin/sh\ncat > "$AT_COMMAND"\nprintf \'%s\\n\' "$*" > "$AT_ARGS"\nexit 0\n'
    );

    expect(() =>
      runBootstrap(box, {
        AT_ARGS: atArgs,
        AT_COMMAND: atCommand,
        SCHED_CRON_READ_ATTEMPTS: '1',
      })
    ).toThrow();

    expect(readFileSync(box.cronFile, 'utf8')).toBe(originalCron);
    expect(readFileSync(atArgs, 'utf8')).toContain('now + 5 minutes');
    expect(readFileSync(atCommand, 'utf8')).toContain(`SCHED_FLEET_HOME=${box.fleet}`);
    expect(existsSync(join(box.fleet, '.bootstrap.retry'))).toBe(true);
  });
});
