import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEmptyState, enqueueEntries, Journal, SchedStore } from '@ai-dossier/sched';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRunning, setEnsureDisabled } from '../sched-ensure';
import {
  hasCronBlock,
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

  it('pins node, the CLI entry, the project checkout and the nvm PATH', () => {
    expect(unit).toContain(
      'ExecStart=/home/u/.nvm/versions/node/v22.1.0/bin/node /home/u/.nvm/versions/node/v22.1.0/bin/ai-dossier sched start --project imboard-ai-ai-dossier --auto-upgrade --alert-issue 945'
    );
    expect(unit).toContain('WorkingDirectory=/home/u/projects/ai-dossier/main');
    expect(unit).toContain(
      'Environment="PATH=/home/u/.nvm/versions/node/v22.1.0/bin:/usr/bin:/bin"'
    );
  });

  it('omits --auto-upgrade / --alert-issue when not requested', () => {
    const plain = renderSystemdUnit({ ...spec, autoUpgrade: false, alertIssue: undefined });
    expect(plain).toMatch(/sched start --project imboard-ai-ai-dossier\n/);
  });

  it('quotes paths with spaces and escapes % and $; rejects newlines', () => {
    const odd = renderSystemdUnit({ ...spec, cliPath: '/opt/my tools/100%/ai-dossier' });
    expect(odd).toContain('"/opt/my tools/100%%/ai-dossier"');
    expect(() => renderSystemdUnit({ ...spec, repoDir: '/x\nExecStart=/bin/evil' })).toThrow(
      /newline/
    );
  });

  it('names the unit per project, safely', () => {
    expect(unitName('a/b c')).toBe('dossier-sched-a-b-c.service');
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

  it('systemd: writes the unit, reloads, enables --now; a second install changes nothing', () => {
    const first = installService(spec, 'systemd', io);
    expect(first.changed).toBe(true);
    expect(fs.readFileSync(first.unitPath as string, 'utf8')).toBe(renderSystemdUnit(spec));
    expect(calls).toEqual([
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${unitName(spec.project)}`,
    ]);
    calls.length = 0;
    const second = installService(spec, 'systemd', io);
    expect(second.changed).toBe(false);
    expect(calls).toEqual([`systemctl --user enable --now ${unitName(spec.project)}`]);
  });

  it('systemd: a changed unit is restarted so it takes effect', () => {
    installService(spec, 'systemd', io);
    calls.length = 0;
    installService({ ...spec, autoUpgrade: false }, 'systemd', io);
    expect(calls).toContain(`systemctl --user restart ${unitName(spec.project)}`);
  });

  it('render mode writes files only — no systemctl, no crontab', () => {
    const r = installService(spec, 'systemd', { ...io, render: true });
    expect(fs.existsSync(r.unitPath as string)).toBe(true);
    installService(spec, 'cron', { ...io, render: true });
    expect(calls).toEqual([]);
    expect(crontab).toBe('');
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

  it('stale lease: alerts once per episode and starts; throttles a crash loop', () => {
    writeDeadLease();
    store.withLock(() => ({
      state: enqueueEntries(createEmptyState(), [{ issue: 9, deps: [] }], new Date(clock)),
      result: undefined,
    }));
    const notify = vi.fn();
    const spawn = vi.fn(() => 77);
    expect(ensureRunning(deps(spawn, notify))).toBe('started');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1); // the stale-lease alert, once
    // engine died again within the throttle window: no second spawn
    clock += 5_000;
    expect(ensureRunning(deps(spawn, notify))).toBe('throttled');
    expect(spawn).toHaveBeenCalledTimes(1);
    clock += 60_000;
    expect(ensureRunning(deps(spawn, notify))).toBe('started');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1); // same episode: still one alert
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
