/**
 * `ai-dossier usage sync` (#782): refresh this host's persisted ledger, then
 * exchange bundles with other hosts over ssh.
 *
 * Transport = the ssh the fleet already relies on (wls is the only host that can
 * reach the others — see scripts/refresh-fleet.sh), streaming the bundle over
 * stdin/stdout: no new secrets, no shared drop, no service. `sync --hosts a,b`
 * is bidirectional so ONE run from wls leaves every host with every host's rows:
 * pull (`ssh a usage export --all`) → merge locally → push (`ssh a usage import -`).
 * The same bundles move by hand with `usage export` / `usage import <file>`.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type CollectOptions, collectLedger, defaultLedgerPaths, type LedgerPaths } from './ledger';
import {
  buildBundle,
  type ImportResult,
  importBundle,
  isValidHostId,
  listHosts,
  localHostId,
  newestTs,
  persistLocal,
  usageStoreDir,
} from './store';

const DAY = 86_400_000;
// Limit: `sync` re-collects only CURSOR_OVERLAP_MS before its cursor, so an attribution change
// (dispatch/prep join) to a row older than that is not re-persisted or re-sent; run
// `usage sync --since <older>` to force a wider refresh.
/** First-ever sync looks this far back; later ones resume from the ledger's newest row. */
export const DEFAULT_INITIAL_SYNC_MS = 30 * DAY;
/** Re-collect this far before the cursor: recent rows' attribution (dispatch/prep) can be refined after the fact. */
export const CURSOR_OVERLAP_MS = DAY;

export interface RefreshDeps {
  dir?: string;
  paths?: LedgerPaths;
  host?: string;
  nowMs?: number;
  openOpenCode?: CollectOptions['openOpenCode'];
}

export interface RefreshResult {
  host: string;
  since: string;
  collected: number;
  added: number;
  updated: number;
  total: number;
}

/** Collect this host's stores since the cursor (or `sinceMs`) and upsert them into its ledger file. */
export function refreshLocal(deps: RefreshDeps = {}, sinceMs?: number): RefreshResult {
  const dir = deps.dir ?? usageStoreDir();
  const host = deps.host ?? localHostId();
  const nowMs = deps.nowMs ?? Date.now();
  const cursor = newestTs(dir, host);
  const since =
    sinceMs ?? (cursor !== null ? cursor - CURSOR_OVERLAP_MS : nowMs - DEFAULT_INITIAL_SYNC_MS);
  const ledger = collectLedger({
    sinceMs: since,
    untilMs: nowMs,
    paths: deps.paths ?? defaultLedgerPaths(),
    host,
    openOpenCode: deps.openOpenCode,
  });
  const stats = persistLocal(dir, host, ledger.rows, ledger.limits);
  return {
    host,
    since: new Date(since).toISOString(),
    collected: ledger.rows.length,
    added: stats.added,
    updated: stats.updated,
    total: stats.total,
  };
}

// ---------------------------------------------------------------------------
// ssh transport
// ---------------------------------------------------------------------------

/**
 * Same resolution as refresh-fleet.sh's REMOTE_PRELUDE: a non-login ssh shell has
 * no nvm on PATH, and a repo-local `node_modules/.bin/ai-dossier` can shadow the
 * global install — so source nvm and prefer the global binary explicitly.
 */
export const REMOTE_PRELUDE = [
  'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1;',
  'AD="$(npm root -g 2>/dev/null)/@ai-dossier/cli/bin/ai-dossier";',
  '[ -x "$AD" ] || AD="$(command -v ai-dossier || true)";',
  '[ -n "$AD" ] || { echo "no ai-dossier binary found" >&2; exit 90; };',
].join(' ');

export interface SshResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type SshRunner = (host: string, script: string, input?: string) => SshResult;

/** A remote that hangs mid-transfer must not wedge a fleet sync (ConnectTimeout only covers connecting). */
const SSH_TIMEOUT_MS = 10 * 60 * 1000;

export const defaultSsh: SshRunner = (host, script, input) => {
  const r = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `${REMOTE_PRELUDE}\n${script}`],
    { input, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024, timeout: SSH_TIMEOUT_MS }
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
};

export interface RemoteSyncResult {
  host: string;
  ok: boolean;
  error?: string;
  pulled?: ImportResult;
  pushed_rows?: number;
  push?: ImportResult | null;
}

/** Per remote: the last successful pull and push, tracked apart so one direction never skips the other's backlog. */
interface SyncState {
  remotes: Record<string, { pull?: string; push?: string }>;
}

function readState(dir: string): SyncState {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'sync-state.json'), 'utf-8')) as SyncState;
    if (!s || typeof s.remotes !== 'object' || !s.remotes) return { remotes: {} };
    // Legacy/garbled entries reset to a full initial window rather than being trusted.
    for (const [h, v] of Object.entries(s.remotes))
      if (!v || typeof v !== 'object') delete s.remotes[h];
    return s;
  } catch {
    return { remotes: {} };
  }
}

function writeState(dir: string, state: SyncState): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sync-state.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export interface SyncOptions {
  hosts: readonly string[];
  /** Override the incremental cursor: exchange rows at or after this time. */
  sinceMs?: number;
  push?: boolean;
  pull?: boolean;
}

/** Exchange bundles with each remote. Per-host failures are reported, never thrown. */
export function syncWithRemotes(
  opts: SyncOptions,
  deps: RefreshDeps & { ssh?: SshRunner } = {}
): RemoteSyncResult[] {
  const dir = deps.dir ?? usageStoreDir();
  const local = deps.host ?? localHostId();
  const nowMs = deps.nowMs ?? Date.now();
  const ssh = deps.ssh ?? defaultSsh;
  const state = readState(dir);
  const results = new Map<string, RemoteSyncResult>();
  const initial = nowMs - DEFAULT_INITIAL_SYNC_MS;
  const cursorOf = (host: string, dir_: 'pull' | 'push'): number => {
    if (opts.sinceMs !== undefined) return opts.sinceMs;
    const iso = state.remotes[host]?.[dir_];
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(t) ? initial : t - CURSOR_OVERLAP_MS;
  };
  const tail = (t: string) => t.trim().split('\n').slice(-2).join(' | ');
  const valid: string[] = [];
  for (const host of opts.hosts) {
    if (isValidHostId(host)) valid.push(host);
    else results.set(host, { host, ok: false, error: 'invalid host name' });
  }

  // Pass 1 — pull from EVERY host first, so pass 2 pushes each host what all the others hold.
  const pulledSince: number[] = [];
  const pullOk = new Set<string>();
  for (const host of valid) {
    const res: RemoteSyncResult = { host, ok: true };
    results.set(host, res);
    if (opts.pull === false) continue;
    const since = cursorOf(host, 'pull');
    const out = ssh(host, `"$AD" usage export --all --since '${new Date(since).toISOString()}'`);
    if (out.status !== 0) {
      Object.assign(res, {
        ok: false,
        error: `pull failed (exit ${out.status}): ${tail(out.stderr)}`,
      });
      continue;
    }
    try {
      res.pulled = importBundle(dir, out.stdout, local);
      pulledSince.push(since);
      pullOk.add(host);
    } catch (err) {
      Object.assign(res, { ok: false, error: `pull import failed: ${(err as Error).message}` });
    }
  }

  // Pass 2 — push everything except the target's own rows. Rows pulled this run may be OLDER
  // than the target's push cursor (a host that was down, or a first pull), so reach back to the
  // earliest pull window as well — otherwise those rows would never reach the other hosts.
  const pushOk = new Set<string>();
  for (const host of valid) {
    const res = results.get(host) as RemoteSyncResult;
    if (!res.ok || opts.push === false) continue;
    const since = Math.min(cursorOf(host, 'push'), ...pulledSince);
    const bundle = buildBundle(
      dir,
      local,
      // The alias and the host's self-reported id can differ (ssh config vs os.hostname()).
      listHosts(dir).filter((h) => h !== host && h !== results.get(host)?.pulled?.from),
      since
    );
    res.pushed_rows = bundle.rows;
    const out = ssh(host, '"$AD" usage import - --json', bundle.text);
    if (out.status !== 0) {
      Object.assign(res, {
        ok: false,
        error: `push failed (exit ${out.status}): ${tail(out.stderr)}`,
      });
      continue;
    }
    pushOk.add(host);
    try {
      res.push = JSON.parse(out.stdout.trim().split('\n').pop() ?? 'null') as ImportResult;
    } catch {
      res.push = null;
    }
  }

  // Advance only the direction that actually ran and succeeded.
  const stamp = new Date(nowMs).toISOString();
  for (const host of valid) {
    const entry = state.remotes[host] ?? {};
    if (pullOk.has(host)) entry.pull = stamp;
    if (pushOk.has(host)) entry.push = stamp;
    if (entry.pull || entry.push) state.remotes[host] = entry;
  }
  writeState(dir, state);
  return opts.hosts.map((h) => results.get(h) as RemoteSyncResult);
}
