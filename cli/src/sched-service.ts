/**
 * Supervised engine deployment (#945 AC1): `sched service install|uninstall|status`.
 *
 * The engine is safe to kill at any instant (lease + heartbeat, crash-safe
 * state, work preserved before respawn) — what it cannot do is restart ITSELF.
 * This module makes the supervisor the default rather than a paragraph in a
 * README:
 *
 *  - systemd *user* unit `dossier-sched-<project>.service`: Restart=always,
 *    KillMode=process (agents outlive the engine, #679), the node/nvm PATH
 *    captured at install time, WorkingDirectory = the project checkout (the
 *    engine treats its cwd as the repo). Output goes to the journal
 *    (`journalctl --user -u <unit>`); the engine's own `events.jsonl` journal
 *    is the durable per-project trail.
 *  - non-systemd fallback: a tagged crontab block — `@reboot` plus a
 *    once-a-minute `sched ensure-running` watchdog that starts the engine when
 *    its lease is stale or absent.
 *
 * Everything is injectable (exec, fs roots, crontab I/O) so unit generation and
 * both install paths are tested against temp directories — no test, and no
 * dry run, ever touches the real systemd or crontab.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ServiceMode = 'systemd' | 'cron';

export interface ServiceSpec {
  project: string;
  /** Node binary (`process.execPath`) — an absolute path, so nvm needs no shell init. */
  nodePath: string;
  /** The CLI entry the unit runs (`process.argv[1]`, the `ai-dossier` launcher — stable across `npm i -g`). */
  cliPath: string;
  /** The project's checkout: WorkingDirectory / cron `cd`. */
  repoDir: string;
  /** PATH captured at install time (nvm's node dir, gh, git, claude). */
  envPath: string;
  autoUpgrade: boolean;
  alertIssue?: number;
}

/**
 * PATH for a long-lived service: absolute entries only (a relative one such as
 * `./node_modules/.bin` would resolve against the service's cwd — the project
 * checkout — letting a repo's files shadow `git`/`gh`), de-duplicated in order.
 */
export function serviceEnvPath(raw: string | undefined): string {
  const seen = new Set<string>();
  for (const entry of (raw ?? '').split(':')) {
    if (entry.startsWith('/') && !seen.has(entry)) seen.add(entry);
  }
  return seen.size > 0 ? [...seen].join(':') : '/usr/local/bin:/usr/bin:/bin';
}

export const SERVICE_PREFIX = 'dossier-sched-';

export function unitName(project: string): string {
  return `${SERVICE_PREFIX}${project.replace(/[^A-Za-z0-9._-]+/g, '-')}.service`;
}

/** Systemd unit values may not contain newlines and are `%`-expanded — reject/escape both. */
function unitValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`refusing a newline in a unit value: ${JSON.stringify(v)}`);
  return v.replace(/%/g, '%%');
}

/** Quote one ExecStart argument (systemd's own quoting: double quotes, `\"` and `\\`). */
function execArg(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`refusing a newline in an ExecStart argument`);
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');
  return /^[A-Za-z0-9_./:@=+-]+$/.test(v) ? escaped : `"${escaped}"`;
}

export function startArgs(spec: ServiceSpec): string[] {
  return [
    'sched',
    'start',
    '--project',
    spec.project,
    ...(spec.autoUpgrade ? ['--auto-upgrade'] : []),
    ...(spec.alertIssue !== undefined ? ['--alert-issue', String(spec.alertIssue)] : []),
  ];
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const exec = [spec.nodePath, spec.cliPath, ...startArgs(spec)].map(execArg).join(' ');
  return `${[
    '# Managed by `ai-dossier sched service install` (#945) — re-run it to update, `sched service uninstall` to remove.',
    '[Unit]',
    `Description=dossier sched engine (${unitValue(spec.project)})`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${unitValue(spec.repoDir)}`,
    `Environment="PATH=${unitValue(spec.envPath)}"`,
    `ExecStart=${exec}`,
    // Always: a clean exit (graceful stop, self-upgrade re-exec) must come back too.
    'Restart=always',
    'RestartSec=5',
    // Kill ONLY the engine on stop/restart — dispatched agents outlive it (#679).
    'KillMode=process',
    'TimeoutStopSec=60',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n')}\n`;
}

// --- cron fallback ---

const CRON_BEGIN = (project: string) => `# BEGIN dossier-sched ${project}`;
const CRON_END = (project: string) => `# END dossier-sched ${project}`;

/** Single-quote for /bin/sh. */
function shq(v: string): string {
  if (/[\r\n\0]/.test(v)) throw new Error('refusing a newline in a cron value');
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export function renderCronBlock(spec: ServiceSpec): string {
  const cmd = `cd ${shq(spec.repoDir)} && PATH=${shq(spec.envPath)} ${shq(spec.nodePath)} ${shq(spec.cliPath)}`;
  const ensure = `${cmd} sched ensure-running --project ${shq(spec.project)}${spec.autoUpgrade ? ' --auto-upgrade' : ''}${spec.alertIssue !== undefined ? ` --alert-issue ${spec.alertIssue}` : ''}`;
  return [
    CRON_BEGIN(spec.project),
    `@reboot ${ensure} >/dev/null 2>&1`,
    `* * * * * ${ensure} >/dev/null 2>&1`,
    CRON_END(spec.project),
  ].join('\n');
}

/** Remove this project's tagged block from a crontab; returns the text unchanged when there is none. */
export function stripCronBlock(crontab: string, project: string): string {
  const lines = crontab.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line === CRON_BEGIN(project)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line === CRON_END(project)) skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function hasCronBlock(crontab: string, project: string): boolean {
  return crontab.split('\n').includes(CRON_BEGIN(project));
}

/** New crontab text with exactly one up-to-date block for `spec.project` (idempotent). */
export function upsertCronBlock(crontab: string, spec: ServiceSpec): string {
  const base = stripCronBlock(crontab, spec.project).replace(/\n+$/, '');
  return `${base === '' ? '' : `${base}\n`}${renderCronBlock(spec)}\n`;
}

// --- operations (injected I/O) ---

/** Run a command; null on failure (the `ExecFn` contract). */
export type RunFn = (file: string, args: string[]) => string | null;

export interface ServiceIo {
  run: RunFn;
  /** Directory for the systemd user unit (default `~/.config/systemd/user`). */
  unitDir: string;
  readCrontab: () => string;
  writeCrontab: (text: string) => boolean;
  /** When true no `systemctl`/`crontab` is invoked — files are only rendered (tests, `--no-activate`). */
  render: boolean;
}

export function defaultUnitDir(home = os.homedir()): string {
  return path.join(home, '.config', 'systemd', 'user');
}

/** Whether `systemctl --user` is usable here (a user manager is running). */
export function systemdUserAvailable(run: RunFn): boolean {
  return run('systemctl', ['--user', 'show-environment']) !== null;
}

export interface InstallResult {
  mode: ServiceMode;
  changed: boolean;
  unitPath?: string;
  notes: string[];
}

export function installService(spec: ServiceSpec, mode: ServiceMode, io: ServiceIo): InstallResult {
  const notes: string[] = [];
  if (mode === 'systemd') {
    const unitPath = path.join(io.unitDir, unitName(spec.project));
    const text = renderSystemdUnit(spec);
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(unitPath, 'utf8');
    } catch {
      // not installed yet
    }
    const changed = previous !== text;
    if (changed) {
      fs.mkdirSync(io.unitDir, { recursive: true });
      fs.writeFileSync(unitPath, text, { mode: 0o644 });
    }
    if (!io.render) {
      if (changed) io.run('systemctl', ['--user', 'daemon-reload']);
      // enable --now is idempotent; it also (re)starts an inactive unit.
      if (io.run('systemctl', ['--user', 'enable', '--now', unitName(spec.project)]) === null) {
        notes.push(`systemctl --user enable --now ${unitName(spec.project)} failed`);
      } else if (changed && previous !== null) {
        io.run('systemctl', ['--user', 'restart', unitName(spec.project)]);
        notes.push('unit changed: restarted (agents keep running — KillMode=process)');
      }
      notes.push(
        'Run `loginctl enable-linger $USER` once so the service starts at boot without a login session.'
      );
    }
    return { mode, changed, unitPath, notes };
  }
  const current = io.render ? '' : io.readCrontab();
  const next = upsertCronBlock(current, spec);
  const changed = next !== current;
  if (!io.render && changed && !io.writeCrontab(next)) {
    notes.push('could not write the crontab');
  }
  return { mode, changed, notes };
}

export function uninstallService(project: string, io: ServiceIo): { removed: string[] } {
  const removed: string[] = [];
  const unitPath = path.join(io.unitDir, unitName(project));
  if (fs.existsSync(unitPath)) {
    if (!io.render) {
      io.run('systemctl', ['--user', 'disable', '--now', unitName(project)]);
    }
    fs.rmSync(unitPath, { force: true });
    if (!io.render) io.run('systemctl', ['--user', 'daemon-reload']);
    removed.push(unitPath);
  }
  if (!io.render) {
    const crontab = io.readCrontab();
    if (hasCronBlock(crontab, project)) {
      io.writeCrontab(stripCronBlock(crontab, project));
      removed.push('crontab block');
    }
  }
  return { removed };
}

export interface ServiceStatus {
  project: string;
  systemd: { installed: boolean; enabled: string | null; active: string | null; unitPath: string };
  cron: { installed: boolean };
  supervised: boolean;
}

export function serviceStatus(project: string, io: ServiceIo): ServiceStatus {
  const unitPath = path.join(io.unitDir, unitName(project));
  const installed = fs.existsSync(unitPath);
  const enabled =
    installed && !io.render
      ? io.run('systemctl', ['--user', 'is-enabled', unitName(project)])
      : null;
  const active =
    installed && !io.render
      ? io.run('systemctl', ['--user', 'is-active', unitName(project)])
      : null;
  const cronInstalled = io.render ? false : hasCronBlock(io.readCrontab(), project);
  return {
    project,
    systemd: { installed, enabled, active, unitPath },
    cron: { installed: cronInstalled },
    supervised: (installed && (active === 'active' || io.render)) || cronInstalled,
  };
}
