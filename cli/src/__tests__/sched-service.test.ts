import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as schedApi from '@ai-dossier/sched';
import { createEmptyState, enqueueEntries, Journal, SchedStore } from '@ai-dossier/sched';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readCrontabStrict,
  registerSchedServiceCommands,
  serviceIo,
} from '../commands/sched-service';
import { createAlertNotifier } from '../sched-alert';
import { ensureRunning, setEnsureDisabled } from '../sched-ensure';
import * as serviceApi from '../sched-service';
import {
  hasCronBlock,
  installAndVerifyService,
  installService,
  renderCronBlock,
  renderSystemdUnit,
  type ServiceIo,
  type ServiceSpec,
  serviceEnvPath,
  serviceStatus,
  stripCronBlock,
  uninstallService,
  unitName,
  upsertCronBlock,
  validateServicePaths,
} from '../sched-service';

const spec: ServiceSpec = {
  project: 'imboard-ai-ai-dossier',
  nodePath: '/home/u/.nvm/versions/node/v22.1.0/bin/node',
  cliPath: '/home/u/.nvm/versions/node/v22.1.0/bin/ai-dossier',
  repoDir: '/home/u/projects/ai-dossier/main',
  envPath: '/home/u/.nvm/versions/node/v22.1.0/bin:/usr/bin:/bin',
  autoUpgrade: true,
  alertIssue: 945,
};

describe('systemd unit rendering (#945 AC1)', () => {
  const unit = renderSystemdUnit(spec);

  it('is a self-restarting engine that leaves its agents running', () => {
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('KillMode=process');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('bounds a crash loop: start limits and exponential restart backoff', () => {
    expect(unit).toMatch(/^StartLimitIntervalSec=600$/m);
    expect(unit).toMatch(/^StartLimitBurst=10$/m);
    expect(unit).toMatch(/^RestartSec=10$/m);
    expect(unit).toMatch(/^RestartSteps=5$/m);
    expect(unit).toMatch(/^RestartMaxDelaySec=300$/m);
    expect(unit).not.toMatch(/^RestartSec=5$/m);
    // StartLimit* belong to [Unit]
    expect(unit.indexOf('StartLimitBurst')).toBeLessThan(unit.indexOf('[Service]'));
  });

  it('pins node, the CLI entry, the project checkout and the nvm PATH', () => {
    expect(unit).toContain(
      'ExecStart=/home/u/.nvm/versions/node/v22.1.0/bin/node /home/u/.nvm/versions/node/v22.1.0/bin/ai-dossier sched start --project imboard-ai-ai-dossier --auto-upgrade --alert-issue 945'
    );
    expect(unit).toContain('WorkingDirectory=/home/u/projects/ai-dossier/main\n');
    expect(unit).toContain(
      'Environment="PATH=/home/u/.nvm/versions/node/v22.1.0/bin:/usr/bin:/bin"'
    );
  });

  it('omits --auto-upgrade / --alert-issue when not requested', () => {
    const plain = renderSystemdUnit({ ...spec, autoUpgrade: false, alertIssue: undefined });
    expect(plain).toMatch(/sched start --project imboard-ai-ai-dossier\n/);
  });

  it('quotes systemd paths and escapes unit syntax; rejects newlines', () => {
    const odd = renderSystemdUnit({
      ...spec,
      cliPath: '/opt/my tools/100%/$bin/ai-dossier',
      repoDir: '/home/u/My Projects/100%/repo',
      envPath: '/opt/my "tools"/100%/bin:/usr/bin',
    });
    expect(odd).toContain('"/opt/my tools/100%%/$$bin/ai-dossier"');
    expect(odd).toContain('WorkingDirectory=/home/u/My Projects/100%%/repo\n');
    expect(odd).toContain('Environment="PATH=/opt/my \\"tools\\"/100%%/bin:/usr/bin"');
    expect(() => renderSystemdUnit({ ...spec, repoDir: '/x\nExecStart=/bin/evil' })).toThrow(
      /newline/
    );
  });

  it('names the unit per project, safely', () => {
    expect(unitName('a/b c')).toBe('dossier-sched-a-b-c.service');
  });

  it.each([
    '/repo\\path',
    '/repo"path',
    '/repo\tpath',
    '/repo\0path',
    '/repo ',
  ])('refuses unsupported WorkingDirectory characters: %j', (repoDir) => {
    expect(() => renderSystemdUnit({ ...spec, repoDir })).toThrow(/WorkingDirectory/);
  });
});

describe('serviceEnvPath', () => {
  it('drops relative entries and duplicates, keeps order', () => {
    expect(serviceEnvPath('./node_modules/.bin:/a/bin:relative:/b/bin:/a/bin:')).toBe(
      '/a/bin:/b/bin'
    );
  });
  it('falls back to the system dirs when nothing absolute remains', () => {
    expect(serviceEnvPath(undefined)).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(serviceEnvPath('.:rel')).toBe('/usr/local/bin:/usr/bin:/bin');
  });
});

describe('cron fallback block', () => {
  it('has @reboot and a per-minute ensure-running that cds into the repo', () => {
    const block = renderCronBlock(spec);
    expect(block).toContain('@reboot ');
    expect(block).toContain('* * * * * ');
    expect(block).toContain("cd '/home/u/projects/ai-dossier/main' &&");
    expect(block).toContain(
      "sched ensure-running --project 'imboard-ai-ai-dossier' --auto-upgrade --alert-issue 945"
    );
  });

  it('escapes % in the cron line (cron turns a bare % into a newline)', () => {
    const block = renderCronBlock({ ...spec, repoDir: '/home/u/100%/proj' });
    const lines = block
      .split('\n')
      .filter((l) => l.startsWith('* * * * *') || l.startsWith('@reboot'));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain("'/home/u/100\\%/proj'");
      expect(l).not.toMatch(/(^|[^\\])%/);
    }
  });

  it('upsert is idempotent, preserves foreign lines, and strip removes only this project', () => {
    const foreign = '0 3 * * * /usr/bin/backup\n';
    const once = upsertCronBlock(foreign, spec);
    const twice = upsertCronBlock(once, spec);
    expect(twice).toBe(once);
    expect(once.startsWith(foreign)).toBe(true);
    expect(hasCronBlock(once, spec.project)).toBe(true);
    const other = upsertCronBlock(once, { ...spec, project: 'other' });
    expect(stripCronBlock(other, spec.project)).toContain('# BEGIN dossier-sched other');
    expect(hasCronBlock(stripCronBlock(other, spec.project), spec.project)).toBe(false);
    expect(stripCronBlock(once, spec.project).trim()).toBe(foreign.trim());
  });

  it('a changed spec rewrites the block in place (no duplicates)', () => {
    const v1 = upsertCronBlock('', spec);
    const v2 = upsertCronBlock(v1, { ...spec, autoUpgrade: false });
    expect(v2.match(/# BEGIN dossier-sched/g)).toHaveLength(1);
    expect(v2).not.toContain('--auto-upgrade');
  });
});

describe('install / uninstall / status against temp dirs (never the real systemd)', () => {
  let dir: string;
  let calls: string[];
  let crontab: string;
  let io: ServiceIo;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-service-'));
    calls = [];
    crontab = '';
    io = {
      run: (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        if (args.includes('is-enabled')) return 'enabled';
        if (args.includes('is-active')) return 'active';
        return '';
      },
      unitDir: path.join(dir, 'units'),
      readCrontab: () => crontab,
      writeCrontab: (t) => {
        crontab = t;
        return true;
      },
      render: false,
    };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('systemd: writes the unit, reloads, enables and starts; identical installs still reload', () => {
    const first = installService(spec, 'systemd', io);
    expect(first.changed).toBe(true);
    expect(fs.readFileSync(first.unitPath as string, 'utf8')).toBe(renderSystemdUnit(spec));
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${unitName(spec.project)}`,
      `systemctl --user start ${unitName(spec.project)}`,
    ]);
    calls.length = 0;
    const second = installService(spec, 'systemd', io);
    expect(second.changed).toBe(false);
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${unitName(spec.project)}`,
      `systemctl --user start ${unitName(spec.project)}`,
    ]);
  });

  it('systemd: a changed unit is restarted so it takes effect', () => {
    installService(spec, 'systemd', io);
    calls.length = 0;
    installService({ ...spec, autoUpgrade: false }, 'systemd', io);
    expect(calls).toContain(`systemctl --user restart ${unitName(spec.project)}`);
  });

  it('render mode writes files only — no systemctl, no crontab — and never claims to be installed', () => {
    const r = installService(spec, 'systemd', { ...io, render: true });
    expect(fs.existsSync(r.unitPath as string)).toBe(true);
    expect(r).toMatchObject({ ok: true, activated: false });
    const c = installService(spec, 'cron', {
      ...io,
      render: true,
      readCrontab: () => {
        throw new Error('render mode must not read the crontab');
      },
    });
    expect(c).toMatchObject({ ok: true, activated: false, changed: false });
    expect(calls).toEqual([]);
    expect(crontab).toBe('');
  });

  it('cron: an unreadable crontab aborts the install and writes NOTHING (never overwrites a schedule we could not read)', () => {
    crontab = '0 3 * * * important-backup\n';
    const write = vi.fn(() => true);
    const r = installService(spec, 'cron', {
      ...io,
      readCrontab: () => {
        throw new Error('crontab -l exited 127: not found');
      },
      writeCrontab: write,
    });
    expect(r).toMatchObject({ ok: false, activated: false, changed: false });
    expect(r.notes.join(' ')).toMatch(/nothing was changed/);
    expect(write).not.toHaveBeenCalled();
    expect(crontab).toBe('0 3 * * * important-backup\n');
  });

  it('reports failure (ok=false) when systemctl enable or the crontab write fails', () => {
    const failing = installService(spec, 'systemd', {
      ...io,
      run: (_file, args) => (args.includes('enable') ? null : ''),
    });
    expect(failing.ok).toBe(false);
    expect(failing.notes.join(' ')).toMatch(/enable .* failed/);
    const cronFail = installService(spec, 'cron', { ...io, writeCrontab: () => false });
    expect(cronFail.ok).toBe(false);
  });

  it('uninstall reports errors instead of pretending: unreadable crontab, failed disable', () => {
    installService(spec, 'systemd', io);
    installService(spec, 'cron', io);
    const r = uninstallService(spec.project, {
      ...io,
      run: (_f, args) => (args.includes('disable') ? null : ''),
      readCrontab: () => {
        throw new Error('boom');
      },
    });
    expect(r.errors.join(' ')).toMatch(/disable --now/);
    expect(r.errors.join(' ')).toMatch(/could not read the crontab/);
    expect(crontab).toContain('BEGIN dossier-sched'); // untouched
  });

  it('cron: installs one block, idempotent; uninstall removes unit and block', () => {
    installService(spec, 'cron', io);
    installService(spec, 'cron', io);
    expect(crontab.match(/# BEGIN dossier-sched/g)).toHaveLength(1);
    installService(spec, 'systemd', io);
    calls.length = 0;
    const { removed } = uninstallService(spec.project, io);
    expect(removed).toHaveLength(2);
    expect(hasCronBlock(crontab, spec.project)).toBe(false);
    expect(calls).toContain(`systemctl --user disable --now ${unitName(spec.project)}`);
    expect(uninstallService(spec.project, io).removed).toEqual([]);
  });

  it('status reports supervision from the unit and the crontab', () => {
    expect(serviceStatus(spec.project, io).supervised).toBe(false);
    installService(spec, 'systemd', io);
    const s = serviceStatus(spec.project, io);
    expect(s.systemd).toMatchObject({ installed: true, enabled: 'enabled', active: 'active' });
    expect(s.supervised).toBe(true);
    uninstallService(spec.project, io);
    installService(spec, 'cron', io);
    expect(serviceStatus(spec.project, io)).toMatchObject({
      supervised: true,
      cron: { installed: true },
    });
  });
});

describe('systemd readiness (#1243)', () => {
  let dir: string;
  let io: ServiceIo;
  let clock: number;
  let state: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-ready-'));
    clock = 0;
    state = 'LoadState=loaded\nActiveState=active\nMainPID=42\nResult=success';
    io = {
      run: (_f, args) => (args.includes('show') ? state : ''),
      unitDir: dir,
      readCrontab: () => '',
      writeCrontab: () => true,
      render: false,
    };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const readiness = (lease: () => { alive: boolean; pid: number } | null) => ({
    lease,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    timeoutMs: 500,
  });

  it.each([
    'daemon-reload',
    'enable',
    'start',
    'restart',
  ])('preserves %s failure and stops activation', async (operation) => {
    if (operation === 'restart')
      installService({ ...spec, autoUpgrade: false }, 'systemd', { ...io, render: true });
    const calls: string[][] = [];
    io.run = (_file, args) => {
      calls.push(args);
      return args.includes(operation) ? null : '';
    };
    io.lastError = () => 'systemd: permission denied';
    const lease = vi.fn(() => null);
    const result = await installAndVerifyService(spec, 'systemd', io, readiness(lease));
    expect(result).toMatchObject({ ok: false, activated: false });
    expect(result.notes.join(' ')).toContain('systemd: permission denied');
    expect(calls.at(-1)).toContain(operation);
    expect(lease).not.toHaveBeenCalled();
  });

  it.each([
    'missing',
    'stale',
    'foreign',
    'inactive',
  ])('bounds readiness for a %s engine', async (kind) => {
    if (kind === 'inactive') state = state.replace('ActiveState=active', 'ActiveState=inactive');
    const result = await installAndVerifyService(
      spec,
      'systemd',
      io,
      readiness(() =>
        kind === 'missing' ? null : { alive: kind !== 'stale', pid: kind === 'foreign' ? 99 : 42 }
      )
    );
    expect(result).toMatchObject({ ok: false, activated: false });
    expect(result.notes.join(' ')).toContain('readiness failed (within 500ms)');
    expect(clock).toBe(500);
  });

  it('waits for active and a matching live lease', async () => {
    const result = await installAndVerifyService(
      spec,
      'systemd',
      io,
      readiness(() => (clock < 250 ? null : { alive: true, pid: 42 }))
    );
    expect(result).toMatchObject({ ok: true, activated: true });
    expect(clock).toBe(250);
  });

  it('render-only never probes readiness', async () => {
    const lease = vi.fn(() => null);
    const run = vi.fn(io.run);
    expect(
      await installAndVerifyService(spec, 'systemd', { ...io, run, render: true }, readiness(lease))
    ).toMatchObject({ ok: true, activated: false });
    expect(lease).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('reports load errors immediately even with a live lease', async () => {
    state =
      'LoadState=bad-setting\nLoadError=org.freedesktop.systemd1.BadUnitSetting WorkingDirectory is not absolute\nActiveState=inactive';
    const result = await installAndVerifyService(
      spec,
      'systemd',
      io,
      readiness(() => ({ alive: true, pid: 42 }))
    );
    expect(result.ok).toBe(false);
    expect(result.notes.join(' ')).toContain('WorkingDirectory is not absolute');
    expect(clock).toBe(0);
    expect(serviceStatus(spec.project, io)).toMatchObject({
      supervised: false,
      systemd: {
        loadState: 'bad-setting',
        loadError: expect.stringContaining('WorkingDirectory is not absolute'),
      },
    });
  });

  it.each(['failed', 'unavailable'])('retains %s manager diagnostics', async (kind) => {
    if (kind === 'failed')
      state = 'LoadState=loaded\nActiveState=failed\nResult=exit-code\nSubState=failed';
    else {
      io.run = (_f, args) => (args.includes('show') ? null : '');
      io.lastError = () => 'Failed to connect to bus';
    }
    const result = await installAndVerifyService(
      spec,
      'systemd',
      io,
      readiness(() => null)
    );
    expect(result).toMatchObject({ ok: false, activated: false });
    expect(result.notes.join(' ')).toContain(
      kind === 'failed' ? 'result=exit-code' : 'Failed to connect to bus'
    );
    expect(clock).toBe(0);
  });
});

describe('ensure-running watchdog', () => {
  let dir: string;
  let store: SchedStore;
  let journal: Journal;
  let clock: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ensure-'));
    store = new SchedStore(dir, path.join(dir, 'user-config.json'));
    journal = new Journal(dir);
    clock = Date.parse('2026-09-29T12:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const deps = (spawnEngine: (log: string) => number | null, notify = vi.fn()) => ({
    store,
    journal,
    notify,
    spawnEngine,
    now: () => new Date(clock),
  });
  const writeDeadLease = () => {
    const leaseDir = path.join(dir, '.sched-engine-lease');
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(leaseDir, 'holder.json'),
      JSON.stringify({ pid: 2 ** 22 - 3, pid_start: null, id: 'dead' })
    );
  };

  it('a live engine is left alone', () => {
    const acq = store.acquireEngineLease();
    const spawn = vi.fn(() => 1);
    expect(ensureRunning(deps(spawn))).toBe('alive');
    expect(spawn).not.toHaveBeenCalled();
    if (acq.acquired) store.releaseEngineLease(acq.lease);
  });

  it('no lease: starts the engine detached with its log under the sched dir, and journals it', () => {
    const spawn = vi.fn((_log: string) => 4321);
    expect(ensureRunning(deps(spawn))).toBe('started');
    expect(spawn).toHaveBeenCalledWith(path.join(dir, 'engine.log'));
    expect(journal.read().at(-1)).toMatchObject({
      event: 'engine-started',
      pid: 4321,
      reason: 'ensure-running',
    });
  });

  it('stale lease: alerts once per episode; at a 60 s cron cadence the crash loop backs off exponentially (no clock tricks)', () => {
    writeDeadLease();
    store.withLock(() => ({
      state: enqueueEntries(createEmptyState(), [{ issue: 9, deps: [] }], new Date(clock)),
      result: undefined,
    }));
    const notify = vi.fn();
    const spawn = vi.fn(() => 77);
    const minute = () => {
      const r = ensureRunning(deps(spawn, notify));
      clock += 60_000;
      return r;
    };
    // The engine dies after every start (the lease stays dead), watched once a minute.
    const outcomes = Array.from({ length: 8 }, minute);
    expect(outcomes).toEqual([
      'started', // no history
      'started', // gap 30 s < 60 s cadence
      'started', // gap 60 s <= 60 s
      'throttled', // gap 120 s
      'started', // 120 s elapsed
      'throttled', // gap 240 s ...
      'throttled',
      'throttled',
    ]);
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(notify).toHaveBeenCalledTimes(1); // same episode: still one alert
  });

  it('a live engine ends the crash-loop episode (backoff resets)', () => {
    writeDeadLease();
    const spawn = vi.fn(() => 77);
    ensureRunning(deps(spawn));
    expect(fs.existsSync(path.join(dir, '.ensure-running-last'))).toBe(true);
    fs.rmSync(path.join(dir, '.sched-engine-lease'), { recursive: true, force: true });
    const acq = store.acquireEngineLease();
    expect(ensureRunning(deps(spawn))).toBe('alive');
    expect(fs.existsSync(path.join(dir, '.ensure-running-last'))).toBe(false);
    if (acq.acquired) store.releaseEngineLease(acq.lease);
  });

  it('a healthy minute never resolves the alert repo (no gh call)', () => {
    const acq = store.acquireEngineLease();
    const repo = vi.fn(() => 'o/r');
    const notify = createAlertNotifier('p', repo, 945, { stateDir: dir });
    expect(ensureRunning({ ...deps(vi.fn(() => 1)), notify })).toBe('alive');
    expect(repo).not.toHaveBeenCalled();
    if (acq.acquired) store.releaseEngineLease(acq.lease);
  });

  it('a failed spawn is reported, not thrown', () => {
    expect(ensureRunning(deps(() => null))).toBe('start-failed');
    expect(journal.read().at(-1)).toMatchObject({ reason: 'ensure-running-spawn-failed' });
  });

  it('--disable stops the resurrection until --enable', () => {
    const spawn = vi.fn(() => 5);
    setEnsureDisabled(store, true);
    expect(ensureRunning(deps(spawn))).toBe('disabled');
    expect(spawn).not.toHaveBeenCalled();
    setEnsureDisabled(store, false);
    expect(ensureRunning(deps(spawn))).toBe('started');
  });
});

describe('validateServicePaths', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-paths-'));
  const ok = { ...spec };
  it('accepts stable existing absolute paths (with an nvm warning)', () => {
    const r = validateServicePaths(ok, () => true, '/tmp-elsewhere');
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/nvm/);
  });
  it('rejects missing, relative, temp and worktree paths', () => {
    const missing = validateServicePaths(ok, () => false, '/nonexistent-tmp');
    expect(missing.errors.length).toBe(3);
    expect(
      validateServicePaths({ ...ok, cliPath: 'ai-dossier' }, () => true, '/x').errors[0]
    ).toMatch(/not an absolute path/);
    expect(
      validateServicePaths(
        { ...ok, repoDir: '/home/u/projects/p/worktrees/feat-x' },
        () => true,
        '/x'
      ).errors[0]
    ).toMatch(/temporary or worktree/);
    expect(
      validateServicePaths({ ...ok, cliPath: `${real}/bin/ai-dossier` }, () => true, os.tmpdir())
        .errors[0]
    ).toMatch(/temporary or worktree/);
  });
});

describe('readCrontabStrict (fake crontab binary on PATH)', () => {
  let bin: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-crontab-'));
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const fake = (script: string) => {
    fs.writeFileSync(path.join(bin, 'crontab'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  };

  it('returns the text on success', () => {
    fake('echo "0 3 * * * backup"');
    expect(readCrontabStrict()).toBe('0 3 * * * backup\n');
  });

  it('preserves real systemctl stderr and exit status on install failure', () => {
    fake('exit 0');
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      '#!/bin/sh\necho "Failed to start: bad unit setting" >&2\nexit 5\n',
      { mode: 0o755 }
    );
    const result = installService(spec, 'systemd', serviceIo({ unitDir: path.join(bin, 'units') }));
    expect(result).toMatchObject({ ok: false, activated: false });
    expect(result.notes.join(' ')).toContain('Failed to start: bad unit setting');
    expect(result.notes.join(' ')).toContain('exit 5');
  });

  it('CLI install exits nonzero with systemctl reason, without a success message', async () => {
    fake('exit 0');
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      '#!/bin/sh\necho "Unit has a bad unit file setting" >&2\nexit 1\n',
      { mode: 0o755 }
    );
    const project = vi.spyOn(schedApi, 'resolveProjectSlug').mockReturnValue(spec.project);
    const paths = vi
      .spyOn(serviceApi, 'validateServicePaths')
      .mockReturnValue({ errors: [], warnings: [] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('test exit');
    });
    try {
      const command = new Command();
      registerSchedServiceCommands(command);
      await expect(
        command.parseAsync(
          [
            'service',
            'install',
            '--project',
            spec.project,
            '--repo-dir',
            spec.repoDir,
            '--mode',
            'systemd',
            '--unit-dir',
            path.join(bin, 'units'),
          ],
          { from: 'user' }
        )
      ).rejects.toThrow('test exit');
      expect(exit).toHaveBeenCalledWith(1);
      expect(error.mock.calls.flat().join(' ')).toContain('Unit has a bad unit file setting');
      expect(log).not.toHaveBeenCalled();
    } finally {
      project.mockRestore();
      paths.mockRestore();
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it.each([false, true])('status exposes load errors in CLI output (json=%s)', async (json) => {
    fake('exit 0');
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      '#!/bin/sh\ncase "$2" in\nshow) echo "LoadState=bad-setting"; echo "LoadError=WorkingDirectory is not absolute"; echo "ActiveState=inactive";;\n*) exit 1;;\nesac\n',
      { mode: 0o755 }
    );
    const unitDir = path.join(bin, 'units');
    installService(spec, 'systemd', { ...serviceIo({ unitDir }), render: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const command = new Command();
      registerSchedServiceCommands(command);
      await command.parseAsync(
        [
          'service',
          'status',
          '--project',
          spec.project,
          '--unit-dir',
          unitDir,
          ...(json ? ['--json'] : []),
        ],
        { from: 'user' }
      );
      const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(output).toContain('WorkingDirectory is not absolute');
      if (json)
        expect(JSON.parse(output)).toMatchObject({
          supervised: false,
          systemd: { loadState: 'bad-setting', loadError: 'WorkingDirectory is not absolute' },
        });
      else expect(output).toContain('systemd load: bad-setting');
    } finally {
      log.mockRestore();
    }
  });
  it('treats ONLY the exact "no crontab for <user>" as empty', () => {
    fake(`echo "no crontab for ${os.userInfo().username}" >&2; exit 1`);
    expect(readCrontabStrict()).toBe('');
    fake(`echo "no crontab for ${os.userInfo().username}; permission denied" >&2; exit 1`);
    expect(() => readCrontabStrict()).toThrow(/crontab -l exited 1/);
  });
  it('throws on any other failure (permission, wrong exit, spawn failure)', () => {
    fake('echo "crontab: must be privileged to use -l" >&2; exit 1');
    expect(() => readCrontabStrict()).toThrow(/must be privileged/);
    fake('echo "no crontab for alice" >&2; exit 2');
    expect(() => readCrontabStrict()).toThrow();
    fs.rmSync(path.join(bin, 'crontab'));
    process.env.PATH = bin; // no crontab binary at all
    expect(() => readCrontabStrict()).toThrow(/crontab -l failed/);
  });
});
