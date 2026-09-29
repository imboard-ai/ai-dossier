/**
 * Static dry-run analysis of a dossier (issue #20).
 *
 * IMPORTANT: dossiers are executed by an LLM, not by a deterministic
 * interpreter. `analyzeDryRun` is therefore a STATIC PREVIEW: it reads the
 * dossier's declared metadata (risk_level, risk_factors, destructive_operations,
 * tools_required) and pattern-matches the shell / script code fences in its
 * body. It cannot know what the executing agent will actually do, and the
 * risk score is a triage heuristic, never a safety guarantee.
 */

import { parseDossierContent } from './parser';
import type { DossierFrontmatter } from './types';

export const DRY_RUN_SCHEMA_VERSION = 1;

export const DRY_RUN_DISCLAIMER =
  "Static preview - derived from the dossier's declared metadata and code blocks; the executing agent may take other actions. The risk score is a heuristic, not a safety guarantee.";

/** Overall risk band derived from the 0-100 score. */
export type DryRunLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * What a single command does, coarsely:
 * - read: inspects local state only (green)
 * - local_write: creates/modifies local files or repo state, or is an unrecognised executable (yellow)
 * - remote: talks to a remote service (red)
 * - destructive: deletes/overwrites/force-pushes/publishes, hard to reverse (red)
 */
export type DryRunKind = 'read' | 'local_write' | 'remote' | 'destructive';

export interface DryRunCommand {
  command: string;
  kind: DryRunKind;
  /** false when the executable is not in the analyzer's tables (treated as local_write). */
  recognized: boolean;
  /** 1-based line within the dossier body. */
  line: number;
}

export interface DryRunFile {
  path: string;
  operation: 'write' | 'delete' | 'move';
  command: string;
  line: number;
}

export interface DryRunNetwork {
  tool: string;
  /** Host for URLs, otherwise the tool sub-command (e.g. `pr create`). */
  target: string;
  /** true when the call looks like it changes remote state (not a plain read). */
  mutates: boolean;
  command: string;
  line: number;
}

export interface DryRunEnv {
  name: string;
  line: number;
}

export interface DryRunScoreComponent {
  component: string;
  points: number;
}

export interface DryRunPlan {
  schema_version: typeof DRY_RUN_SCHEMA_VERSION;
  /** Always true: this is never a record of what actually ran. */
  static_preview: true;
  disclaimer: string;
  dossier: { title: string; version: string; declared_risk_level: string | null };
  declared: {
    risk_factors: string[];
    destructive_operations: string[];
    tools_required: string[];
    requires_approval: boolean;
  };
  files: DryRunFile[];
  commands: DryRunCommand[];
  network: DryRunNetwork[];
  env: DryRunEnv[];
  /** 0-100 heuristic; see SCORE_* constants for the formula. */
  risk_score: number;
  level: DryRunLevel;
  score_breakdown: DryRunScoreComponent[];
}

// --- scoring formula -------------------------------------------------------

/** Base points for the dossier's declared risk_level. */
export const SCORE_BASE: Record<string, number> = { low: 5, medium: 25, high: 50, critical: 75 };
/** Points per declared risk_factor / destructive_operation, and the cap for each. */
export const SCORE_PER_RISK_FACTOR = 4;
export const SCORE_RISK_FACTOR_CAP = 20;
export const SCORE_PER_DESTRUCTIVE_DECLARATION = 3;
export const SCORE_DESTRUCTIVE_DECLARATION_CAP = 15;
/** Points per detected command of each kind, and the cap per kind. */
export const SCORE_PER_COMMAND: Record<DryRunKind, number> = {
  read: 0,
  local_write: 1,
  remote: 2,
  destructive: 5,
};
export const SCORE_COMMAND_CAP: Record<DryRunKind, number> = {
  read: 0,
  local_write: 5,
  remote: 15,
  destructive: 15,
};
/** Band lower bounds. */
export const LEVEL_MEDIUM_MIN = 25;
export const LEVEL_HIGH_MIN = 50;
export const LEVEL_CRITICAL_MIN = 75;

export function levelForScore(score: number): DryRunLevel {
  if (score >= LEVEL_CRITICAL_MIN) return 'critical';
  if (score >= LEVEL_HIGH_MIN) return 'high';
  if (score >= LEVEL_MEDIUM_MIN) return 'medium';
  return 'low';
}

// --- code fence extraction -------------------------------------------------

interface Fence {
  lang: string;
  /** Body line number (1-based) of the first content line. */
  startLine: number;
  lines: string[];
}

const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shell-session', 'terminal']);
const SCRIPT_LANGS = new Set(['js', 'javascript', 'ts', 'typescript', 'mjs', 'node']);

function extractFences(body: string): Fence[] {
  const fences: Fence[] = [];
  const lines = body.split('\n');
  let open: { marker: string; fence: Fence } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === open.marker[0] && close[1].length >= open.marker.length) {
        fences.push(open.fence);
        open = null;
      } else {
        open.fence.lines.push(line);
      }
      continue;
    }
    const start = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/);
    if (start) {
      open = {
        marker: start[1],
        fence: { lang: start[2].toLowerCase(), startLine: i + 2, lines: [] },
      };
    }
  }
  return fences;
}

// --- shell tokenising ------------------------------------------------------

/** True when `s` ends inside an unterminated '...' or "..." string. */
function endsInsideQuote(s: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }
  return quote !== null;
}

/** Longest quoted span joined into one logical line before giving up (stray apostrophes in prose). */
const MAX_QUOTED_LINES = 40;

/** Join `\`-continued lines and multi-line quoted strings, keeping the number of the first physical line. */
function logicalLines(fence: Fence): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let acc = '';
  let accLine = 0;
  let accCount = 0;
  fence.lines.forEach((raw, idx) => {
    const lineNo = fence.startLine + idx;
    if (!acc) {
      accLine = lineNo;
      accCount = 0;
    }
    accCount++;
    if (/\\\s*$/.test(raw)) {
      acc += `${raw.replace(/\\\s*$/, '')} `;
      return;
    }
    const joined = acc + raw;
    if (endsInsideQuote(joined) && accCount < MAX_QUOTED_LINES) {
      acc = `${joined} `;
      return;
    }
    out.push({ text: joined.trim(), line: accLine });
    acc = '';
  });
  if (acc.trim()) out.push({ text: acc.trim(), line: accLine });
  return out;
}

/** Replace quoted string contents with spaces so operators inside quotes are ignored. */
function maskQuotes(input: string): string {
  // `<placeholder text>` template slots are not redirections or pipes; blank them first.
  const s = input.replace(
    /(^|[^<>\d])<[A-Za-z][^<>]*(?:<[^<>]*>[^<>]*)*>/g,
    (m, pre: string) => pre + ' '.repeat(m.length - pre.length)
  );
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && (quote === "'" || s[i - 1] !== '\\')) {
        quote = null;
        out += c;
      } else {
        out += ' ';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else {
      out += c;
    }
  }
  return out;
}

/** Split a shell line into simple commands on `&&`, `||`, `;`, `|` (quote-aware). */
function splitCommands(line: string): string[] {
  const masked = maskQuotes(line);
  const parts: string[] = [];
  let last = 0;
  const re = /&&|\|\||;|\||\$\(|`|\(|\)/g;
  let m = re.exec(masked);
  while (m !== null) {
    parts.push(line.slice(last, m.index));
    last = m.index + m[0].length;
    m = re.exec(masked);
  }
  parts.push(line.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /(?:[^\s"']|"[^"]*"|'[^']*')+/g;
  let m = re.exec(cmd);
  while (m !== null) {
    if (m[0].startsWith('#')) break; // trailing shell comment
    tokens.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (_q, d: string, sq: string) => d ?? sq));
    m = re.exec(cmd);
  }
  return tokens;
}

// --- classification tables -------------------------------------------------

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'until',
  'case',
  'esac',
  'in',
  'function',
  'return',
  'exit',
  'break',
  'continue',
  '{',
  '}',
  '(',
  ')',
  '!',
]);

const READ_ONLY = new Set([
  'ls',
  'cat',
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'echo',
  'printf',
  'test',
  '[',
  '[[',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'jq',
  'yq',
  'awk',
  'diff',
  'pwd',
  'cd',
  'which',
  'command',
  'type',
  'date',
  'basename',
  'dirname',
  'readlink',
  'realpath',
  'stat',
  'file',
  'env',
  'export',
  'set',
  'unset',
  'read',
  'true',
  'false',
  'sleep',
  'xargs',
  'tree',
  'du',
  'df',
  'whoami',
  'hostname',
  'uname',
  'id',
  'nproc',
  'source',
  '.',
  'local',
  'declare',
  'shift',
  'trap',
  'wait',
]);

/** Tools that talk to a remote service by nature. */
const REMOTE_TOOLS = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'aws',
  'gcloud',
  'az',
  'kubectl',
  'helm',
  'terraform',
  'tofu',
  'fly',
  'flyctl',
  'vercel',
  'heroku',
  'netlify',
  'psql',
  'mongosh',
  'mongo',
  'redis-cli',
  'mysql',
  'nc',
  'ping',
  'dig',
  'nslookup',
]);

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'pnpx', 'pip', 'pip3', 'cargo']);

const LOCAL_WRITE_TOOLS = new Set([
  'mkdir',
  'touch',
  'cp',
  'chmod',
  'chown',
  'ln',
  'make',
  'tar',
  'unzip',
  'zip',
  'gzip',
  'gunzip',
  'install',
  'patch',
  'mktemp',
  'node',
  'python',
  'python3',
  'bash',
  'sh',
  'zsh',
  'tsc',
  'biome',
  'vitest',
  'jest',
  'kill',
  'pkill',
  'claude',
  'opencode',
  'ai-dossier',
  'dossier',
]);

const DESTRUCTIVE_VERB =
  /^(delete|destroy|terminate|rm|remove|drop|purge|prune|uninstall|deregister)$/;
const GH_READ_VERBS = new Set([
  'view',
  'list',
  'status',
  'diff',
  'checks',
  'watch',
  'download',
  'get',
  'search',
  'browse',
  'show',
]);
const GH_DESTRUCTIVE_VERBS = new Set(['merge', 'delete', 'close', 'archive', 'lock']);
const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'cat-file',
  'blame',
  'describe',
  'config',
  'remote',
  'merge-base',
  'grep',
  'shortlog',
  'name-rev',
  'for-each-ref',
  'symbolic-ref',
  'var',
  'check-ignore',
  'patch-id',
  'cherry',
  'range-diff',
]);
const GIT_REMOTE_READ = new Set(['fetch', 'pull', 'clone', 'ls-remote']);

function stripEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length && ['sudo', 'time', 'nohup', 'exec', 'command'].includes(tokens[i])) i++;
  return tokens.slice(i);
}

function hostOf(url: string): string | null {
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/\s:]+)/i);
  return m ? m[1] : null;
}

interface Classified {
  kind: DryRunKind;
  recognized: boolean;
  files: Array<{ path: string; operation: DryRunFile['operation'] }>;
  network?: { tool: string; target: string; mutates: boolean };
}

function nonFlags(tokens: string[]): string[] {
  return tokens.filter((t) => !t.startsWith('-'));
}

/** Classify a single simple command (already split from pipelines). */
function classifyCommand(cmd: string, rawLine: string): Classified | null {
  const tokens = stripEnvAssignments(tokenize(cmd));
  if (tokens.length === 0) return null;
  const exe = tokens[0].replace(/^.*\//, '');
  const args = tokens.slice(1);
  if (SHELL_KEYWORDS.has(exe) || exe.startsWith('#')) return null;
  // Pure variable assignment (`X=$(...)`) has no executable of its own.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return null;

  const files: Classified['files'] = [];
  let kind: DryRunKind = 'read';
  let recognized = true;
  let network: Classified['network'];

  const bump = (k: DryRunKind) => {
    const order: DryRunKind[] = ['read', 'local_write', 'remote', 'destructive'];
    if (order.indexOf(k) > order.indexOf(kind)) kind = k;
  };

  // Output redirection (`> file`, `>> file`), ignoring quoted operators and /dev/*.
  const masked = maskQuotes(rawLine);
  const redir = /(?:^|[^<>&\d-])\d?>>?\s*([^\s|&;<>()]+)/g;
  let rm = redir.exec(masked);
  while (rm !== null) {
    // Recover the unmasked target from the original line.
    const target = rawLine.slice(rm.index + rm[0].length - rm[1].length, rm.index + rm[0].length);
    if (!target.startsWith('/dev/') && !target.startsWith('&')) {
      files.push({ path: target.replace(/^["']|["']$/g, ''), operation: 'write' });
      bump('local_write');
    }
    rm = redir.exec(masked);
  }

  switch (exe) {
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
      for (const p of nonFlags(args)) files.push({ path: p, operation: 'delete' });
      bump('destructive');
      break;
    case 'mv':
      for (const p of nonFlags(args)) files.push({ path: p, operation: 'move' });
      bump('local_write');
      break;
    case 'tee':
      for (const p of nonFlags(args)) files.push({ path: p, operation: 'write' });
      bump('local_write');
      break;
    case 'cp':
    case 'install':
      {
        const paths = nonFlags(args);
        if (paths.length > 0) files.push({ path: paths[paths.length - 1], operation: 'write' });
      }
      bump('local_write');
      break;
    case 'mkdir':
    case 'touch':
      for (const p of nonFlags(args)) files.push({ path: p, operation: 'write' });
      bump('local_write');
      break;
    case 'sed':
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) {
        const paths = nonFlags(args);
        if (paths.length > 1) files.push({ path: paths[paths.length - 1], operation: 'write' });
        bump('local_write');
      }
      break;
    case 'find':
      if (args.includes('-delete')) bump('destructive');
      else if (args.includes('-exec')) bump('local_write');
      break;
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-')) ?? '';
      const rest = args.slice(args.indexOf(sub) + 1);
      if (sub === 'push') {
        const forced = rest.some(
          (a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease')
        );
        const deleting = rest.includes('--delete') || rest.some((a) => /^:\S/.test(a));
        network = { tool: 'git', target: 'push', mutates: true };
        bump(forced || deleting ? 'destructive' : 'remote');
      } else if (GIT_REMOTE_READ.has(sub)) {
        network = { tool: 'git', target: sub, mutates: false };
        bump('remote');
        if (sub !== 'ls-remote') bump('local_write');
      } else if (GIT_READ.has(sub)) {
        // read-only (git config/remote may write, but bare invocations here are inspection)
      } else if (
        (sub === 'reset' && rest.includes('--hard')) ||
        sub === 'clean' ||
        (sub === 'branch' && rest.some((a) => a === '-D' || a === '--delete')) ||
        (sub === 'checkout' && rest.includes('--') && rest.includes('.')) ||
        (sub === 'worktree' && rest[0] === 'remove') ||
        (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear'))
      ) {
        bump('destructive');
      } else {
        bump('local_write');
      }
      break;
    }
    case 'gh': {
      const words = nonFlags(args);
      const group = words[0] ?? '';
      const verb = words[1] ?? '';
      if (group === 'api') {
        const method = (() => {
          const i = args.findIndex((a) => a === '-X' || a === '--method');
          return i >= 0 ? (args[i + 1] ?? '').toUpperCase() : '';
        })();
        const hasBody = args.some(
          (a) =>
            a === '-f' || a === '-F' || a === '--field' || a === '--raw-field' || a === '--input'
        );
        const mutates = (method !== '' && method !== 'GET') || (method === '' && hasBody);
        network = { tool: 'gh', target: `api ${words[1] ?? ''}`.trim(), mutates };
        bump(method === 'DELETE' ? 'destructive' : 'remote');
      } else {
        const mutates = !GH_READ_VERBS.has(verb);
        network = { tool: 'gh', target: [group, verb].filter(Boolean).join(' '), mutates };
        bump(GH_DESTRUCTIVE_VERBS.has(verb) ? 'destructive' : 'remote');
      }
      break;
    }
    case 'curl':
    case 'wget': {
      const url = args.find((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a)) ?? '';
      const method = (() => {
        const i = args.findIndex((a) => a === '-X' || a === '--request');
        return i >= 0 ? (args[i + 1] ?? '').toUpperCase() : '';
      })();
      const hasBody = args.some(
        (a) =>
          a === '-d' ||
          a === '--data' ||
          a === '--data-raw' ||
          a === '--json' ||
          a === '-F' ||
          a === '-T'
      );
      const mutates = (method !== '' && method !== 'GET' && method !== 'HEAD') || hasBody;
      network = { tool: exe, target: hostOf(url) ?? (url || 'unknown host'), mutates };
      bump(method === 'DELETE' ? 'destructive' : 'remote');
      const oi = args.findIndex(
        (a) => a === '-o' || a === '--output' || a === '-O' || a === '--output-document'
      );
      if (oi >= 0 && args[oi + 1]) {
        files.push({ path: args[oi + 1], operation: 'write' });
        bump('remote');
      }
      break;
    }
    default: {
      if (REMOTE_TOOLS.has(exe)) {
        const words = nonFlags(args);
        const destructive = words.some((w) => DESTRUCTIVE_VERB.test(w));
        const mutates =
          destructive ||
          words.some((w) =>
            /^(apply|create|patch|scale|put|push|deploy|update|run|start|stop|cp|sync|replace|set|annotate|label|rollout|exec|copy|upgrade|install)$/.test(
              w
            )
          );
        network = { tool: exe, target: words.slice(0, 2).join(' ') || exe, mutates };
        bump(destructive ? 'destructive' : 'remote');
      } else if (PACKAGE_MANAGERS.has(exe)) {
        const sub = nonFlags(args)[0] ?? '';
        if (sub === 'publish' || (exe === 'cargo' && sub === 'publish')) {
          network = { tool: exe, target: 'publish', mutates: true };
          bump('destructive');
        } else if (
          /^(install|i|add|ci|update|upgrade|dlx|exec)$/.test(sub) ||
          exe === 'npx' ||
          exe === 'pnpx'
        ) {
          network = { tool: exe, target: sub || exe, mutates: false };
          bump('remote');
          bump('local_write');
        } else if (/^(run|test|build|lint|check|start|dev)$/.test(sub) || sub === '') {
          bump('local_write');
        } else {
          bump('local_write');
        }
      } else if (exe === 'docker' || exe === 'podman') {
        const sub = nonFlags(args)[0] ?? '';
        if (sub === 'push' || sub === 'pull' || sub === 'login') {
          network = { tool: exe, target: sub, mutates: sub === 'push' };
          bump('remote');
        } else if (/^(rm|rmi|prune|kill|system)$/.test(sub)) {
          bump('destructive');
        } else {
          bump('local_write');
        }
      } else if (exe === 'ai-dossier' || exe === 'dossier') {
        const sub = nonFlags(args)[0] ?? '';
        if (sub === 'publish' || sub === 'login') {
          network = { tool: exe, target: sub, mutates: sub === 'publish' };
          bump('remote');
        } else if (sub === 'run' || sub === 'pull' || sub === 'get') {
          network = { tool: exe, target: sub, mutates: false };
          bump('remote');
          bump('local_write');
        } else {
          bump('local_write');
        }
      } else if (READ_ONLY.has(exe)) {
        // stays 'read'
      } else if (LOCAL_WRITE_TOOLS.has(exe)) {
        bump('local_write');
      } else {
        recognized = false;
        bump('local_write');
      }
    }
  }

  // `curl ... | sh` style: handled by the caller, which sees the whole pipeline.
  return { kind, recognized, files: files.filter((f) => f.path.trim() !== ''), network };
}

const KNOWN_TOOL_NAMES = new Set<string>([
  ...REMOTE_TOOLS,
  ...PACKAGE_MANAGERS,
  ...LOCAL_WRITE_TOOLS,
  'git',
  'gh',
  'docker',
  'podman',
  'rm',
  'mv',
  'tee',
  'sed',
  'find',
  'rmdir',
  'cat',
  'grep',
  'ls',
  'echo',
  'jq',
]);

const ENV_SHELL = /\$(?:\{([A-Z_][A-Z0-9_]*)[^}]*\}|([A-Z_][A-Z0-9_]*))/g;
const ENV_NODE =
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g;
/** Shell-provided or ubiquitous variables that are not meaningful "inputs". */
const IGNORED_ENV = new Set([
  'PATH',
  'PWD',
  'OLDPWD',
  'IFS',
  'RANDOM',
  'LINENO',
  'SECONDS',
  'BASH_SOURCE',
  'FUNCNAME',
  'PIPESTATUS',
  'UID',
  'EUID',
]);

// --- analysis --------------------------------------------------------------

export function analyzeDryRun(
  input: string | { frontmatter: DossierFrontmatter; body: string }
): DryRunPlan {
  const { frontmatter, body } = typeof input === 'string' ? parseDossierContent(input) : input;

  const commands: DryRunCommand[] = [];
  const files: DryRunFile[] = [];
  const network: DryRunNetwork[] = [];
  const env = new Map<string, DryRunEnv>();
  // Variables the dossier assigns itself are internal state, not external inputs.
  const assigned = new Set<string>();

  for (const fence of extractFences(body)) {
    const isShell = SHELL_LANGS.has(fence.lang);
    const isScript = SCRIPT_LANGS.has(fence.lang);
    const isBare = fence.lang === '';
    if (!isShell && !isScript && !isBare) continue;

    let heredocEnd: string | null = null;
    for (const { text, line } of logicalLines(fence)) {
      if (heredocEnd !== null) {
        if (text === heredocEnd) heredocEnd = null;
        continue; // heredoc bodies are data (PR bodies, file contents), not commands
      }
      const heredoc = text.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
      // A heredoc already closed inside a joined multi-line quote needs no skipping.
      if (
        heredoc &&
        !new RegExp(`\\b${heredoc[1]}\\b`).test(
          text.slice((heredoc.index ?? 0) + heredoc[0].length)
        )
      ) {
        heredocEnd = heredoc[1];
      }
      if (!text || text.startsWith('#')) continue;
      if (isScript) {
        for (const m of text.matchAll(ENV_NODE)) {
          const name = m[1] ?? m[2];
          if (name && !env.has(name)) env.set(name, { name, line });
        }
        continue;
      }

      // Strip a leading `$ ` prompt used in console-style blocks.
      const clean = text.replace(/^\$\s+/, '');
      if (
        isBare &&
        !KNOWN_TOOL_NAMES.has(stripEnvAssignments(tokenize(clean))[0]?.replace(/^.*\//, '') ?? '')
      ) {
        // Unlabeled fences are often templates (PR bodies, commit messages); only trust known tools.
        continue;
      }

      for (const m of clean.matchAll(/(?:^|[\s;&(])([A-Za-z_][A-Za-z0-9_]*)=/g)) assigned.add(m[1]);
      for (const m of clean.matchAll(
        /\b(?:for|read(?:\s+-\w+)*|local|declare|export)\s+([A-Za-z_][A-Za-z0-9_]*)/g
      ))
        assigned.add(m[1]);
      const envText = clean.replace(/'[^']*'/g, (q) => ' '.repeat(q.length));
      for (const m of envText.matchAll(ENV_SHELL)) {
        const name = m[1] ?? m[2];
        if (name && !assigned.has(name) && !IGNORED_ENV.has(name) && !env.has(name)) {
          env.set(name, { name, line });
        }
      }

      const parts = splitCommands(clean);
      const exes = parts.map(
        (p) => stripEnvAssignments(tokenize(p))[0]?.replace(/^.*\//, '') ?? ''
      );
      const pipesToShell =
        /\|\s*(sudo\s+)?(sh|bash|zsh)\b/.test(maskQuotes(clean)) && /\b(curl|wget)\b/.test(clean);

      parts.forEach((part, i) => {
        // Redirections are attached to the segment that owns them.
        const c = classifyCommand(part, part);
        if (!c) return;
        // Unknown words after a pipe are almost always prose (`a|b|c` alternatives), not tools.
        if (i > 0 && !c.recognized && c.files.length === 0) return;
        let kind = c.kind;
        if (pipesToShell && (exes[i] === 'sh' || exes[i] === 'bash' || exes[i] === 'zsh'))
          kind = 'destructive';
        commands.push({ command: part, kind, recognized: c.recognized, line });
        for (const f of c.files) files.push({ ...f, command: part, line });
        if (c.network) network.push({ ...c.network, command: part, line });
      });
    }
  }

  // Score.
  const breakdown: DryRunScoreComponent[] = [];
  const riskLevel = frontmatter.risk_level ?? null;
  const base = riskLevel ? (SCORE_BASE[riskLevel] ?? 0) : 0;
  if (base > 0) breakdown.push({ component: `declared risk_level: ${riskLevel}`, points: base });
  const factors = frontmatter.risk_factors ?? [];
  const factorPts = Math.min(factors.length * SCORE_PER_RISK_FACTOR, SCORE_RISK_FACTOR_CAP);
  if (factorPts > 0)
    breakdown.push({ component: `${factors.length} declared risk_factors`, points: factorPts });
  const destructive = frontmatter.destructive_operations ?? [];
  const destPts = Math.min(
    destructive.length * SCORE_PER_DESTRUCTIVE_DECLARATION,
    SCORE_DESTRUCTIVE_DECLARATION_CAP
  );
  if (destPts > 0)
    breakdown.push({
      component: `${destructive.length} declared destructive_operations`,
      points: destPts,
    });
  for (const kind of ['local_write', 'remote', 'destructive'] as const) {
    const n = commands.filter((c) => c.kind === kind).length;
    const pts = Math.min(n * SCORE_PER_COMMAND[kind], SCORE_COMMAND_CAP[kind]);
    if (pts > 0)
      breakdown.push({
        component: `${n} ${kind} command${n === 1 ? '' : 's'} in code blocks`,
        points: pts,
      });
  }
  const risk_score = Math.min(
    100,
    breakdown.reduce((s, b) => s + b.points, 0)
  );

  return {
    schema_version: DRY_RUN_SCHEMA_VERSION,
    static_preview: true,
    disclaimer: DRY_RUN_DISCLAIMER,
    dossier: {
      title: frontmatter.title,
      version: frontmatter.version,
      declared_risk_level: riskLevel,
    },
    declared: {
      risk_factors: factors,
      destructive_operations: destructive,
      tools_required: (frontmatter.tools_required ?? []).map((t) => t.name),
      requires_approval: frontmatter.requires_approval === true,
    },
    files,
    commands,
    network,
    env: [...env.values()],
    risk_score,
    level: levelForScore(risk_score),
    score_breakdown: breakdown,
  };
}
