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

export const START_LIMIT_INTERVAL_SEC = 600;
export const START_LIMIT_BURST = 10;

export function renderSystemdUnit(spec: ServiceSpec): string {
  const exec = [spec.nodePath, spec.cliPath, ...startArgs(spec)].map(execArg).join(' ');
  return `${[
    '# Managed by `ai-dossier sched service install` (#945) — re-run it to update, `sched service uninstall` to remove.',
    '[Unit]',
    `Description=dossier sched engine (${unitValue(spec.project)})`,
    'After=network-online.target',
    'Wants=network-online.target',
    // A crash-looping engine must not restart every few seconds forever: at most
    // START_LIMIT_BURST starts per START_LIMIT_INTERVAL_SEC, then the unit is left
    // `failed` for an operator (`systemctl --user reset-failed <unit>` + start).
    `StartLimitIntervalSec=${START_LIMIT_INTERVAL_SEC}`,
    `StartLimitBurst=${START_LIMIT_BURST}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${unitValue(spec.repoDir)}`,
    `Environment="PATH=${unitValue(spec.envPath)}"`,
    `ExecStart=${exec}`,
    // Always: a clean exit (a graceful stop, an upgrade restart) must come back too.
    'Restart=always',
    // Exponential backoff between restarts (systemd >= 254; older versions ignore
    // the two Restart*= lines below with a warning and keep RestartSec).
    'RestartSec=10',
    'RestartSteps=5',
    'RestartMaxDelaySec=300',
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
  // cron turns an unescaped `%` in a command into a newline (and feeds the rest to stdin).
  const ensure =
    `${cmd} sched ensure-running --project ${shq(spec.project)}${spec.autoUpgrade ? ' --auto-upgrade' : ''}${spec.alertIssue !== undefined ? ` --alert-issue ${spec.alertIssue}` : ''}`.replace(
      /%/g,
      '\\%'
    );
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

/**
 * A supervisor pins absolute paths at install time, so an ephemeral one (a temp
 * dir, a batch/issue worktree, a removed checkout) silently breaks it later.
 * Returns hard errors (refuse to install) and soft warnings.
 */
export function validateServicePaths(
  spec: ServiceSpec,
  exists: (p: string) => boolean = fs.existsSync,
  tmp: string = os.tmpdir()
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ephemeral = (p: string) =>
    p === tmp || p.startsWith(`${tmp}${path.sep}`) || p.split(path.sep).includes('worktrees');
  for (const [label, p] of [
    ['node binary', spec.nodePath],
    ['ai-dossier entry point', spec.cliPath],
    ['repository', spec.repoDir],
  ] as const) {
    if (!path.isAbsolute(p)) errors.push(`${label} is not an absolute path: ${p}`);
    else if (!exists(p)) errors.push(`${label} does not exist: ${p}`);
    else if (ephemeral(p)) {
      errors.push(
        `${label} is under a temporary or worktree directory (${p}) — it will not survive; install from the project's main checkout with a global ai-dossier`
      );
    }
  }
  if (spec.nodePath.includes(`${path.sep}.nvm${path.sep}versions${path.sep}`)) {
    warnings.push(
      'node is an nvm version path: after `nvm install`/upgrading node, re-run `sched service install` to re-pin it.'
    );
  }
  return { errors, warnings };
}

// --- operations (injected I/O) ---

/** Run a command; null on failure (the `ExecFn` contract). */
export type RunFn = (file: string, args: string[]) => string | null;

export interface ServiceIo {
  run: RunFn;
  /** Directory for the systemd user unit (default `~/.config/systemd/user`). */
  unitDir: string;
  /**
   * The current crontab text. `''` ONLY when the user verifiably has none
   * ("no crontab for <user>"); any other failure THROWS — installing over an
   * unreadable crontab would overwrite the user's whole schedule.
   */
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
  /** False when anything the install had to do failed — the caller must exit non-zero. */
  ok: boolean;
  /** True only when the supervisor is really active (enabled/started, or the crontab written); false under render-only. */
  activated: boolean;
  unitPath?: string;
  notes: string[];
}

export function installService(spec: ServiceSpec, mode: ServiceMode, io: ServiceIo): InstallResult {
  const notes: string[] = [];
  let ok = true;
  const activated = !io.render;
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
      const unit = unitName(spec.project);
      if (changed && io.run('systemctl', ['--user', 'daemon-reload']) === null) {
        ok = false;
        notes.push('systemctl --user daemon-reload failed');
      }
      // enable --now is idempotent; it also (re)starts an inactive unit.
      if (io.run('systemctl', ['--user', 'enable', '--now', unit]) === null) {
        ok = false;
        notes.push(`systemctl --user enable --now ${unit} failed`);
      } else if (changed && previous !== null) {
        if (io.run('systemctl', ['--user', 'restart', unit]) === null) {
          ok = false;
          notes.push(`systemctl --user restart ${unit} failed`);
        } else {
          notes.push('unit changed: restarted (agents keep running — KillMode=process)');
        }
      }
      notes.push(
        'Run `loginctl enable-linger $USER` once so the service starts at boot without a login session.'
      );
    }
    return { mode, changed, ok, activated, unitPath, notes };
  }
  // cron: render-only never reads or writes the crontab.
  if (io.render) {
    return { mode, changed: false, ok: true, activated: false, notes };
  }
  let current: string;
  try {
    current = io.readCrontab();
  } catch (err) {
    notes.push(`could not read the crontab — nothing was changed: ${(err as Error).message}`);
    return { mode, changed: false, ok: false, activated: false, notes };
  }
  const next = upsertCronBlock(current, spec);
  const changed = next !== current;
  if (changed && !io.writeCrontab(next)) {
    ok = false;
    notes.push('could not write the crontab');
  }
  return { mode, changed, ok, activated, notes };
}

export function uninstallService(
  project: string,
  io: ServiceIo
): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  const unitPath = path.join(io.unitDir, unitName(project));
  if (fs.existsSync(unitPath)) {
    if (
      !io.render &&
      io.run('systemctl', ['--user', 'disable', '--now', unitName(project)]) === null
    ) {
      errors.push(`systemctl --user disable --now ${unitName(project)} failed`);
    }
    fs.rmSync(unitPath, { force: true });
    if (!io.render && io.run('systemctl', ['--user', 'daemon-reload']) === null) {
      errors.push('systemctl --user daemon-reload failed');
    }
    removed.push(unitPath);
  }
  if (!io.render) {
    let crontab: string | null = null;
    try {
      crontab = io.readCrontab();
    } catch (err) {
      errors.push(
        `could not read the crontab — its block (if any) was not removed: ${(err as Error).message}`
      );
    }
    if (crontab !== null && hasCronBlock(crontab, project)) {
      if (io.writeCrontab(stripCronBlock(crontab, project))) removed.push('crontab block');
      else errors.push('could not write the crontab');
    }
  }
  return { removed, errors };
}

export interface ServiceStatus {
  project: string;
  systemd: { installed: boolean; enabled: string | null; active: string | null; unitPath: string };
  cron: { installed: boolean; error?: string };
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
  let cronInstalled = false;
  let cronError: string | undefined;
  if (!io.render) {
    try {
      cronInstalled = hasCronBlock(io.readCrontab(), project);
    } catch (err) {
      cronError = (err as Error).message;
    }
  }
  return {
    project,
    systemd: { installed, enabled, active, unitPath },
    cron: { installed: cronInstalled, ...(cronError ? { error: cronError } : {}) },
    supervised: (installed && (active === 'active' || io.render)) || cronInstalled,
  };
}
