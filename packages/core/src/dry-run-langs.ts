/**
 * Small per-language extractors for the dry-run analyzer (issue #933).
 *
 * Each extractor pattern-matches the *obvious* exec / delete / network / write
 * calls of a non-shell fence and returns hits. Hits that embed a shell command
 * (`os.system("rm -rf ~")`, `RUN rm -rf /`, `execSync('...')`) carry the literal
 * text in `shell`, which the caller re-analyses with the shell classifier.
 *
 * Every regex here is a fixed alternation with bounded (or single-pass) repeats,
 * so matching is linear in the line length; lines are additionally clipped to
 * MAX_LINE_CHARS before matching.
 */

import type { DryRunKind } from './dry-run';

export type CodeLang =
  | 'python'
  | 'js'
  | 'powershell'
  | 'dockerfile'
  | 'ruby'
  | 'perl'
  | 'sql'
  | 'yaml';

export interface CodeHit {
  /** Command text shown in the plan; empty for a hit that only carries `shell`. */
  command: string;
  kind: DryRunKind;
  line: number;
  /** Literal shell command lines embedded in the call, to be analysed as shell. */
  shell?: string[];
  file?: { path: string; operation: 'write' | 'delete' | 'move' };
  network?: { tool: string; target: string; mutates: boolean };
  reason?: string;
}

/** Lines longer than this are clipped before regex matching (keeps matching cheap and bounded). */
export const MAX_LINE_CHARS = 4000;

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** String literals appearing after `from` on the line, unquoted, at most `max` of them. */
function literalsAfter(line: string, from: number, max = 24): string[] {
  const out: string[] = [];
  for (const m of line.slice(from).matchAll(STRING_LITERAL)) {
    out.push(m[0].slice(1, -1).replace(/\\(["'`\\])/g, '$1'));
    if (out.length >= max) break;
  }
  return out;
}

function hostFromText(s: string): string {
  const m = s.match(/[a-z][a-z0-9+.-]*:\/\/([^/\s:'"`)]+)/i);
  return m ? m[1] : 'unknown host';
}

const FETCH_OR_DECODE_HINT =
  /\b(?:requests\.|urlopen|urllib|httpx\.|fetch\s*\(|axios|https?\.get|b64decode|atob|Buffer\.from|zlib\.|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|DownloadString|FromBase64String|Net::HTTP|open-uri|URI\.open|LWP)/;

// --- python ----------------------------------------------------------------

const PY_EXEC =
  /\.(?:system|popen)\s*\(|\bsubprocess\.\w+\s*\(|(?<![\w.])(?:check_output|check_call|getoutput|Popen)\s*\(|\bos\.(?:exec|spawn)\w*\s*\(|\bpty\.spawn\s*\(|\basyncio\.create_subprocess_\w+\s*\(|\bpexpect\.(?:spawn|run)\s*\(/g;
const PY_DELETE =
  /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|send2trash)\s*\(|\.(?:unlink|rmdir|rmtree)\s*\(/g;
const PY_WRITE =
  /\bshutil\.(?:copy\w*|move)\s*\(|\bos\.(?:rename|replace|makedirs|mkdir|chmod|chown)\s*\(|\.(?:write_text|write_bytes|mkdir|touch)\s*\(|\bopen\s*\(\s*(?:"[^"\n]*"|'[^'\n]*')\s*,\s*["'][wax]/g;
const PY_NET =
  /\brequests\.(get|post|put|delete|patch|head)\s*\(|\b(?:urlopen|urlretrieve)\s*\(|\bhttpx\.(?:get|post|put|delete|patch|Client|AsyncClient)\b|\baiohttp\.\w+|\bparamiko\.\w+|\bsmtplib\.\w+/g;
const PY_EVAL = /\b(?:exec|eval)\s*\(/;

// --- js / ts ---------------------------------------------------------------

const JS_EXEC =
  /(?<![\w.$])(?:execSync|execFileSync|spawnSync|spawn|execFile|exec|fork)\s*\(|\.(?:execSync|execFileSync|spawnSync|spawn|execFile)\s*\(|\b(?:child_process|childProcess|cp)\.exec\s*\(|\bBun\.(?:spawn|spawnSync)\s*\(|\bDeno\.Command\s*\(|\bexeca(?:Sync|Command|CommandSync)?\s*\(|(?<![\w$])\$\s*`|\bshell(?:js)?\.exec\s*\(|\bBun\.\$\s*`/g;
const JS_DELETE =
  /\b(?:fs|fsp|promises|fse|fsExtra)\.(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink|remove|removeSync|emptyDir|emptyDirSync)\s*\(|(?<![\w.$])(?:rmSync|unlinkSync|rmdirSync|rimraf|rimrafSync)\s*\(|\.(?:rmSync|unlinkSync|rmdirSync)\s*\(|\brimraf(?:\.sync)?\s*\(|\bDeno\.remove(?:Sync)?\s*\(/g;
const JS_WRITE =
  /\b(?:fs|fsp|promises|fse|fsExtra)\.(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|copyFile|copyFileSync|rename|renameSync|cp|cpSync|createWriteStream|chmod|chmodSync|outputFile|outputFileSync)\s*\(|\bDeno\.writeTextFile(?:Sync)?\s*\(|\bBun\.write\s*\(/g;
const JS_NET =
  /(?<![\w.$])fetch\s*\(|\baxios(?:\.(get|post|put|delete|patch|head))?\s*\(|\b(?:https?|http2)\.(?:request|get)\s*\(|(?<![\w.$])got(?:\.(get|post|put|delete|patch))?\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket)\b/g;
const JS_EVAL = /\b(?:eval|new\s+Function|vm\.runIn\w+)\s*\(/;

// --- powershell / cmd ------------------------------------------------------

const PS_DELETE =
  /(?<![\w-])(?:Remove-Item|Remove-ItemProperty|Remove-\w+|Clear-Disk|Clear-Content|Format-Volume|Initialize-Disk|Stop-Computer|Restart-Computer|Uninstall-\w+|Unregister-\w+|Disable-\w+)(?![\w-])|(?<![\w-])(?:ri|rd|rmdir|del|erase)\s+(?:[-/]\S+\s+)*[^\s/-]|(?<![\w-])(?:reg(?:\.exe)?\s+delete|format\s+[a-z]:|diskpart)\b/gi;
const PS_FETCH =
  /(?<![\w-])(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|iwr|irm)(?![\w-])|\bNet\.WebClient\b|\.Download(?:String|File|Data)\s*\(|\bcertutil\b[^\n]*-urlcache/gi;
const PS_EXEC = /(?<![\w-])(?:iex|Invoke-Expression)(?![\w-])/i;
const PS_WRITE =
  /(?<![\w-])(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Export-\w+|Tee-Object|Start-Process|Invoke-Command)(?![\w-])/gi;
const PS_ENCODED = /-(?:enc|encodedcommand|e)\b|FromBase64String/i;
const PS_CLI_LINE =
  /^\s*(?:git|gh|npm|pnpm|yarn|npx|docker|kubectl|terraform|aws|az|gcloud|curl|wget|ssh|scp|make|cargo|pip3?|python[\d.]*|node|rm|mv|cp|dd|sudo)\b/;

// --- ruby / perl -----------------------------------------------------------

const RB_EXEC =
  /(?<![\w.])(?:system|exec|spawn)\s*\(|(?<![\w.])(?:system|exec|spawn)\s+["']|%x[[{(]|\bIO\.popen\s*\(|\bOpen3\.\w+\s*\(|\bKernel\.(?:system|exec|spawn)\b|\bqx\s*[/{([]|\bopen\s*\(\s*["']\s*\|/g;
const RB_DELETE =
  /\b(?:File\.(?:delete|unlink)|FileUtils\.(?:rm|rm_rf|rm_r|rm_f|remove_entry|remove_dir)|Dir\.rmdir|unlink|rmtree)\b/g;
const RB_NET = /\b(?:Net::HTTP|URI\.open|open-uri|LWP::\w+|HTTP::Tiny)\b/g;
const RB_BACKTICK = /`([^`\n]+)`/g;

// --- sql -------------------------------------------------------------------

const SQL_DESTRUCTIVE =
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|USER|ROLE|VIEW|COLLECTION)|TRUNCATE(?:\s+TABLE)?|dropDatabase|FLUSH(?:ALL|DB))\b/i;
const SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|ALTER\s+TABLE|CREATE\s+(?:TABLE|DATABASE|USER)|GRANT)\b/i;
const SQL_DELETE = /\bDELETE\s+FROM\b/i;

// ---------------------------------------------------------------------------

function pushShellFromCall(
  hits: CodeHit[],
  line: string,
  lineNo: number,
  at: number,
  matchLen: number,
  label: string
) {
  const lits = literalsAfter(line, at + matchLen);
  hits.push({
    command: line.trim(),
    kind: 'local_write',
    line: lineNo,
    shell: lits.length > 0 ? [lits.join(' ')] : undefined,
    reason: label,
  });
}

function scanPython(line: string, no: number, hits: CodeHit[]) {
  for (const m of line.matchAll(PY_EXEC))
    pushShellFromCall(hits, line, no, m.index ?? 0, m[0].length, 'python process execution');
  for (const m of line.matchAll(PY_DELETE)) {
    const lit = literalsAfter(line, (m.index ?? 0) + m[0].length, 1)[0];
    hits.push({
      command: line.trim(),
      kind: 'destructive',
      line: no,
      file: { path: lit ?? '(computed path)', operation: 'delete' },
    });
  }
  for (const m of line.matchAll(PY_WRITE)) {
    const lit = literalsAfter(line, (m.index ?? 0) + m[0].length, 1)[0];
    hits.push({
      command: line.trim(),
      kind: 'local_write',
      line: no,
      file: lit ? { path: lit, operation: 'write' } : undefined,
    });
  }
  for (const m of line.matchAll(PY_NET)) {
    const verb = (m[1] ?? '').toLowerCase();
    const mutates = verb !== '' && verb !== 'get' && verb !== 'head';
    hits.push({
      command: line.trim(),
      kind: verb === 'delete' ? 'destructive' : 'remote',
      line: no,
      network: { tool: 'python', target: hostFromText(line), mutates },
    });
  }
  if (PY_EVAL.test(line) && FETCH_OR_DECODE_HINT.test(line)) {
    hits.push({
      command: line.trim(),
      kind: 'destructive',
      line: no,
      reason: 'executes fetched or decoded code',
    });
  }
}

function scanJs(line: string, no: number, hits: CodeHit[]) {
  for (const m of line.matchAll(JS_EXEC))
    pushShellFromCall(hits, line, no, m.index ?? 0, m[0].length, 'javascript process execution');
  for (const m of line.matchAll(JS_DELETE)) {
    const lit = literalsAfter(line, (m.index ?? 0) + m[0].length, 1)[0];
    hits.push({
      command: line.trim(),
      kind: 'destructive',
      line: no,
      file: { path: lit ?? '(computed path)', operation: 'delete' },
    });
  }
  for (const m of line.matchAll(JS_WRITE)) {
    const lit = literalsAfter(line, (m.index ?? 0) + m[0].length, 1)[0];
    hits.push({
      command: line.trim(),
      kind: 'local_write',
      line: no,
      file: lit ? { path: lit, operation: 'write' } : undefined,
    });
  }
  for (const m of line.matchAll(JS_NET)) {
    const verb = (m[1] ?? m[2] ?? '').toLowerCase();
    const explicit = line.match(/method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i)?.[1];
    const method = (explicit ?? verb).toLowerCase();
    const mutates = method !== '' && method !== 'get' && method !== 'head';
    hits.push({
      command: line.trim(),
      kind: method === 'delete' ? 'destructive' : 'remote',
      line: no,
      network: { tool: 'javascript', target: hostFromText(line), mutates },
    });
  }
  if (JS_EVAL.test(line)) {
    const fetched = FETCH_OR_DECODE_HINT.test(line);
    hits.push({
      command: line.trim(),
      kind: fetched ? 'destructive' : 'local_write',
      line: no,
      reason: fetched ? 'executes fetched or decoded code' : 'dynamic code evaluation',
    });
  }
}

function scanPowerShell(line: string, no: number, hits: CodeHit[], state: { fetched: boolean }) {
  let matched = false;
  for (const m of line.matchAll(PS_DELETE)) {
    matched = true;
    const rest = line.slice((m.index ?? 0) + m[0].length);
    const target = rest.match(/(?:-Path\s+)?(["']?)([^\s"'|;-][^\s"'|;]*)\1/)?.[2];
    hits.push({
      command: line.trim(),
      kind: 'destructive',
      line: no,
      file: { path: target ?? '(computed path)', operation: 'delete' },
    });
  }
  const fetches = [...line.matchAll(PS_FETCH)];
  if (fetches.length > 0) {
    matched = true;
    state.fetched = true;
    const mutates = /-Method\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(line);
    hits.push({
      command: line.trim(),
      kind: 'remote',
      line: no,
      network: { tool: 'powershell', target: hostFromText(line), mutates },
    });
  }
  if (PS_EXEC.test(line)) {
    matched = true;
    const remoteExec = state.fetched || fetches.length > 0 || PS_ENCODED.test(line);
    hits.push({
      command: line.trim(),
      kind: remoteExec ? 'destructive' : 'local_write',
      line: no,
      reason: remoteExec ? 'executes fetched or decoded code (iex)' : 'dynamic code evaluation',
    });
  } else if (/(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:enc|encodedcommand)\b/i.test(line)) {
    matched = true;
    hits.push({
      command: line.trim(),
      kind: 'destructive',
      line: no,
      reason: 'encoded PowerShell command (opaque payload)',
    });
  }
  for (const _m of line.matchAll(PS_WRITE)) {
    matched = true;
    hits.push({ command: line.trim(), kind: 'local_write', line: no });
    break;
  }
  if (!matched && PS_CLI_LINE.test(line)) {
    hits.push({ command: '', kind: 'read', line: no, shell: [line.trim()] });
  }
}

function scanRubyPerl(line: string, no: number, hits: CodeHit[]) {
  for (const m of line.matchAll(RB_EXEC))
    pushShellFromCall(hits, line, no, m.index ?? 0, m[0].length, 'process execution');
  for (const m of line.matchAll(RB_BACKTICK)) {
    hits.push({
      command: line.trim(),
      kind: 'local_write',
      line: no,
      shell: [m[1]],
      reason: 'backtick process execution',
    });
  }
  for (const m of line.matchAll(RB_DELETE)) {
    const lit = literalsAfter(line, (m.index ?? 0) + m[0].length, 1)[0];
    hits.push({
      command: line.trim(),
      kind: 'destructive',
      line: no,
      file: { path: lit ?? '(computed path)', operation: 'delete' },
    });
  }
  for (const _m of line.matchAll(RB_NET)) {
    hits.push({
      command: line.trim(),
      kind: 'remote',
      line: no,
      network: { tool: 'script', target: hostFromText(line), mutates: false },
    });
    break;
  }
  if (/\b(?:eval|instance_eval)\b/.test(line) && FETCH_OR_DECODE_HINT.test(line)) {
    hits.push({
      command: line.trim(),
      kind: 'destructive',
      line: no,
      reason: 'executes fetched or decoded code',
    });
  }
}

function scanSql(line: string, no: number, hits: CodeHit[]) {
  const network = { tool: 'sql', target: 'database', mutates: true };
  if (SQL_DESTRUCTIVE.test(line) || (SQL_DELETE.test(line) && !/\bWHERE\b/i.test(line))) {
    hits.push({ command: line.trim(), kind: 'destructive', line: no, network });
  } else if (SQL_DELETE.test(line) || SQL_WRITE.test(line)) {
    hits.push({ command: line.trim(), kind: 'remote', line: no, network });
  }
}

/** `["a", "b"]` exec-form or plain shell-form instruction argument -> one shell command line. */
function instructionToShell(rest: string): string {
  const t = rest.trim();
  if (t.startsWith('[')) return literalsAfter(t, 0, 40).join(' ');
  return t;
}

function scanDockerfile(line: string, no: number, hits: CodeHit[]) {
  const m = line.match(
    /^\s*(?:ONBUILD\s+)?(RUN|CMD|ENTRYPOINT|HEALTHCHECK\s+(?:--\S+\s+)*CMD|ADD|COPY)\s+(?:--\S+\s+)*(.*)$/i
  );
  if (!m) return;
  const instr = m[1].toUpperCase();
  const rest = m[2];
  if (instr === 'ADD' || instr === 'COPY') {
    if (/https?:\/\//i.test(rest)) {
      hits.push({
        command: line.trim(),
        kind: 'remote',
        line: no,
        network: { tool: 'docker', target: hostFromText(rest), mutates: false },
      });
    }
    return;
  }
  const shell = instructionToShell(rest);
  hits.push({
    command: line.trim(),
    kind: 'local_write',
    line: no,
    shell: shell ? [shell] : undefined,
  });
}

const YAML_RUN_KEYS =
  /^(\s*)(?:-\s+)?(run|script|before_script|after_script|command|commands|entrypoint)\s*:\s*(.*)$/;

function scanYaml(lines: string[], startLine: number, hits: CodeHit[]) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].slice(0, MAX_LINE_CHARS).match(YAML_RUN_KEYS);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[3].trim();
    const shell: string[] = [];
    if (rest === '' || /^[|>][+-]?\d*$/.test(rest)) {
      // Block scalar or nested list: every more-indented following line is a command.
      let acc = '';
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j].slice(0, MAX_LINE_CHARS);
        if (raw.trim() === '') continue;
        const ind = raw.length - raw.trimStart().length;
        if (ind <= indent) break;
        const text = raw.trim().replace(/^-\s+/, '');
        if (text.startsWith('#')) continue;
        if (/\\\s*$/.test(text)) {
          acc += `${text.replace(/\\\s*$/, '')} `;
          continue;
        }
        shell.push((acc + text).trim());
        acc = '';
      }
      if (acc.trim()) shell.push(acc.trim());
    } else if (!rest.startsWith('#')) {
      shell.push(instructionToShell(rest.replace(/^(["'])(.*)\1$/, '$2')));
    }
    if (shell.length > 0) {
      hits.push({ command: '', kind: 'read', line: startLine + i, shell });
    }
  }
}

/** Extract hits from a non-shell fence. `lines` are raw fence lines; `startLine` is the first line's number. */
export function extractCodeHits(lang: CodeLang, lines: string[], startLine: number): CodeHit[] {
  const hits: CodeHit[] = [];
  if (lang === 'yaml') {
    scanYaml(lines, startLine, hits);
    return hits;
  }
  const psState = { fetched: false };
  // Dockerfile / python lines joined on `\` continuation keep the first physical line number.
  let acc = '';
  let accLine = 0;
  const flush = (text: string, no: number) => {
    const line = text.slice(0, MAX_LINE_CHARS);
    const trimmed = line.trim();
    if (!trimmed) return;
    switch (lang) {
      case 'python':
        if (!trimmed.startsWith('#')) scanPython(line, no, hits);
        break;
      case 'js':
        if (!trimmed.startsWith('//') && !trimmed.startsWith('*')) scanJs(line, no, hits);
        break;
      case 'powershell':
        if (!trimmed.startsWith('#') && !/^(?:rem|::)\b/i.test(trimmed))
          scanPowerShell(line, no, hits, psState);
        break;
      case 'dockerfile':
        if (!trimmed.startsWith('#')) scanDockerfile(line, no, hits);
        break;
      case 'ruby':
      case 'perl':
        if (!trimmed.startsWith('#')) scanRubyPerl(line, no, hits);
        break;
      case 'sql':
        if (!trimmed.startsWith('--')) scanSql(line, no, hits);
        break;
    }
  };
  lines.forEach((raw, idx) => {
    const no = startLine + idx;
    const continues = lang === 'dockerfile' && /\\\s*$/.test(raw);
    if (!acc) accLine = no;
    if (continues) {
      acc += `${raw.replace(/\\\s*$/, '')} `;
      return;
    }
    flush(acc + raw, accLine);
    acc = '';
  });
  if (acc.trim()) flush(acc, accLine);
  return hits;
}
