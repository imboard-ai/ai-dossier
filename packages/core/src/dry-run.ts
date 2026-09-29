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

import { type CodeHit, type CodeLang, extractCodeHits } from './dry-run-langs';
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
  /** Why this command was escalated beyond its plain classification (e.g. remote code execution). */
  reason?: string;
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
  /** Declared risk_level vs what the code blocks actually do; `mismatch` when observed outranks declared. */
  declared_vs_observed: {
    declared_level: string | null;
    observed_level: DryRunLevel;
    mismatch: boolean;
    note: string;
  };
  /** Code fences in a language the analyzer has no extractor for (their content is NOT reflected in the score). */
  unanalyzed_fences: Array<{ lang: string; line: number }>;
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
const CODE_LANGS: Record<string, CodeLang> = {
  js: 'js',
  javascript: 'js',
  ts: 'js',
  typescript: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  jsx: 'js',
  tsx: 'js',
  python: 'python',
  python3: 'python',
  py: 'python',
  py3: 'python',
  powershell: 'powershell',
  pwsh: 'powershell',
  ps1: 'powershell',
  ps: 'powershell',
  posh: 'powershell',
  bat: 'powershell',
  batch: 'powershell',
  cmd: 'powershell',
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  ruby: 'ruby',
  rb: 'ruby',
  perl: 'perl',
  pl: 'perl',
  sql: 'sql',
  psql: 'sql',
  mysql: 'sql',
  pgsql: 'sql',
  sqlite: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
};
/** Fence languages that hold data / prose / diagrams, not something an agent executes. */
const INERT_LANGS = new Set([
  'json',
  'jsonc',
  'json5',
  'toml',
  'ini',
  'xml',
  'html',
  'css',
  'md',
  'markdown',
  'text',
  'txt',
  'plaintext',
  'diff',
  'patch',
  'mermaid',
  'csv',
  'http',
  'env',
  'dotenv',
  'output',
  'log',
  'graphql',
  'gql',
  'svg',
  'tree',
  'math',
]);

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

/** What executes a heredoc body: a shell / interpreter (analysed as code) or nothing (data). */
type ExecTarget = 'shell' | 'python' | 'js' | 'ruby' | 'perl' | 'powershell' | 'sql';

interface Heredoc {
  exec: ExecTarget | null;
  body: string[];
  bodyLine: number;
}

interface Logical {
  text: string;
  line: number;
  heredocs: Heredoc[];
}

/** Blank `((...))` / `$((...))` arithmetic so a `<<` shift inside it is not read as a heredoc. */
function blankArithmetic(s: string): string {
  const chars = s.split('');
  let i = 0;
  while (i < chars.length - 1) {
    if (chars[i] === '(' && chars[i + 1] === '(') {
      let depth = 0;
      let j = i;
      for (; j < chars.length; j++) {
        if (chars[j] === '(') depth++;
        else if (chars[j] === ')' && --depth === 0) break;
      }
      if (j >= chars.length) break;
      for (let k = i; k <= j; k++) chars[k] = ' ';
      i = j + 1;
    } else {
      i++;
    }
  }
  return chars.join('');
}

const SQL_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'mongosh',
  'mongo',
  'redis-cli',
]);
/** Tools that run a remote / contained command line, so `tool ... <<EOF` feeds that shell. */
const EXEC_HOSTS = new Set([
  'docker',
  'podman',
  'kubectl',
  'nsenter',
  'chroot',
  'lxc',
  'incus',
  'fly',
  'flyctl',
  'oc',
  'su',
]);

function interpKind(exe: string): ExecTarget | 'other' | null {
  const e = exe.toLowerCase();
  if (/^(?:sh|bash|zsh|dash|ksh|ash|fish|csh|tcsh|mksh|rbash)$/.test(e)) return 'shell';
  if (/^python[\d.]*$/.test(e)) return 'python';
  if (/^(?:node|nodejs|deno|bun|tsx|ts-node)$/.test(e)) return 'js';
  if (/^ruby[\d.]*$/.test(e)) return 'ruby';
  if (/^perl[\d.]*$/.test(e)) return 'perl';
  if (/^(?:pwsh|powershell)(?:\.exe)?$/.test(e)) return 'powershell';
  if (/^(?:php[\d.]*|lua[\d.]*|rscript|osascript|tclsh|expect|julia|groovy)$/.test(e))
    return 'other';
  return null;
}

const CODE_FLAG: Record<string, RegExp> = {
  shell: /^-[A-Za-z]*c$/,
  python: /^-c$/,
  js: /^(?:-e|--eval|-p|--print)$/,
  ruby: /^-[eE]$/,
  perl: /^-[eE]$/,
  powershell: /^-(?:c|command|e|enc|encodedcommand)$/i,
  other: /^-r$/,
};

interface WrapSpec {
  valued: Set<string>;
  /** Positional args to skip after flags (`timeout 5 cmd`). */
  positional?: number;
  /** Token that ends the wrapped command (`parallel cmd ::: args`). */
  stopAt?: string;
  /** Flags after which the wrapper does not execute anything (`command -v x`). */
  noExec?: Set<string>;
}

const v = (...f: string[]) => new Set(f);
const WRAPPERS: Record<string, WrapSpec> = {
  sudo: {
    valued: v(
      '-u',
      '-g',
      '-h',
      '-p',
      '-C',
      '-r',
      '-t',
      '-U',
      '-D',
      '-R',
      '--user',
      '--group',
      '--host',
      '--prompt',
      '--role',
      '--type',
      '--chdir',
      '--close-from'
    ),
  },
  doas: { valued: v('-u', '-C') },
  runuser: { valued: v('-u', '-g', '-l', '-c') },
  env: { valued: v('-u', '-C', '--unset', '--chdir') },
  nohup: { valued: v() },
  time: { valued: v('-f', '-o', '--format', '--output') },
  exec: { valued: v('-a') },
  command: { valued: v(), noExec: v('-v', '-V') },
  builtin: { valued: v() },
  busybox: { valued: v() },
  nice: { valued: v('-n', '--adjustment') },
  ionice: { valued: v('-c', '-n', '-p', '-P', '-u') },
  timeout: { valued: v('-s', '-k', '--signal', '--kill-after'), positional: 1 },
  stdbuf: { valued: v('-i', '-o', '-e') },
  setsid: { valued: v() },
  fakeroot: { valued: v() },
  proxychains: { valued: v('-f') },
  proxychains4: { valued: v('-f') },
  torsocks: { valued: v() },
  unbuffer: { valued: v() },
  chronic: { valued: v() },
  unshare: { valued: v() },
  chroot: { valued: v(), positional: 1 },
  flock: { valued: v('-w', '-E', '-c'), positional: 1 },
  watch: { valued: v('-n', '--interval') },
  xargs: {
    valued: v(
      '-a',
      '-d',
      '-E',
      '-I',
      '-L',
      '-n',
      '-P',
      '-s',
      '--arg-file',
      '--delimiter',
      '--eof',
      '--replace',
      '--max-lines',
      '--max-args',
      '--max-procs',
      '--max-chars'
    ),
  },
  parallel: { valued: v('-j', '-n', '-N', '-a', '-S', '--jobs', '--max-args'), stopAt: ':::' },
};

/** Tokens of the command wrapped by `sudo` / `env` / `xargs` / ..., or null when tokens[0] is no wrapper. */
function unwrap(tokens: string[]): string[] | null {
  const exe = tokens[0]?.replace(/^.*\//, '');
  const spec = exe ? WRAPPERS[exe] : undefined;
  if (!spec) return null;
  let i = 1;
  let positional = spec.positional ?? 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (spec.noExec?.has(t)) return [];
    if (t === '--') {
      i++;
      break;
    }
    if (t.length > 1 && t.startsWith('-')) {
      const combined = /^-[A-Za-z]{2,}$/.test(t) && spec.valued.has(`-${t[t.length - 1]}`);
      i += spec.valued.has(t) || combined ? 2 : 1;
      continue;
    }
    if (exe === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (positional > 0) {
      positional--;
      i++;
      continue;
    }
    break;
  }
  let inner = tokens.slice(i);
  if (spec.stopAt) {
    const stop = inner.findIndex((t) => t === spec.stopAt || t === '::::');
    if (stop >= 0) inner = inner.slice(0, stop);
  }
  return inner;
}

/** Unwrap wrapper chains (`sudo -E env nohup bash -`) down to the real command. */
function unwrapAll(tokens: string[]): string[] {
  let cur = tokens;
  for (let n = 0; n < 8; n++) {
    const inner = unwrap(cur);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

/** The interpreter a command feeds from stdin (`bash`, `sudo -E bash -`, `python3 -`), or null. */
function stdinTargetOf(tokensIn: string[]): ExecTarget | null {
  const tokens = unwrapAll(tokensIn);
  if (tokens.length === 0) return null;
  const ik = interpKind(tokens[0].replace(/^.*\//, ''));
  if (!ik || ik === 'other') return null;
  const args = tokens.slice(1);
  if (args.some((a) => CODE_FLAG[ik].test(a))) return null;
  if (args.includes('-s') || args.includes('-')) return ik;
  return args.every((a) => a.startsWith('-')) ? ik : null;
}

/** What a heredoc/pipe fed into this command line ends up executing, if anything. */
function execTargetOf(cmdText: string): ExecTarget | null {
  const tokens = unwrapAll(stripAssignments(tokenize(cmdText)));
  if (tokens.length === 0) return null;
  const exe = tokens[0].replace(/^.*\//, '');
  const direct = stdinTargetOf(tokens);
  if (direct) return direct;
  if (SQL_CLIENTS.has(exe)) return 'sql';
  if (exe === 'ssh') return 'shell';
  if (EXEC_HOSTS.has(exe)) {
    for (const t of tokens.slice(1)) {
      const ik = interpKind(t.replace(/^.*\//, ''));
      if (ik && ik !== 'other') return ik;
    }
  }
  return null;
}

function findHeredocs(text: string): Array<{ id: string; index: number; end: number }> {
  const masked = maskQuotes(blankArithmetic(text));
  const out: Array<{ id: string; index: number; end: number }> = [];
  for (let i = masked.indexOf('<<'); i !== -1; i = masked.indexOf('<<', i + 2)) {
    if (masked[i + 2] === '<' || masked[i - 1] === '<') continue; // here-string `<<<`
    const m = /^-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/.exec(
      text.slice(i + 2, i + 202)
    );
    if (!m) continue;
    out.push({ id: (m[1] ?? m[2] ?? m[3]) as string, index: i, end: i + 2 + m[0].length });
  }
  return out;
}

/** Decide whether the heredoc opened at `h` feeds an interpreter (owner command or a later pipe stage). */
function heredocExec(
  text: string,
  masked: string,
  h: { index: number; end: number }
): ExecTarget | null {
  let s = h.index;
  while (s > 0 && !';|&(`'.includes(masked[s - 1])) s--;
  const owner = execTargetOf(text.slice(s, h.index));
  if (owner) return owner;
  let e = h.end;
  while (e < masked.length && !';&)'.includes(masked[e])) e++;
  const tailMasked = masked.slice(h.end, e);
  const tail = text.slice(h.end, e);
  let from = 0;
  for (let p = tailMasked.indexOf('|'); p !== -1; p = tailMasked.indexOf('|', from)) {
    let next = tailMasked.indexOf('|', p + 1);
    if (next === p + 1) next = tailMasked.indexOf('|', p + 2);
    const seg = tail.slice(p + 1, next === -1 ? undefined : next).replace(/^[|&]+/, '');
    from = p + 1;
    const t = execTargetOf(seg);
    if (t) return t;
  }
  return null;
}

/** Join `\`-continued lines and multi-line quoted strings, keeping the number of the first physical line. */
function logicalLines(fence: Fence): Logical[] {
  const out: Logical[] = [];
  let acc = '';
  let accLine = 0;
  let accCount = 0;
  const lines = fence.lines;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const lineNo = fence.startLine + idx;
    if (!acc) {
      accLine = lineNo;
      accCount = 0;
    }
    accCount++;
    if (/\\\s*$/.test(raw)) {
      acc += `${raw.replace(/\\\s*$/, '')} `;
      continue;
    }
    const joined = acc + raw;
    if (endsInsideQuote(joined) && accCount < MAX_QUOTED_LINES) {
      acc = `${joined}\n`;
      continue;
    }
    const text = joined.trim();
    acc = '';
    const heredocs: Heredoc[] = [];
    if (text && !text.startsWith('#')) {
      const found = findHeredocs(text);
      const masked = found.length > 0 ? maskQuotes(blankArithmetic(text)) : '';
      for (const h of found) {
        // A heredoc already closed inside a joined multi-line quote needs no body.
        if (new RegExp(`\\b${h.id}\\b`).test(text.slice(h.end))) continue;
        const exec =
          heredocs.length >= MAX_HEREDOCS_PER_LINE ? 'shell' : heredocExec(text, masked, h);
        const body: string[] = [];
        const bodyLine = fence.startLine + idx + 1;
        let j = idx + 1;
        for (; j < lines.length; j++) {
          if (lines[j].trim() === h.id) break;
          body.push(lines[j]);
        }
        heredocs.push({ exec, body, bodyLine });
        idx = Math.min(j, lines.length - 1);
      }
    }
    out.push({ text, line: accLine, heredocs });
  }
  if (acc.trim()) out.push({ text: acc.trim(), line: accLine, heredocs: [] });
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

interface Segment {
  text: string;
  /** Separator that precedes this segment. */
  sep: string;
  /** Pipeline group: segments joined by `|` / `|&` share a group. */
  group: number;
}

/** Split a shell line into simple commands on `&&`, `||`, `;`, `|`, `&`, `$(`, backticks, parens (quote-aware). */
function splitSegments(line: string): Segment[] {
  const masked = maskQuotes(line);
  const out: Segment[] = [];
  let last = 0;
  let sep = '';
  let group = 0;
  const re = /&&|\|\||\|&|\||;|(?<![<>&\d])&(?![>&\d-])|\$\(|`|\(|\)/g;
  const push = (end: number) => {
    const text = line.slice(last, end).trim();
    if (text) out.push({ text, sep, group });
  };
  let m = re.exec(masked);
  while (m !== null) {
    push(m.index);
    last = m.index + m[0].length;
    sep = m[0];
    if (sep !== '|' && sep !== '|&') group++;
    m = re.exec(masked);
  }
  push(line.length);
  return out;
}

/** Index of the `)` matching the `(` at `open` (naive depth count), or text.length. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** `$(...)` and backtick command substitutions inside double quotes, which quote-masking hides. */
function dqSubstitutions(text: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let i = 0;
  while (i < text.length && out.length < 50) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      i++;
    } else if (c === '\\') {
      i += 2;
    } else if (quote === '"') {
      if (c === '"') {
        quote = null;
        i++;
      } else if (c === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
        const end = matchParen(text, i + 1);
        out.push(text.slice(i + 2, end));
        i = end + 1;
      } else if (c === '`') {
        const end = text.indexOf('`', i + 1);
        if (end < 0) break;
        out.push(text.slice(i + 1, end));
        i = end + 1;
      } else {
        i++;
      }
    } else {
      if (c === '"' || c === "'") quote = c;
      i++;
    }
  }
  return out;
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
/** Keywords that introduce a command on the same segment (`then rm -rf ~`, `do rm $f`). */
const LEADING_KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{']);

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
  'export',
  'set',
  'unset',
  'read',
  'true',
  'false',
  'sleep',
  'tree',
  'du',
  'df',
  'whoami',
  'hostname',
  'uname',
  'id',
  'nproc',
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

/** Commands whose stdout is content fetched from elsewhere (a pipe from them into a shell is remote code execution). */
const FETCH_TOOLS = new Set([
  'curl',
  'wget',
  'fetch',
  'aria2c',
  'nc',
  'ncat',
  'socat',
  'ssh',
  'lynx',
  'w3m',
  'http',
  'https',
  'xh',
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

/** Always-destructive executables (disk / system level). */
const DESTRUCTIVE_TOOLS = new Set([
  'shred',
  'wipefs',
  'fdisk',
  'sfdisk',
  'parted',
  'sgdisk',
  'mkswap',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'userdel',
  'groupdel',
  'killall',
]);

const DESTRUCTIVE_VERB =
  /^(?:delete|destroy|terminate|rm|rb|remove|drop|purge|prune|uninstall|deregister|revoke|unpublish|wipe|erase|truncate|flush)(?:-[a-z0-9-]+)?$/i;
const DB_DESTRUCTIVE =
  /\bdrop\s+(?:table|database|schema|user|index|collection)\b|\btruncate\b|\bdelete\s+from\b|dropDatabase|\.drop\s*\(|\bflush(?:all|db)\b|deleteMany\s*\(\s*\{\s*\}\s*\)/i;
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
/** Options whose value is a shell command (`tar --to-command=...`, `git --upload-pack=...`). */
const CMD_VALUED_OPTION =
  /^--(?:to-command|checkpoint-action|use-compress-program|upload-pack|receive-pack|rsh|ssh-command|editor|pager|exec)=(.+)$/;
/** Tokens that plausibly start a command line run inside `ssh` / `docker exec` / `kubectl exec`. */
const EXEC_HINT =
  /^(?:rm|rmdir|shred|dd|mkfs\S*|sh|bash|zsh|dash|ash|python[\d.]*|node|perl|ruby|curl|wget|git|kill|pkill|chmod|chown|truncate|mv|find|sudo|env|xargs|eval|nohup|systemctl|service|apt|apt-get|yum|dnf|apk|npm|pnpm|yarn|docker|kubectl|psql|mysql|mongosh|redis-cli|crontab|iptables|tar|cp)$/;

function stripAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

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

interface Nested {
  text: string;
  lang: ExecTarget;
}

interface Classified {
  kind: DryRunKind;
  recognized: boolean;
  files: Array<{ path: string; operation: DryRunFile['operation'] }>;
  network?: { tool: string; target: string; mutates: boolean };
  /** Command text embedded in this command (`sh -c "..."`, `eval`, `ssh host "..."`), to analyse recursively. */
  nested: Nested[];
  reason?: string;
  /** The real command after stripping `sudo` / `env` / `xargs` wrappers. */
  inner: string[];
  /** Interpreter this command feeds from stdin (`bash`, `python3 -`), if any. */
  stdinTarget: ExecTarget | null;
  /** Script file this command executes, if any. */
  execFile?: string;
}

function nonFlags(tokens: string[]): string[] {
  return tokens.filter((t) => !t.startsWith('-'));
}

const FETCH_SUBST =
  /(?:\$\(|`|<\()\s*(?:[\w./-]+\/)?(?:curl|wget|fetch|aria2c)\b|(?:\$\(|`)[^)`]*\b(?:base64\s+(?:-d|-D|--decode)|xxd\s+-r)\b/;

const REMOTE_EXEC_REASON = 'remote code execution: fetched content is executed';

/** Classify a single simple command (already split from pipelines). */
function classifyCommand(cmd: string, rawLine: string): Classified | null {
  let tokens = stripAssignments(tokenize(cmd));
  while (tokens.length > 0 && LEADING_KEYWORDS.has(tokens[0])) tokens = tokens.slice(1);
  if (tokens[0] === 'function') {
    const brace = tokens.indexOf('{');
    tokens = brace >= 0 ? tokens.slice(brace + 1) : [];
  }
  if (tokens.length === 0) return null;
  if (/\s/.test(tokens[0])) tokens = tokenize(tokens.join(' '));
  if (tokens.length === 0) return null;
  // `\rm`, `r\m`: backslashes in the command name are only quoting.
  tokens = [tokens[0].replace(/\\(.)/g, '$1'), ...tokens.slice(1)];
  const exe0 = tokens[0].replace(/^.*\//, '');
  if (SHELL_KEYWORDS.has(exe0) || exe0.startsWith('#')) return null;
  // Pure variable assignment (`X=$(...)`) has no executable of its own.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return null;

  // Classify what the wrapper (`sudo`, `env`, `xargs`, ...) really runs.
  let inner = tokens;
  for (let n = 0; n < 8; n++) {
    const u = unwrap(inner);
    if (!u) break;
    inner = u;
    while (inner.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(inner[0])) inner = inner.slice(1);
    if (inner.length > 0 && /\s/.test(inner[0])) inner = tokenize(inner.join(' '));
    if (inner.length > 0) inner = [inner[0].replace(/\\(.)/g, '$1'), ...inner.slice(1)];
  }
  if (inner.length === 0) {
    return { kind: 'read', recognized: true, files: [], nested: [], inner, stdinTarget: null };
  }
  const exe = inner[0].replace(/^.*\//, '');
  const args = inner.slice(1);

  const files: Classified['files'] = [];
  const nested: Nested[] = [];
  let kind: DryRunKind = 'read';
  let recognized = true;
  let network: Classified['network'];
  let reason: string | undefined;
  let execFile: string | undefined;

  const bump = (k: DryRunKind) => {
    const order: DryRunKind[] = ['read', 'local_write', 'remote', 'destructive'];
    if (order.indexOf(k) > order.indexOf(kind)) kind = k;
  };
  const destructive = (why?: string) => {
    bump('destructive');
    if (why && !reason) reason = why;
  };

  // Output redirection (`> file`, `>> file`), ignoring quoted operators and /dev/null-style sinks.
  const masked = maskQuotes(rawLine);
  const redir = /(?:^|[^<>&\d-])\d?>>?\s*([^\s|&;<>()]+)/g;
  let rm = redir.exec(masked);
  while (rm !== null) {
    // Recover the unmasked target from the original line.
    const target = rawLine.slice(rm.index + rm[0].length - rm[1].length, rm.index + rm[0].length);
    if (/^\/dev\/(?:sd|hd|nvme|vd|xvd|disk|mmcblk|mapper)/.test(target)) {
      files.push({ path: target, operation: 'write' });
      destructive('overwrites a block device');
    } else if (!target.startsWith('/dev/') && !target.startsWith('&')) {
      files.push({ path: target.replace(/^["']|["']$/g, ''), operation: 'write' });
      bump('local_write');
    }
    rm = redir.exec(masked);
  }

  for (const a of args) {
    const m = CMD_VALUED_OPTION.exec(a);
    if (m) nested.push({ text: m[1].replace(/^exec=/, ''), lang: 'shell' });
  }

  const nestedFrom = (text: string, lang: ExecTarget = 'shell') => {
    if (text.trim()) nested.push({ text, lang });
  };
  /** First token of an exec host's trailing command line (`ssh h "rm -rf /"`, `kubectl exec p -- rm -rf /`). */
  const nestedAfterHost = () => {
    const dd = args.indexOf('--');
    let start = dd >= 0 ? dd + 1 : -1;
    if (start < 0) {
      start = args.findIndex((a, i) =>
        i > 0 || dd < 0 ? EXEC_HINT.test(a.split(/\s+/)[0].replace(/^.*\//, '')) : false
      );
    }
    if (start >= 0) nestedFrom(args.slice(start).join(' '));
  };

  let interpNested = false;
  switch (exe) {
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
      for (const p of nonFlags(args)) files.push({ path: p, operation: 'delete' });
      destructive();
      break;
    case 'mv': {
      const paths = nonFlags(args);
      for (const p of paths) files.push({ path: p, operation: 'move' });
      if (paths.length > 1 && paths[paths.length - 1] === '/dev/null') destructive();
      else bump('local_write');
      break;
    }
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
    case 'dd': {
      const of = args.find((a) => a.startsWith('of='));
      if (of) {
        files.push({ path: of.slice(3), operation: 'write' });
        if (of.slice(3).startsWith('/dev/')) destructive('overwrites a block device');
        else bump('local_write');
      } else bump('local_write');
      break;
    }
    case 'truncate':
      if (args.some((a) => a === '-s0' || a === '--size=0' || a === '0')) destructive();
      else bump('local_write');
      break;
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const recursive = args.some((a) => a === '--recursive' || /^-[A-Za-z]*R[A-Za-z]*$/.test(a));
      const targets = nonFlags(args).slice(1);
      if (recursive && targets.some((t) => /^(?:\/|~|\$HOME|\/\*|\*|\.|\.\.)$/.test(t)))
        destructive('recursive permission change on a broad path');
      else bump('local_write');
      break;
    }
    case 'crontab':
      if (args.includes('-r')) destructive();
      else bump('local_write');
      break;
    case 'sed':
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) {
        const paths = nonFlags(args);
        if (paths.length > 1) files.push({ path: paths[paths.length - 1], operation: 'write' });
        bump('local_write');
      }
      for (const a of args) {
        const m = /(?:^|;)\s*s(.)(?:(?!\1).){0,500}\1((?:(?!\1).){0,500})\1[gpiImM0-9]*e/.exec(
          a.slice(0, 2000)
        );
        if (m) {
          nestedFrom(m[2]);
          bump('local_write');
        }
      }
      break;
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk': {
      const prog = args.join(' ').slice(0, 20000);
      let found = false;
      for (const m of prog.matchAll(/system\s*\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        nestedFrom(m[1].replace(/\\(.)/g, '$1'));
        found = true;
      }
      for (const m of prog.matchAll(
        /\|\s*"((?:[^"\\]|\\.)*)"|"((?:[^"\\]|\\.)*)"\s*\|\s*getline/g
      )) {
        nestedFrom((m[1] ?? m[2]).replace(/\\(.)/g, '$1'));
        found = true;
      }
      if (found || /\bsystem\s*\(|\|\s*getline|print[^;}]*\|\s*[^;}\s]/.test(prog))
        bump('local_write');
      break;
    }
    case 'eval': {
      const code = args.join(' ');
      nestedFrom(code);
      bump('local_write');
      if (FETCH_SUBST.test(code)) destructive(REMOTE_EXEC_REASON);
      break;
    }
    case 'source':
    case '.':
      bump('local_write');
      if (args[0]) execFile = args[0];
      break;
    case 'trap': {
      const action = nonFlags(args)[0];
      if (action && action !== '-') nestedFrom(action);
      break;
    }
    case 'su': {
      const ci = args.findIndex((a) => a === '-c' || a === '--command');
      if (ci >= 0 && args[ci + 1]) nestedFrom(args[ci + 1]);
      bump('local_write');
      break;
    }
    case 'find': {
      const ei = args.findIndex(
        (a) => a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir'
      );
      if (args.includes('-delete')) destructive();
      if (ei >= 0) {
        let end = args.findIndex((a, i) => i > ei && (a === ';' || a === ';' || a === '+'));
        if (end < 0) end = args.length;
        nestedFrom(args.slice(ei + 1, end).join(' '));
        bump('local_write');
      }
      break;
    }
    case 'git': {
      let a = args;
      while (a.length > 0 && a[0].startsWith('-')) {
        if (a[0] === '-c' && a[1]) {
          const m = /^(?:alias\.[\w-]+|core\.(?:sshCommand|pager|editor|fsmonitor))=(.+)$/.exec(
            a[1]
          );
          if (m) nestedFrom(m[1].replace(/^!/, ''));
        }
        a = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a[0])
          ? a.slice(2)
          : a.slice(1);
      }
      const sub = a[0] ?? '';
      const rest = a.slice(1);
      if (sub === 'push') {
        const forced = rest.some(
          (x) =>
            x === '--mirror' ||
            x.startsWith('--force') ||
            /^-[A-Za-z]*f[A-Za-z]*$/.test(x) ||
            /^\+\S/.test(x)
        );
        const deleting =
          rest.includes('--delete') || rest.includes('-d') || rest.some((x) => /^:\S/.test(x));
        network = { tool: 'git', target: 'push', mutates: true };
        bump(forced || deleting ? 'destructive' : 'remote');
      } else if (GIT_REMOTE_READ.has(sub)) {
        network = { tool: 'git', target: sub, mutates: false };
        bump('remote');
        if (sub !== 'ls-remote') bump('local_write');
      } else if (sub === 'remote' && ['rm', 'remove', 'prune'].includes(rest[0])) {
        destructive();
      } else if (GIT_READ.has(sub)) {
        // read-only (git config/remote may write, but bare invocations here are inspection)
      } else if (
        (sub === 'reset' && rest.includes('--hard')) ||
        sub === 'clean' ||
        sub === 'rm' ||
        sub === 'filter-branch' ||
        sub === 'filter-repo' ||
        (sub === 'reflog' && (rest[0] === 'expire' || rest[0] === 'delete')) ||
        (sub === 'gc' && rest.some((x) => x.startsWith('--prune'))) ||
        (sub === 'update-ref' && rest.includes('-d')) ||
        (sub === 'tag' && rest.some((x) => x === '-d' || x === '--delete')) ||
        (sub === 'branch' && rest.some((x) => x === '-D' || x === '-d' || x === '--delete')) ||
        (sub === 'checkout' &&
          (rest.includes('-f') || rest.includes('--force') || rest.includes('.'))) ||
        (sub === 'restore' && (rest.includes('.') || rest.includes('--worktree'))) ||
        (sub === 'switch' &&
          rest.some((x) => x === '-f' || x === '--force' || x === '--discard-changes')) ||
        (sub === 'submodule' && rest[0] === 'deinit') ||
        (sub === 'worktree' && rest[0] === 'remove') ||
        (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear'))
      ) {
        destructive();
      } else {
        bump('local_write');
      }
      if (sub === 'rebase') {
        const xi = rest.findIndex((x) => x === '--exec' || x === '-x');
        if (xi >= 0 && rest[xi + 1]) nestedFrom(rest[xi + 1]);
      }
      break;
    }
    case 'gh': {
      const words = nonFlags(args);
      const group = words[0] ?? '';
      const verb = words[1] ?? '';
      if (group === 'api') {
        const method = (() => {
          const i = args.findIndex((x) => x === '-X' || x === '--method');
          return i >= 0 ? (args[i + 1] ?? '').toUpperCase() : '';
        })();
        const hasBody = args.some(
          (x) =>
            x === '-f' || x === '-F' || x === '--field' || x === '--raw-field' || x === '--input'
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
      const url = args.find((x) => /^[a-z][a-z0-9+.-]*:\/\//i.test(x)) ?? '';
      const method = (() => {
        const i = args.findIndex((x) => x === '-X' || x === '--request');
        return i >= 0 ? (args[i + 1] ?? '').toUpperCase() : '';
      })();
      const hasBody = args.some(
        (x) =>
          x === '-d' ||
          x === '--data' ||
          x === '--data-raw' ||
          x === '--json' ||
          x === '-F' ||
          x === '-T'
      );
      const mutates = (method !== '' && method !== 'GET' && method !== 'HEAD') || hasBody;
      network = { tool: exe, target: hostOf(url) ?? (url || 'unknown host'), mutates };
      bump(method === 'DELETE' ? 'destructive' : 'remote');
      const oi = args.findIndex(
        (x) => x === '-o' || x === '--output' || x === '-O' || x === '--output-document'
      );
      if (oi >= 0 && args[oi + 1] && args[oi + 1] !== '-') {
        files.push({ path: args[oi + 1], operation: 'write' });
        bump('remote');
      }
      break;
    }
    default: {
      const ik = interpKind(exe);
      if (ik) {
        bump('local_write');
        const codeIdx = args.findIndex((x) => CODE_FLAG[ik].test(x));
        if (codeIdx >= 0 && args[codeIdx + 1] !== undefined) {
          interpNested = true;
          if (ik === 'powershell') {
            if (/^-(?:e|enc|encodedcommand)$/i.test(args[codeIdx]))
              destructive('encoded PowerShell command (opaque payload)');
            else nestedFrom(args.slice(codeIdx + 1).join(' '), 'powershell');
          } else if (ik !== 'other') {
            const code = args[codeIdx + 1];
            nestedFrom(code, ik);
            if (FETCH_SUBST.test(code)) destructive(REMOTE_EXEC_REASON);
          }
        } else {
          const script = args.find((x) => !x.startsWith('-') && x !== '-');
          if (script) execFile = script;
        }
      } else if (/^mkfs(?:\..+)?$/.test(exe) || DESTRUCTIVE_TOOLS.has(exe)) {
        destructive();
      } else if (REMOTE_TOOLS.has(exe)) {
        const words = nonFlags(args);
        const isDestructive =
          words.some((w) => w.split(':').some((part) => DESTRUCTIVE_VERB.test(part))) ||
          (exe === 'rsync' && args.some((x) => /^--(?:delete|remove-source-files)/.test(x))) ||
          (['psql', 'mysql', 'mongosh', 'mongo', 'redis-cli'].includes(exe) &&
            args.some((x) => DB_DESTRUCTIVE.test(x.slice(0, 5000)))) ||
          (exe === 'aws' && words[0] === 's3' && (words[1] === 'rm' || words[1] === 'rb'));
        const mutates =
          isDestructive ||
          words.some((w) =>
            /^(apply|create|patch|scale|put|push|deploy|update|run|start|stop|cp|sync|replace|set|annotate|label|rollout|exec|copy|upgrade|install)$/.test(
              w
            )
          );
        network = { tool: exe, target: words.slice(0, 2).join(' ') || exe, mutates };
        bump(isDestructive ? 'destructive' : 'remote');
        if (
          exe === 'ssh' ||
          (exe === 'kubectl' && words[0] === 'exec') ||
          exe === 'fly' ||
          exe === 'flyctl'
        ) {
          const quoted = args[args.length - 1];
          if (exe === 'ssh' && quoted && /\s/.test(quoted)) nestedFrom(quoted);
          else nestedAfterHost();
        }
      } else if (PACKAGE_MANAGERS.has(exe)) {
        const sub = nonFlags(args)[0] ?? '';
        if (sub === 'publish' || sub === 'unpublish') {
          network = { tool: exe, target: sub, mutates: true };
          destructive();
        } else if (
          /^(install|i|add|ci|update|upgrade|dlx|exec)$/.test(sub) ||
          exe === 'npx' ||
          exe === 'pnpx'
        ) {
          network = { tool: exe, target: sub || exe, mutates: false };
          bump('remote');
          bump('local_write');
        } else {
          bump('local_write');
        }
      } else if (exe === 'docker' || exe === 'podman' || exe === 'docker-compose') {
        const sub = nonFlags(args)[0] ?? '';
        if (sub === 'push' || sub === 'pull' || sub === 'login') {
          network = { tool: exe, target: sub, mutates: sub === 'push' };
          bump('remote');
        } else if (/^(rm|rmi|prune|kill|system)$/.test(sub)) {
          destructive();
        } else if (
          (sub === 'down' || (sub === 'compose' && nonFlags(args)[1] === 'down')) &&
          args.some((x) => x === '-v' || x === '--volumes')
        ) {
          destructive();
        } else {
          bump('local_write');
        }
        if (sub === 'exec' || sub === 'run') nestedAfterHost();
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
        if (inner[0].includes('/') && !/^\/(?:usr\/)?s?bin\//.test(inner[0])) execFile = inner[0];
      }
    }
  }

  // Here-string into an interpreter (`bash <<< "rm -rf ~"`): the string is the program.
  const hs = inner.findIndex((t) => t.startsWith('<<<'));
  if (hs >= 0) {
    const target = execTargetOf(inner.slice(0, hs).join(' '));
    const text = inner[hs].length > 3 ? inner[hs].slice(3) : (inner[hs + 1] ?? '');
    if (target && text) nested.push({ text, lang: target });
  }
  const stdinTarget = interpNested ? null : stdinTargetOf(inner);
  return {
    kind,
    recognized,
    files: files.filter((f) => f.path.trim() !== ''),
    network,
    nested,
    reason,
    inner,
    stdinTarget,
    execFile,
  };
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

/** Maximum recursion into `sh -c` strings, heredoc bodies and embedded code. */
const MAX_DEPTH = 6;
/** Maximum number of nested analyses per dossier (bounds pathological self-nesting input). */
const MAX_NESTED = 20000;
/** Heredocs analysed per line; any beyond this are conservatively treated as shell code. */
const MAX_HEREDOCS_PER_LINE = 16;

interface Ctx {
  commands: DryRunCommand[];
  files: DryRunFile[];
  network: DryRunNetwork[];
  env: Map<string, DryRunEnv>;
  /** Variables the dossier assigns itself are internal state, not external inputs. */
  assigned: Set<string>;
  /** Files written by a fetch command; executing one later is remote code execution. */
  downloaded: Set<string>;
  unanalyzed: Array<{ lang: string; line: number }>;
  budget: number;
  gaveUp: Set<string>;
}

/**
 * Nested content we refuse to analyse (too deep / too much) is NOT assumed safe:
 * it is recorded as a destructive finding so the level cannot be lowered by padding or nesting.
 */
function giveUp(ctx: Ctx, line: number, why: string) {
  if (ctx.gaveUp.has(why)) return;
  ctx.gaveUp.add(why);
  ctx.commands.push({
    command: `(${why})`,
    kind: 'destructive',
    recognized: false,
    line,
    reason: why,
  });
}

const normPath = (p: string) => p.replace(/^\.\//, '');

const isFetch = (c: Classified | null): boolean =>
  !!c &&
  (FETCH_TOOLS.has(c.inner[0]?.replace(/^.*\//, '') ?? '') ||
    (c.inner[0] === 'gh' && c.inner[1] === 'api'));

function isDecoder(c: Classified | null): boolean {
  if (!c) return false;
  const exe = c.inner[0]?.replace(/^.*\//, '') ?? '';
  const args = c.inner.slice(1);
  if (exe === 'base64') return args.some((a) => a === '-d' || a === '-D' || a === '--decode');
  if (exe === 'xxd') return args.includes('-r');
  if (exe === 'openssl')
    return args.includes('-d') || args.includes('-base64') || args.includes('-a');
  if (exe === 'gzip') return args.some((a) => a === '-d' || a === '--decompress');
  if (exe === 'unzip') return args.includes('-p');
  return /^(?:zcat|gzcat|gunzip|bunzip2|xzcat|unxz|uudecode|rev)$/.test(exe);
}

const isExecSink = (c: Classified): boolean => {
  const exe = c.inner[0]?.replace(/^.*\//, '') ?? '';
  return exe === 'eval' || exe === 'source' || exe === '.' || interpKind(exe) !== null;
};

function pushHits(hits: CodeHit[], ctx: Ctx, depth: number) {
  for (const h of hits) {
    if (h.command) {
      ctx.commands.push({
        command: h.command,
        kind: h.kind,
        recognized: true,
        line: h.line,
        ...(h.reason ? { reason: h.reason } : {}),
      });
      if (h.file) ctx.files.push({ ...h.file, command: h.command, line: h.line });
      if (h.network) ctx.network.push({ ...h.network, command: h.command, line: h.line });
    }
    for (const s of h.shell ?? []) analyzeShellText(s, h.line, ctx, depth + 1);
  }
}

function analyzeNested(n: Nested, line: number, ctx: Ctx, depth: number) {
  if (n.lang === 'shell') {
    analyzeShellText(n.text, line, ctx, depth + 1);
    return;
  }
  if (depth + 1 > MAX_DEPTH || ctx.budget-- <= 0) {
    giveUp(ctx, line, 'nested content too deep or too large to analyse');
    return;
  }
  const lang: CodeLang | null =
    n.lang === 'sql'
      ? 'sql'
      : n.lang === 'js'
        ? 'js'
        : n.lang === 'powershell'
          ? 'powershell'
          : n.lang;
  pushHits(extractCodeHits(lang, n.text.split('\n'), line), ctx, depth + 1);
}

/** Analyse one logical shell line (already stripped of prompts) and everything it embeds. */
function analyzeShellText(clean: string, line: number, ctx: Ctx, depth: number) {
  if (depth > MAX_DEPTH || (depth > 0 && ctx.budget-- <= 0)) {
    giveUp(ctx, line, 'nested content too deep or too large to analyse');
    return;
  }

  for (const sub of dqSubstitutions(clean)) {
    processShellFence(
      { lang: 'sh', startLine: line, lines: sub.split('\n') },
      false,
      ctx,
      depth + 1
    );
  }

  const segs = splitSegments(clean);
  const infos = segs.map((s) => classifyCommand(s.text, s.text));

  // What earlier stages of the same pipeline are (incrementally, so long pipelines stay linear).
  let curGroup = -1;
  let acc = { any: false, fetch: false, decode: false, echoes: [] as Classified[] };

  segs.forEach((seg, i) => {
    const c = infos[i];
    if (seg.group !== curGroup) {
      curGroup = seg.group;
      acc = { any: false, fetch: false, decode: false, echoes: [] };
    }
    const prev = { ...acc, echoes: acc.echoes.slice() };
    if (c) {
      acc.any = true;
      acc.fetch ||= isFetch(c);
      acc.decode ||= isDecoder(c);
      const pe = c.inner[0]?.replace(/^.*\//, '');
      if ((pe === 'echo' || pe === 'printf') && acc.echoes.length < 8) acc.echoes.push(c);
    }
    if (!c) return;
    // Unknown words after a pipe are almost always prose (`a|b|c` alternatives), not tools.
    if (i > 0 && !c.recognized && c.files.length === 0) return;
    let kind = c.kind;
    let reason = c.reason;
    const remoteExec = (why: string) => {
      kind = 'destructive';
      reason ??= why;
    };

    if (c.stdinTarget && prev.any) {
      if (prev.fetch) {
        remoteExec('remote code execution: fetched content piped into an interpreter');
      } else if (prev.decode) {
        remoteExec('decoded payload piped into an interpreter');
      } else {
        for (const p of prev.echoes) {
          const pe = p.inner[0]?.replace(/^.*\//, '');
          let words = nonFlags(p.inner.slice(1));
          if (pe === 'printf' && words[0]?.includes('%')) words = words.slice(1);
          if (words.length > 0)
            analyzeNested({ text: words.join(' '), lang: c.stdinTarget }, line, ctx, depth);
        }
      }
    }

    // `bash <(curl ...)`, `eval $(curl ...)`, `sh -c $(curl ...)`: fetched content feeds an exec sink.
    const next = segs[i + 1];
    const nextInfo = infos[i + 1];
    if (
      next &&
      nextInfo &&
      isExecSink(c) &&
      (isFetch(nextInfo) || isDecoder(nextInfo)) &&
      (next.sep === '$(' || next.sep === '`' || (next.sep === '(' && /<\s*$/.test(seg.text)))
    ) {
      remoteExec('remote code execution: fetched content is executed');
    }

    if (isFetch(c)) for (const f of c.files) ctx.downloaded.add(normPath(f.path));
    if (c.execFile && ctx.downloaded.has(normPath(c.execFile))) {
      remoteExec('executes a file that was downloaded earlier in the dossier');
    }

    ctx.commands.push({
      command: seg.text,
      kind,
      recognized: c.recognized,
      line,
      ...(reason ? { reason } : {}),
    });
    for (const f of c.files) ctx.files.push({ ...f, command: seg.text, line });
    if (c.network) ctx.network.push({ ...c.network, command: seg.text, line });
    for (const n of c.nested) analyzeNested(n, line, ctx, depth);
  });
}

function scanEnvShell(clean: string, line: number, ctx: Ctx) {
  for (const m of clean.matchAll(/(?:^|[\s;&(])([A-Za-z_][A-Za-z0-9_]*)=/g)) ctx.assigned.add(m[1]);
  for (const m of clean.matchAll(
    /\b(?:for|read(?:\s+-\w+)*|local|declare|export)\s+([A-Za-z_][A-Za-z0-9_]*)/g
  ))
    ctx.assigned.add(m[1]);
  const envText = clean.replace(/'[^']*'/g, (q) => ' '.repeat(q.length));
  for (const m of envText.matchAll(ENV_SHELL)) {
    const name = m[1] ?? m[2];
    if (name && !ctx.assigned.has(name) && !IGNORED_ENV.has(name) && !ctx.env.has(name)) {
      ctx.env.set(name, { name, line });
    }
  }
}

function processShellFence(fence: Fence, isBare: boolean, ctx: Ctx, depth: number) {
  if (depth > MAX_DEPTH) {
    giveUp(ctx, fence.startLine, 'nested content too deep or too large to analyse');
    return;
  }
  for (const { text, line, heredocs } of logicalLines(fence)) {
    if (!text || text.startsWith('#')) continue;

    // Strip a leading `$ ` prompt used in console-style blocks.
    const clean = text.replace(/^\$\s+/, '');
    // Unlabeled fences are often templates (PR bodies, commit messages); only trust known tools.
    const skip =
      isBare &&
      !KNOWN_TOOL_NAMES.has(stripEnvAssignments(tokenize(clean))[0]?.replace(/^.*\//, '') ?? '');
    if (skip) continue;

    scanEnvShell(clean, line, ctx);
    analyzeShellText(clean, line, ctx, depth);

    // A heredoc fed to a shell / interpreter is code; one fed to `cat > file` / `tee` is data.
    for (const h of heredocs) {
      if (!h.exec || h.body.length === 0) continue;
      if (h.exec === 'shell') {
        processShellFence(
          { lang: 'sh', startLine: h.bodyLine, lines: h.body },
          false,
          ctx,
          depth + 1
        );
      } else if (ctx.budget-- > 0) {
        pushHits(extractCodeHits(h.exec, h.body, h.bodyLine), ctx, depth + 1);
      }
    }
  }
}

function processFence(fence: Fence, ctx: Ctx) {
  const lang = fence.lang;
  if (SHELL_LANGS.has(lang) || lang === '') {
    processShellFence(fence, lang === '', ctx, 0);
    return;
  }
  let code = CODE_LANGS[lang];
  if (lang === 'docker') {
    // ```docker holds either a Dockerfile or `docker ...` shell commands.
    const isDockerfile = fence.lines.some((l) =>
      /^\s*(?:FROM|RUN|COPY|ADD|ENV|WORKDIR|CMD|ENTRYPOINT|ARG)\s/.test(l)
    );
    if (!isDockerfile) {
      processShellFence(fence, false, ctx, 0);
      return;
    }
    code = 'dockerfile';
  }
  if (!code) {
    if (!INERT_LANGS.has(lang)) ctx.unanalyzed.push({ lang, line: fence.startLine });
    return;
  }
  pushHits(extractCodeHits(code, fence.lines, fence.startLine), ctx, 0);
  if (code === 'js') {
    fence.lines.forEach((text, idx) => {
      for (const m of text.matchAll(ENV_NODE)) {
        const name = m[1] ?? m[2];
        if (name && !ctx.env.has(name)) ctx.env.set(name, { name, line: fence.startLine + idx });
      }
    });
  }
}

const LEVEL_RANK: Record<DryRunLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function analyzeDryRun(
  input: string | { frontmatter: DossierFrontmatter; body: string }
): DryRunPlan {
  const { frontmatter, body } = typeof input === 'string' ? parseDossierContent(input) : input;

  const ctx: Ctx = {
    commands: [],
    files: [],
    network: [],
    env: new Map(),
    assigned: new Set(),
    downloaded: new Set(),
    unanalyzed: [],
    budget: MAX_NESTED,
    gaveUp: new Set(),
  };
  for (const fence of extractFences(body)) processFence(fence, ctx);
  const { commands, files, network } = ctx;

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
  let observedPts = 0;
  for (const kind of ['local_write', 'remote', 'destructive'] as const) {
    const n = commands.filter((c) => c.kind === kind).length;
    const pts = Math.min(n * SCORE_PER_COMMAND[kind], SCORE_COMMAND_CAP[kind]);
    observedPts += pts;
    if (pts > 0)
      breakdown.push({
        component: `${n} ${kind} command${n === 1 ? '' : 's'} in code blocks`,
        points: pts,
      });
  }
  // Observed behaviour outranks the dossier's self-declared risk: a destructive command
  // floors the level at high no matter what risk_level the dossier declares.
  const hasDestructive = commands.some((c) => c.kind === 'destructive');
  if (hasDestructive) {
    const total = breakdown.reduce((s, b) => s + b.points, 0);
    if (total < LEVEL_HIGH_MIN) {
      breakdown.push({
        component:
          'floor: destructive command observed (raised to high regardless of declared risk)',
        points: LEVEL_HIGH_MIN - total,
      });
    }
    observedPts = Math.max(observedPts, LEVEL_HIGH_MIN);
  }
  const risk_score = Math.min(
    100,
    breakdown.reduce((s, b) => s + b.points, 0)
  );
  const level = levelForScore(risk_score);
  const observedLevel = levelForScore(Math.min(100, observedPts));
  const declaredRank =
    riskLevel && riskLevel in LEVEL_RANK ? LEVEL_RANK[riskLevel as DryRunLevel] : 0;
  const mismatch = LEVEL_RANK[observedLevel] > declaredRank;

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
    env: [...ctx.env.values()],
    risk_score,
    level,
    score_breakdown: breakdown,
    declared_vs_observed: {
      declared_level: riskLevel,
      observed_level: observedLevel,
      mismatch,
      note: mismatch
        ? `Code blocks show ${observedLevel}-risk behaviour but the dossier declares ${riskLevel ?? 'no risk_level'}.`
        : 'Observed behaviour is consistent with the declared risk level.',
    },
    unanalyzed_fences: ctx.unanalyzed,
  };
}
