/**
 * `sched service install|uninstall|status` and `sched ensure-running` (#945 AC1).
 * The logic lives in `../sched-service` and `../sched-ensure` (injectable, unit
 * tested); this file is only argument handling and process wiring.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import {
  defaultExec,
  Journal,
  resolveProjectRepo,
  resolveProjectSlug,
  SchedStore,
  schedStateDir,
} from '@ai-dossier/sched';
import type { Command } from 'commander';
import { fail } from '../helpers';
import { createAlertNotifier, parseAlertIssue } from '../sched-alert';
import { ensureRunning, setEnsureDisabled } from '../sched-ensure';
import {
  defaultUnitDir,
  installService,
  renderCronBlock,
  renderSystemdUnit,
  type ServiceIo,
  type ServiceMode,
  type ServiceSpec,
  serviceEnvPath,
  serviceStatus,
  systemdUserAvailable,
  uninstallService,
} from '../sched-service';

interface ServiceOptions {
  project?: string;
  mode?: string;
  autoUpgrade?: boolean;
  alertIssue?: string;
  unitDir?: string;
  activate?: boolean;
  print?: boolean;
  json?: boolean;
}

const run = (file: string, args: string[]): string | null => {
  try {
    return String(
      execFileSync(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
      })
    ).trim();
  } catch {
    return null;
  }
};

function realIo(opts: ServiceOptions): ServiceIo {
  return {
    run,
    unitDir: opts.unitDir ?? defaultUnitDir(),
    // `crontab -l` exits 1 with "no crontab for <user>" when there is none.
    readCrontab: () => run('crontab', ['-l']) ?? '',
    writeCrontab: (text) => {
      try {
        execFileSync('crontab', ['-'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
        return true;
      } catch {
        return false;
      }
    },
    render: opts.activate === false,
  };
}

function projectOf(opts: ServiceOptions): string {
  return opts.project ?? resolveProjectSlug(defaultExec);
}

function buildSpec(opts: ServiceOptions, project: string): ServiceSpec {
  const repoDir = run('git', ['rev-parse', '--show-toplevel']) ?? process.cwd();
  const cliPath = process.argv[1];
  if (!cliPath) fail(['cannot determine the ai-dossier entry point (process.argv[1] is empty)']);
  let alertIssue: number | undefined;
  try {
    alertIssue = parseAlertIssue(opts.alertIssue);
  } catch (err) {
    fail([(err as Error).message]);
  }
  return {
    project,
    nodePath: process.execPath,
    cliPath,
    repoDir,
    envPath: serviceEnvPath(process.env.PATH),
    // The service default is self-upgrading (#945): a supervised engine that never upgrades drifts.
    autoUpgrade: opts.autoUpgrade !== false,
    ...(alertIssue !== undefined ? { alertIssue } : {}),
  };
}

function chooseMode(raw: string | undefined, io: ServiceIo): ServiceMode {
  if (raw === 'systemd' || raw === 'cron') return raw;
  if (raw !== undefined && raw !== 'auto')
    fail([`--mode must be systemd, cron or auto, got '${raw}'`]);
  return io.render || systemdUserAvailable(io.run) ? 'systemd' : 'cron';
}

export function registerSchedServiceCommands(sched: Command): void {
  const service = sched
    .command('service')
    .description(
      'Run the engine supervised (#945): a systemd user unit (Restart=always, KillMode=process) or, without systemd, a cron @reboot + per-minute `sched ensure-running` watchdog. THE supported way to run it.'
    );

  service
    .command('install')
    .description('Write and enable the supervisor for this project (idempotent; re-run to update)')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option(
      '--mode <mode>',
      'systemd | cron | auto (default auto: systemd when a user manager is running)'
    )
    .option(
      '--no-auto-upgrade',
      'Do not run the engine with --auto-upgrade (default: on under the service)'
    )
    .option(
      '--alert-issue <n>',
      'Tracking issue the engine comments on when it restarts after a crash'
    )
    .option('--unit-dir <dir>', 'Where to write the systemd unit (default ~/.config/systemd/user)')
    .option(
      '--no-activate',
      'Only write the unit / render the cron block — never call systemctl or crontab'
    )
    .option('--print', 'Print the unit / cron block instead of installing anything')
    .action((opts: ServiceOptions) => {
      const project = projectOf(opts);
      const spec = buildSpec(opts, project);
      const io = realIo(opts);
      const mode = chooseMode(opts.mode, io);
      if (opts.print) {
        console.log(mode === 'systemd' ? renderSystemdUnit(spec) : renderCronBlock(spec));
        return;
      }
      const result = installService(spec, mode, io);
      setEnsureDisabled(new SchedStore(schedStateDir(project)), false);
      console.log(
        `✓ [${project}] ${mode} supervisor ${result.changed ? 'installed/updated' : 'already up to date'}${result.unitPath ? ` (${result.unitPath})` : ''}`
      );
      for (const n of result.notes) console.log(`  ${n}`);
    });

  service
    .command('uninstall')
    .description(
      'Disable and remove the supervisor (systemd unit and/or cron block) for this project'
    )
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--unit-dir <dir>', 'Systemd unit directory (default ~/.config/systemd/user)')
    .option('--no-activate', 'Only remove files — never call systemctl or crontab')
    .action((opts: ServiceOptions) => {
      const project = projectOf(opts);
      const { removed } = uninstallService(project, realIo(opts));
      console.log(
        removed.length > 0
          ? `✓ [${project}] removed: ${removed.join(', ')}`
          : `[${project}] no supervisor installed`
      );
    });

  service
    .command('status')
    .description('Is the engine supervised, and is it running?')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--unit-dir <dir>', 'Systemd unit directory (default ~/.config/systemd/user)')
    .option('--json', 'Output as JSON')
    .action((opts: ServiceOptions) => {
      const project = projectOf(opts);
      const status = serviceStatus(project, realIo(opts));
      const lease = new SchedStore(schedStateDir(project)).engineLeaseStatus();
      if (opts.json) {
        console.log(JSON.stringify({ ...status, engine_lease: lease }, null, 2));
        return;
      }
      console.log(`Project: ${project}`);
      console.log(
        `systemd unit: ${status.systemd.installed ? `installed (${status.systemd.enabled ?? '?'}, ${status.systemd.active ?? '?'})` : 'not installed'}`
      );
      console.log(`cron watchdog: ${status.cron.installed ? 'installed' : 'not installed'}`);
      console.log(
        `engine: ${lease ? `pid ${lease.pid} ${lease.alive ? 'live' : 'STALE'}${lease.updated_at ? `, heartbeat ${lease.updated_at}` : ''}` : 'no lease (not running)'}`
      );
      if (!status.supervised) {
        console.log(
          '⚠ NOT supervised — a crash or reboot leaves the queue unattended. Run `ai-dossier sched service install`.'
        );
      }
    });

  sched
    .command('ensure-running')
    .description(
      'Watchdog (cron, every minute): start the engine detached if no live engine holds the lease, after raising the once-per-episode stale-lease alert (#945)'
    )
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--auto-upgrade', 'Start the engine with --auto-upgrade')
    .option('--alert-issue <n>', 'Tracking issue for stale-lease / crash alerts')
    .option('--disable', 'Stop resurrecting the engine (operator stopped it on purpose)')
    .option('--enable', 'Resume resurrecting the engine')
    .action((opts: ServiceOptions & { disable?: boolean; enable?: boolean }) => {
      const project = projectOf(opts);
      const store = new SchedStore(schedStateDir(project));
      if (opts.disable || opts.enable) {
        setEnsureDisabled(store, opts.disable === true);
        console.log(`✓ [${project}] ensure-running ${opts.disable ? 'disabled' : 'enabled'}`);
        return;
      }
      let alertIssue: number | undefined;
      try {
        alertIssue = parseAlertIssue(opts.alertIssue);
      } catch (err) {
        fail([(err as Error).message]);
      }
      const outcome = ensureRunning({
        store,
        journal: new Journal(store.dir),
        notify: createAlertNotifier(
          project,
          resolveProjectRepo(project, defaultExec) ?? undefined,
          alertIssue
        ),
        now: () => new Date(),
        spawnEngine: (logFile) => {
          try {
            fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
            const fd = fs.openSync(logFile, 'a', 0o600);
            const child = spawn(
              process.execPath,
              [
                process.argv[1] as string,
                'sched',
                'start',
                '--project',
                project,
                ...(opts.autoUpgrade ? ['--auto-upgrade'] : []),
                ...(alertIssue !== undefined ? ['--alert-issue', String(alertIssue)] : []),
              ],
              { cwd: process.cwd(), detached: true, stdio: ['ignore', fd, fd] }
            );
            child.unref();
            fs.closeSync(fd);
            return child.pid ?? null;
          } catch {
            return null;
          }
        },
      });
      if (outcome !== 'alive') console.log(`[${project}] ensure-running: ${outcome}`);
    });
}
