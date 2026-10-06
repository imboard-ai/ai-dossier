#!/usr/bin/env node
// Feasibility probe for #1011 (PRD-ZTFC-001 feasibility gate 3).
// Exercises every GitHub write in the PRD §5.9 authority matrix with short-lived
// GitHub App credentials on a controlled upstream/fork pair, and records a
// redacted evidence line per request. See README.md for setup and phases.
//
// Secrets are read at runtime and never printed or written to disk, except the
// rotating refresh token, which lives in a 0600 file under the state directory
// between phases and is deleted by the `revocation` phase.

import { execFileSync, execSync } from 'node:child_process';
import { createSign, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.github.com';
const env = process.env;
const UPSTREAM = env.ZTFC_UPSTREAM ?? 'imboard-ai/ztfc-upstream-fixture';
const CONTRIBUTOR = env.ZTFC_CONTRIBUTOR ?? 'ydhidden';
const ISSUE = Number(env.ZTFC_ISSUE ?? '1');
const REDIRECT_URI = env.ZTFC_REDIRECT_URI ?? 'http://127.0.0.1/callback';
const STATE_DIR = env.ZTFC_STATE_DIR ?? join(homedir(), '.cache', 'ztfc-probe');
const [UP_OWNER, REPO] = UPSTREAM.split('/');
const FORK = `${CONTRIBUTOR}/${REPO}`;

const STATE_FILE = join(STATE_DIR, 'state.json');
const REFRESH_FILE = join(STATE_DIR, 'refresh-token');
const EVIDENCE_FILE = join(STATE_DIR, 'evidence.jsonl');
const WORK_DIR = join(STATE_DIR, 'work');

// ---------------------------------------------------------------- secrets

const secretCache = new Map();
const knownSecrets = new Set();

// ZTFC_<KEY> wins; otherwise ZTFC_SECRET_COMMAND with `{key}` replaced by
// app-id | client-id | client-secret | private-key is run and its stdout used.
function secret(key) {
  if (secretCache.has(key)) return secretCache.get(key);
  const envName = `ZTFC_${key.toUpperCase().replace(/-/g, '_')}`;
  let value = env[envName];
  if (!value) {
    if (!env.ZTFC_SECRET_COMMAND) throw new Error(`set ${envName} or ZTFC_SECRET_COMMAND`);
    value = execSync(env.ZTFC_SECRET_COMMAND.replaceAll('{key}', key), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  value = value.trim();
  secretCache.set(key, value);
  if (key === 'client-secret' || key === 'private-key') knownSecrets.add(value);
  return value;
}

// ---------------------------------------------------------------- redaction / evidence

function redact(text) {
  let out = String(text)
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1[REDACTED]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[JWT-REDACTED]')
    .replace(/([?&]code=)[^&\s"]+/g, '$1[REDACTED]')
    .replace(/([?&]state=)[0-9a-f]{32}/g, '$1[REDACTED]')
    .replace(/(Authorization: \w+ )\S+/gi, '$1[REDACTED]');
  for (const s of knownSecrets) out = out.replaceAll(s, '[SECRET-REDACTED]');
  out = out.replaceAll(STATE_DIR, '$ZTFC_STATE_DIR').replaceAll(homedir(), '~');
  return out;
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function record(entry) {
  ensureStateDir();
  const line = redact(JSON.stringify({ at: new Date().toISOString(), ...entry }));
  appendFileSync(EVIDENCE_FILE, `${line}\n`);
  console.log(line);
}

function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
}

function saveState(patch) {
  ensureStateDir();
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

// ---------------------------------------------------------------- HTTP

function bearer(token, label) {
  return { header: `Bearer ${token}`, label, token };
}

function basicClient() {
  const raw = `${secret('client-id')}:${secret('client-secret')}`;
  return {
    header: `Basic ${Buffer.from(raw).toString('base64')}`,
    label: 'basic(client_id:client_secret)',
  };
}

// Every request is recorded: step, endpoint, credential label, status, the
// GitHub error message and the accepted-permissions header. `pick` extracts the
// non-secret response fields worth keeping as evidence.
async function api(step, method, path, { auth = null, body, pick } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ztfc-credential-probe',
  };
  if (auth) headers.Authorization = auth.header;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  const entry = {
    step,
    request: `${method} ${path}`,
    credential: auth ? auth.label : 'none',
    status: res.status,
  };
  const accepted = res.headers.get('x-accepted-github-permissions');
  if (accepted) entry.acceptedPermissions = accepted;
  if (!res.ok && json) entry.error = json.message ?? json.error ?? json;
  if (!res.ok && json?.errors) entry.errors = json.errors;
  if (res.ok && pick && json) entry.result = pick(json);
  record(entry);
  return { status: res.status, ok: res.ok, json };
}

// ---------------------------------------------------------------- tokens

function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: secret('app-id') })}`;
  const sig = createSign('RSA-SHA256').update(data).sign(secret('private-key'), 'base64url');
  return bearer(`${data}.${sig}`, 'jwt(app)');
}

function tokenShape(json) {
  const prefix = (t) => (typeof t === 'string' ? `${t.slice(0, 4)}…` : t);
  return {
    keys: Object.keys(json).sort(),
    access_token: prefix(json.access_token),
    refresh_token: prefix(json.refresh_token),
    expires_in: json.expires_in,
    refresh_token_expires_in: json.refresh_token_expires_in,
    token_type: json.token_type,
    scope: json.scope,
  };
}

// The OAuth token endpoint reports failures as 200 + {error}; normalise that.
async function oauthToken(step, params) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: secret('client-id'),
      client_secret: secret('client-secret'),
      ...params,
    }),
  });
  const json = await res.json();
  const ok = res.ok && !json.error && Boolean(json.access_token);
  record({
    step,
    request: `POST github.com/login/oauth/access_token (grant_type=${params.grant_type ?? 'authorization_code'})`,
    credential: 'client_id+client_secret',
    status: res.status,
    ...(ok
      ? { result: tokenShape(json) }
      : { error: json.error, error_description: json.error_description }),
  });
  return { ok, json };
}

function saveRefresh(token) {
  ensureStateDir();
  writeFileSync(REFRESH_FILE, token, { mode: 0o600 });
}

async function refresh(step, refreshToken = readFileSync(REFRESH_FILE, 'utf8').trim()) {
  const r = await oauthToken(step, { grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!r.ok) return null;
  saveRefresh(r.json.refresh_token);
  return { access: r.json.access_token, refresh: r.json.refresh_token };
}

// One rotation per phase: the new access token is that phase's ghu_ token and
// the previous access/refresh pair is invalidated by GitHub (checked in Q3).
async function userToken(step) {
  const t = await refresh(`${step}: rotate user token`);
  if (!t) throw new Error('refresh failed — re-run authorize-url/exchange');
  return bearer(t.access, 'ghu(user-to-server)');
}

async function revokeToken(step, token) {
  return api(step, 'DELETE', `/applications/${secret('client-id')}/token`, {
    auth: basicClient(),
    body: { access_token: token },
  });
}

async function installationId() {
  const state = loadState();
  if (state.installationId) return state.installationId;
  if (env.ZTFC_INSTALLATION_ID) return Number(env.ZTFC_INSTALLATION_ID);
  const r = await api('resolve installation', 'GET', `/repos/${FORK}/installation`, {
    auth: appJwt(),
    pick: (j) => ({
      id: j.id,
      account: j.account?.login,
      repository_selection: j.repository_selection,
    }),
  });
  saveState({ installationId: r.json.id });
  return r.json.id;
}

async function forkInstallationToken(step) {
  const r = await api(step, 'POST', `/app/installations/${await installationId()}/access_tokens`, {
    auth: appJwt(),
    body: { repositories: [REPO], permissions: { contents: 'write' } },
    pick: (j) => ({
      token: `${j.token.slice(0, 4)}…`,
      expires_at: j.expires_at,
      permissions: j.permissions,
      repository_selection: j.repository_selection,
      repositories: j.repositories?.map((x) => x.full_name),
    }),
  });
  return bearer(r.json.token, 'ghs(installation, fork only, contents:write)');
}

// ---------------------------------------------------------------- git

// Credentials go in through env-provided config (not argv), any configured
// credential helper is disabled, and global/system config is ignored, so a push
// can only succeed with the token under test.
function git(step, args, { cwd = WORK_DIR, token, allowFail = false } = {}) {
  const gitEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token.token}`).toString('base64');
    gitEnv.GIT_CONFIG_COUNT = '2';
    gitEnv.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
    gitEnv.GIT_CONFIG_VALUE_1 = `Authorization: Basic ${basic}`;
  }
  try {
    const out = execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: 'pipe' });
    if (step)
      record({
        step,
        request: `git ${args.join(' ')}`,
        credential: token?.label ?? 'none',
        status: 'ok',
      });
    return { ok: true, out };
  } catch (err) {
    const stderr = String(err.stderr ?? err.message)
      .trim()
      .split('\n')
      .slice(-4)
      .join(' | ');
    if (step) {
      record({
        step,
        request: `git ${args.join(' ')}`,
        credential: token?.label ?? 'none',
        status: 'failed',
        error: stderr,
      });
    }
    if (!allowFail) throw new Error(redact(stderr));
    return { ok: false, out: stderr };
  }
}

const remote = (slug) => `https://github.com/${slug}.git`;

function remoteSha(branch, slug = FORK) {
  const out = git(null, ['ls-remote', remote(slug), `refs/heads/${branch}`], {
    cwd: STATE_DIR,
  }).out;
  return out.split('\t')[0] || null;
}

async function contributorIdentity() {
  const r = await api('contributor identity', 'GET', `/users/${CONTRIBUTOR}`, {
    pick: (j) => ({ id: j.id }),
  });
  return { name: CONTRIBUTOR, email: `${r.json.id}+${CONTRIBUTOR}@users.noreply.github.com` };
}

// Fixed author/committer identity and timestamp, as in the PRD canonical
// commit contract; the fix is the real one for the fixture bug.
async function prepareCandidate(branch) {
  rmSync(WORK_DIR, { recursive: true, force: true });
  git('clone upstream (anonymous)', ['clone', '--quiet', remote(UPSTREAM), WORK_DIR], {
    cwd: STATE_DIR,
  });
  git(null, ['checkout', '-q', '-b', branch]);
  const src = join(WORK_DIR, 'src', 'range.js');
  writeFileSync(src, readFileSync(src, 'utf8').replace('i < end', 'i <= end'));
  const test = join(WORK_DIR, 'test', 'range.test.js');
  writeFileSync(
    test,
    `${readFileSync(test, 'utf8')}
test('includes the end value (regression for #${ISSUE})', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3]);
  assert.deepEqual(range(2, 2), [2]);
});
`
  );
  const tests = execFileSync('node', ['--test'], {
    cwd: WORK_DIR,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  record({
    step: 'candidate verified',
    request: 'node --test',
    status: 'ok',
    result: tests.match(/[#ℹ] (pass|fail) \d+/g),
  });
  await commit(`fix: make range() include its end value\n\nFixes #${ISSUE}.`);
  return git(null, ['rev-parse', 'HEAD']).out.trim();
}

let identity;
async function commit(message) {
  identity ??= await contributorIdentity();
  const stamp = '2026-10-06T00:00:00Z';
  execFileSync('git', ['add', '-A'], { cwd: WORK_DIR });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: WORK_DIR,
    env: {
      ...env,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    },
  });
}

// ---------------------------------------------------------------- phases

const marker = (runId, kind) => `<!-- ztfc-probe:${runId}:${kind} -->`;

const phases = {
  'authorize-url': async () => {
    const oauthState = randomBytes(16).toString('hex');
    saveState({ oauthState, runId: loadState().runId ?? randomBytes(3).toString('hex') });
    const q = new URLSearchParams({
      client_id: secret('client-id'),
      redirect_uri: REDIRECT_URI,
      state: oauthState,
    });
    // Printed on purpose: this URL is what the contributor opens. It holds no secret.
    process.stdout.write(`https://github.com/login/oauth/authorize?${q}\n`);
  },

  // Reads the pasted redirect URL from stdin, checks `state`, exchanges the
  // code once and keeps only the refresh token.
  exchange: async () => {
    const pasted = readFileSync(0, 'utf8').trim();
    const url = new URL(pasted);
    const expected = loadState().oauthState;
    if (!expected || url.searchParams.get('state') !== expected)
      throw new Error('state mismatch — refusing');
    if (url.searchParams.get('error'))
      throw new Error(`authorization error: ${url.searchParams.get('error')}`);
    const r = await oauthToken('token response shape (code exchange)', {
      code: url.searchParams.get('code'),
      redirect_uri: REDIRECT_URI,
    });
    if (!r.ok) throw new Error('code exchange failed');
    saveRefresh(r.json.refresh_token);
    saveState({ oauthState: null });
    const who = await api('authenticated login', 'GET', '/user', {
      auth: bearer(r.json.access_token, 'ghu(user-to-server)'),
      pick: (j) => ({ login: j.login, id: j.id }),
    });
    if (who.json?.login !== CONTRIBUTOR)
      throw new Error(`authorized as ${who.json?.login}, expected ${CONTRIBUTOR}`);
  },

  discover: async () => {
    const up = await api('upstream identity (anonymous)', 'GET', `/repos/${UPSTREAM}`, {
      pick: (j) => ({ id: j.id, default_branch: j.default_branch, visibility: j.visibility }),
    });
    saveState({ upstreamId: up.json.id, base: up.json.default_branch });
    await api(
      'fork discovery: list forks (anonymous)',
      'GET',
      `/repos/${UPSTREAM}/forks?per_page=100`,
      {
        pick: (j) =>
          j
            .filter((f) => f.owner.login === CONTRIBUTOR)
            .map((f) => ({ full_name: f.full_name, id: f.id })),
      }
    );
    const fork = await api(
      'fork discovery: fork parent binding (anonymous)',
      'GET',
      `/repos/${FORK}`,
      {
        pick: (j) => ({
          id: j.id,
          fork: j.fork,
          parent: j.parent?.full_name,
          parent_id: j.parent?.id,
        }),
      }
    );
    if (fork.json.parent?.id !== up.json.id) throw new Error('fork parent mismatch');
    saveState({ forkId: fork.json.id });
    await api('App installed on upstream?', 'GET', `/repos/${UPSTREAM}/installation`, {
      auth: appJwt(),
    });
    const user = await userToken('discover');
    await api('authenticated login', 'GET', '/user', {
      auth: user,
      pick: (j) => ({ login: j.login }),
    });
    await api('installations visible to user token', 'GET', '/user/installations', {
      auth: user,
      pick: (j) =>
        j.installations.map((i) => ({
          id: i.id,
          account: i.account.login,
          selection: i.repository_selection,
        })),
    });
    await api('fork via user token (Q-fork)', 'POST', `/repos/${UPSTREAM}/forks`, {
      auth: user,
      body: { default_branch_only: true },
      pick: (j) => ({ full_name: j.full_name, id: j.id }),
    });
  },

  'push-user': async () => {
    const { runId } = loadState();
    const branch = `ztfc-probe/range-inclusive-${runId}`;
    const sha = await prepareCandidate(branch);
    const user = await userToken('push-user');
    git('Q4a push to fork with ghu', ['push', remote(FORK), `${sha}:refs/heads/${branch}`], {
      token: user,
    });
    record({
      step: 'Q4a fork branch SHA',
      status: 'ok',
      result: { branch, expected: sha, remote: remoteSha(branch) },
    });
    git(
      'Q4 negative: push to upstream with ghu',
      ['push', remote(UPSTREAM), `${sha}:refs/heads/${branch}`],
      {
        token: user,
        allowFail: true,
      }
    );
    saveState({ branch, candidateSha: sha });
  },

  'upstream-writes': async () => {
    const { runId, branch, base, candidateSha } = loadState();
    const user = await userToken('upstream-writes');
    const comment = await api(
      'Q1 engagement comment on upstream issue',
      'POST',
      `/repos/${UPSTREAM}/issues/${ISSUE}/comments`,
      {
        auth: user,
        body: {
          body: `${marker(runId, 'engagement')}\nCredential probe for imboard-ai/ai-dossier#1011: this comment was posted with a short-lived GitHub App user-to-server token. A fix PR follows.`,
        },
        pick: (j) => ({
          id: j.id,
          user: j.user.login,
          performed_via_github_app: j.performed_via_github_app?.slug ?? null,
        }),
      }
    );
    // Lost-response reconciliation for comments: find ours by hidden marker.
    await api(
      'scenario 11: find engagement comment by marker',
      'GET',
      `/repos/${UPSTREAM}/issues/${ISSUE}/comments?per_page=100`,
      {
        pick: (j) =>
          j
            .filter((c) => c.body.includes(marker(runId, 'engagement')))
            .map((c) => ({ id: c.id, user: c.user.login })),
      }
    );
    const head = `${CONTRIBUTOR}:${branch}`;
    const body = `Fixes #${ISSUE}.\n\n${marker(runId, 'pr')}\n\nCause: the loop used \`<\` so \`end\` was excluded.\nScope: one operator plus a regression test.\nTests: \`node --test\` (2 pass).\n\nThis PR was opened by the ai-dossier credential probe (imboard-ai/ai-dossier#1011) with a GitHub App user-to-server token; it will be closed by the probe.`;
    const pr = await api(
      'Q1 create cross-repo PR (explicit head/base/repo)',
      'POST',
      `/repos/${UPSTREAM}/pulls`,
      {
        auth: user,
        body: {
          title: 'fix: make range() include its end value',
          head,
          base,
          body,
          maintainer_can_modify: false,
        },
        pick: (j) => ({
          number: j.number,
          user: j.user.login,
          head: j.head.label,
          head_sha: j.head.sha,
          base: j.base.ref,
        }),
      }
    );
    if (!pr.ok) {
      saveState({ commentId: comment.json?.id ?? null });
      return;
    }
    const number = pr.json.number;
    saveState({ commentId: comment.json?.id ?? null, prNumber: number });
    if (pr.json.head.sha !== candidateSha) throw new Error('PR head is not the verified SHA');
    // Scenario 11: pretend the create response was lost.
    const q = new URLSearchParams({ head, base, state: 'all' });
    await api(
      'scenario 11: find PR by head+base (state=all)',
      'GET',
      `/repos/${UPSTREAM}/pulls?${q}`,
      {
        pick: (j) =>
          j.map((p) => ({
            number: p.number,
            state: p.state,
            body_has_marker: p.body.includes(marker(runId, 'pr')),
          })),
      }
    );
    await api(
      'scenario 11: duplicate create attempt (expect refusal)',
      'POST',
      `/repos/${UPSTREAM}/pulls`,
      {
        auth: user,
        body: { title: 'duplicate', head, base, body: 'duplicate' },
      }
    );
    await api('Q1 update PR title/body', 'PATCH', `/repos/${UPSTREAM}/pulls/${number}`, {
      auth: user,
      body: {
        title: 'fix: make range() include its end value (probe)',
        body: `${body}\n\n_Updated by the probe._`,
      },
      pick: (j) => ({ title: j.title }),
    });
    await api('Q5 PR attribution', 'GET', `/repos/${UPSTREAM}/issues/${number}`, {
      pick: (j) => ({
        user: j.user.login,
        performed_via_github_app: j.performed_via_github_app?.slug ?? null,
      }),
    });
    await api('Q5 PR commit attribution', 'GET', `/repos/${UPSTREAM}/pulls/${number}/commits`, {
      pick: (j) =>
        j.map((c) => ({
          sha: c.sha,
          author: c.author?.login ?? null,
          committer: c.committer?.login ?? null,
          verified: c.commit.verification?.verified,
          reason: c.commit.verification?.reason,
        })),
    });
    await api('Q1 close PR', 'PATCH', `/repos/${UPSTREAM}/pulls/${number}`, {
      auth: user,
      body: { state: 'closed' },
      pick: (j) => ({ state: j.state }),
    });
    await api('Q1 reopen PR', 'PATCH', `/repos/${UPSTREAM}/pulls/${number}`, {
      auth: user,
      body: { state: 'open' },
      pick: (j) => ({ state: j.state }),
    });
  },

  // When the upstream refuses the PR (Q1), the same reconciliation mechanics are
  // exercised on a PR inside the fork, where the installation grants access.
  // This shows the broker logic works; it does not substitute for an upstream PR.
  'fork-pr-mechanics': async () => {
    const { runId, branch } = loadState();
    const user = await userToken('fork-pr-mechanics');
    const head = `${CONTRIBUTOR}:${branch}`;
    const body = `Fork-internal PR for the #1011 credential probe.\n\n${marker(runId, 'fork-pr')}`;
    const pr = await api(
      'fork PR: create (explicit head/base/repo)',
      'POST',
      `/repos/${FORK}/pulls`,
      {
        auth: user,
        body: { title: 'probe: range() fix (fork-internal)', head, base: 'main', body },
        pick: (j) => ({
          number: j.number,
          user: j.user.login,
          head: j.head.label,
          head_sha: j.head.sha,
        }),
      }
    );
    if (!pr.ok) return;
    const number = pr.json.number;
    saveState({ forkPrNumber: number });
    const q = new URLSearchParams({ head, base: 'main', state: 'all' });
    await api(
      'scenario 11 (fork PR): find PR by head+base (state=all)',
      'GET',
      `/repos/${FORK}/pulls?${q}`,
      {
        pick: (j) =>
          j.map((p) => ({
            number: p.number,
            state: p.state,
            body_has_marker: p.body.includes(marker(runId, 'fork-pr')),
          })),
      }
    );
    await api('scenario 11 (fork PR): duplicate create attempt', 'POST', `/repos/${FORK}/pulls`, {
      auth: user,
      body: { title: 'duplicate', head, base: 'main', body: 'duplicate' },
    });
    await api('fork PR: update title/body', 'PATCH', `/repos/${FORK}/pulls/${number}`, {
      auth: user,
      body: { title: 'probe: range() fix (fork-internal, updated)', body: `${body}\n\n_Updated._` },
      pick: (j) => ({ title: j.title }),
    });
    await api('fork PR: comment', 'POST', `/repos/${FORK}/issues/${number}/comments`, {
      auth: user,
      body: { body: `${marker(runId, 'fork-comment')}\nProbe comment.` },
      pick: (j) => ({
        id: j.id,
        user: j.user.login,
        performed_via_github_app: j.performed_via_github_app?.slug ?? null,
      }),
    });
    await api('Q5 fork PR attribution', 'GET', `/repos/${FORK}/issues/${number}`, {
      pick: (j) => ({
        user: j.user.login,
        performed_via_github_app: j.performed_via_github_app?.slug ?? null,
      }),
    });
    await api('Q5 commit attribution', 'GET', `/repos/${FORK}/pulls/${number}/commits`, {
      pick: (j) =>
        j.map((c) => ({
          sha: c.sha,
          author: c.author?.login ?? null,
          committer: c.committer?.login ?? null,
          verified: c.commit.verification?.verified,
          reason: c.commit.verification?.reason,
        })),
    });
    for (const state of ['closed', 'open']) {
      await api(`fork PR: set state ${state}`, 'PATCH', `/repos/${FORK}/pulls/${number}`, {
        auth: user,
        body: { state },
        pick: (j) => ({ state: j.state }),
      });
    }
    await api(
      'scenario 11 (fork PR): still exactly one PR after close/reopen',
      'GET',
      `/repos/${FORK}/pulls?${q}`,
      {
        pick: (j) => j.map((p) => ({ number: p.number, state: p.state })),
      }
    );
  },

  'install-token': async () => {
    const { branch, upstreamId } = loadState();
    const inst = await forkInstallationToken(
      'Q4b mint installation token narrowed to fork, contents:write'
    );
    await api(
      'Q4b repositories visible to installation token',
      'GET',
      '/installation/repositories',
      {
        auth: inst,
        pick: (j) => j.repositories.map((r) => r.full_name),
      }
    );
    // A second, fast-forward commit pushed with the installation token.
    git(null, ['checkout', '-q', branch]);
    const test = join(WORK_DIR, 'test', 'range.test.js');
    writeFileSync(
      test,
      `${readFileSync(test, 'utf8')}\ntest('single negative value', () => {\n  assert.deepEqual(range(-1, -1), [-1]);\n});\n`
    );
    await commit('test: cover a single negative value');
    const sha = git(null, ['rev-parse', 'HEAD']).out.trim();
    git(
      'Q4b push to fork with installation token',
      ['push', remote(FORK), `${sha}:refs/heads/${branch}`],
      { token: inst }
    );
    record({
      step: 'Q4b fork branch SHA',
      status: 'ok',
      result: { expected: sha, remote: remoteSha(branch) },
    });
    saveState({ candidateSha: sha });
    git(
      'Q4 negative: installation token push to upstream',
      ['push', remote(UPSTREAM), `${sha}:refs/heads/${branch}`],
      {
        token: inst,
        allowFail: true,
      }
    );
    await api(
      'Q4 negative: installation token comments on upstream',
      'POST',
      `/repos/${UPSTREAM}/issues/${ISSUE}/comments`,
      {
        auth: inst,
        body: { body: 'should be refused' },
      }
    );
    await api(
      'Q4 negative: installation token opens upstream PR',
      'POST',
      `/repos/${UPSTREAM}/pulls`,
      {
        auth: inst,
        body: { title: 'should be refused', head: `${CONTRIBUTOR}:${branch}`, base: 'main' },
      }
    );
    await api(
      'Q4 negative: installation token for upstream repo id',
      'POST',
      `/app/installations/${await installationId()}/access_tokens`,
      {
        auth: appJwt(),
        body: { repository_ids: [upstreamId], permissions: { contents: 'write' } },
      }
    );
    await api('revoke installation token', 'DELETE', '/installation/token', { auth: inst });
    await api(
      'reuse revoked installation token (expect 401)',
      'GET',
      '/installation/repositories',
      { auth: inst }
    );
  },

  // Scenario 18: the fork branch moves out of band; a compare-and-swap push
  // against the recorded SHA must be refused.
  lease: async () => {
    const { branch, candidateSha } = loadState();
    const user = await userToken('lease');
    const before = remoteSha(branch);
    record({
      step: 'scenario 18: recorded expected SHA',
      status: 'ok',
      result: { expected: candidateSha, remote: before },
    });
    await api(
      'scenario 18: out-of-band commit on fork branch',
      'PUT',
      `/repos/${FORK}/contents/OUT_OF_BAND.md`,
      {
        auth: user,
        body: {
          message: 'out-of-band change (probe)',
          content: Buffer.from('moved by someone else\n').toString('base64'),
          branch,
        },
        pick: (j) => ({ commit: j.commit.sha }),
      }
    );
    const moved = await api(
      'scenario 18: broker preflight reads remote ref',
      'GET',
      `/repos/${FORK}/git/ref/heads/${branch}`,
      {
        pick: (j) => ({ sha: j.object.sha }),
      }
    );
    record({
      step: 'scenario 18: broker preflight decision',
      status:
        moved.json.object.sha === candidateSha ? 'proceed' : 'refuse (remote diverged → hand off)',
      result: { expected: candidateSha, observed: moved.json.object.sha },
    });
    // New candidate on top of the recorded SHA (as after re-verification).
    git(null, ['checkout', '-q', '--detach', candidateSha]);
    writeFileSync(join(WORK_DIR, 'CHANGES.md'), 'range() now includes end.\n');
    await commit('docs: note the range() change');
    const next = git(null, ['rev-parse', 'HEAD']).out.trim();
    git(
      'scenario 18: plain push over diverged remote',
      ['push', remote(FORK), `${next}:refs/heads/${branch}`],
      {
        token: user,
        allowFail: true,
      }
    );
    git(
      'scenario 18: --force-with-lease against recorded SHA',
      [
        'push',
        `--force-with-lease=refs/heads/${branch}:${candidateSha}`,
        remote(FORK),
        `${next}:refs/heads/${branch}`,
      ],
      { token: user, allowFail: true }
    );
    record({
      step: 'scenario 18: remote after refused pushes',
      status: 'ok',
      result: { remote: remoteSha(branch) },
    });
    // Explicit CAS restore of the verified candidate (PRD: authorized rewrite, never blind force).
    git(
      'scenario 18: explicit CAS restore of verified SHA',
      [
        'push',
        `--force-with-lease=refs/heads/${branch}:${moved.json.object.sha}`,
        remote(FORK),
        `${candidateSha}:refs/heads/${branch}`,
      ],
      { token: user, allowFail: true }
    );
    record({
      step: 'scenario 18: remote after restore',
      status: 'ok',
      result: { remote: remoteSha(branch), expected: candidateSha },
    });
  },

  scoped: async () => {
    const { forkPrNumber, forkId, upstreamId, candidateSha, branch } = loadState();
    const user = await userToken('scoped');
    const cid = secret('client-id');
    const pickScoped = (j) => ({
      token: `${j.token?.slice(0, 4)}…`,
      expires_at: j.expires_at,
      permissions: j.installation?.permissions ?? j.permissions,
      repository_selection: j.installation?.repository_selection,
      repositories: j.installation?.repositories?.map?.((r) => r.full_name),
      keys: Object.keys(j).sort(),
    });
    const scope = async (step, body) => {
      const r = await api(step, 'POST', `/applications/${cid}/token/scoped`, {
        auth: basicClient(),
        body: { access_token: user.token, ...body },
        pick: pickScoped,
      });
      return r.ok ? bearer(r.json.token, `ghu(scoped: ${step.replace(/^Q2 /, '')})`) : null;
    };
    const forkContents = await scope('Q2 scoped to fork, contents:write', {
      target: CONTRIBUTOR,
      repository_ids: [forkId],
      permissions: { contents: 'write' },
    });
    if (forkContents) {
      await api('Q2 scoped(fork) identity', 'GET', '/user', {
        auth: forkContents,
        pick: (j) => ({ login: j.login }),
      });
      await api('Q2 scoped(fork) create fork ref', 'POST', `/repos/${FORK}/git/refs`, {
        auth: forkContents,
        body: { ref: 'refs/heads/ztfc-probe/scoped', sha: candidateSha },
        pick: (j) => ({ ref: j.ref, sha: j.object.sha }),
      });
      await api(
        'Q2 scoped(fork) delete fork ref',
        'DELETE',
        `/repos/${FORK}/git/refs/heads/ztfc-probe/scoped`,
        {
          auth: forkContents,
        }
      );
      await api(
        'Q2 scoped(fork, contents) comment on fork PR (permission outside scope)',
        'POST',
        `/repos/${FORK}/issues/${forkPrNumber}/comments`,
        {
          auth: forkContents,
          body: { body: 'scoped-token probe (expected to be refused)' },
          pick: (j) => ({ id: j.id }),
        }
      );
      await api(
        'Q2 scoped(fork) comment on upstream',
        'POST',
        `/repos/${UPSTREAM}/issues/${ISSUE}/comments`,
        {
          auth: forkContents,
          body: { body: 'scoped-token probe (expected to be refused)' },
          pick: (j) => ({ id: j.id }),
        }
      );
    }
    const forkPr = await scope('Q2 scoped to fork, pull_requests+issues:write', {
      target: CONTRIBUTOR,
      repository_ids: [forkId],
      permissions: { pull_requests: 'write', issues: 'write' },
    });
    if (forkPr) {
      await api(
        'Q2 scoped(fork, pr) update fork PR',
        'PATCH',
        `/repos/${FORK}/pulls/${forkPrNumber}`,
        {
          auth: forkPr,
          body: { title: 'probe: range() fix (fork-internal, scoped update)' },
          pick: (j) => ({ title: j.title }),
        }
      );
      await api(
        'Q2 scoped(fork, pr) comment on upstream',
        'POST',
        `/repos/${UPSTREAM}/issues/${ISSUE}/comments`,
        {
          auth: forkPr,
          body: { body: 'scoped-token probe (expected to be refused)' },
          pick: (j) => ({ id: j.id }),
        }
      );
      await api('Q2 scoped(fork, pr) open upstream PR', 'POST', `/repos/${UPSTREAM}/pulls`, {
        auth: forkPr,
        body: {
          title: 'scoped-token probe (expected to be refused)',
          head: `${CONTRIBUTOR}:${branch}`,
          base: 'main',
        },
        pick: (j) => ({ number: j.number }),
      });
    }
    await scope('Q2 scoped aimed at upstream owner', {
      target: UP_OWNER,
      permissions: { issues: 'write' },
    });
    await scope('Q2 scoped aimed at upstream repo id under contributor target', {
      target: CONTRIBUTOR,
      repository_ids: [upstreamId],
      permissions: { issues: 'write' },
    });
    await api('Q2 parent ghu still valid after scoping', 'GET', '/user', {
      auth: user,
      pick: (j) => ({ login: j.login }),
    });
    for (const t of [forkContents, forkPr].filter(Boolean)) {
      await revokeToken(`Q3 revoke ${t.label}`, t.token);
      await api(`Q3 reuse revoked ${t.label} (expect 401)`, 'GET', '/user', { auth: t });
    }
    await api('Q3 parent ghu after revoking scoped children', 'GET', '/user', {
      auth: user,
      pick: (j) => ({ login: j.login }),
    });
  },

  cleanup: async () => {
    const { runId, branch } = loadState();
    const user = await userToken('cleanup');
    const q = new URLSearchParams({ head: `${CONTRIBUTOR}:${branch}`, state: 'open' });
    for (const repo of [UPSTREAM, FORK]) {
      const open = await api(
        `cleanup: find open probe PRs in ${repo}`,
        'GET',
        `/repos/${repo}/pulls?${q}`,
        {
          pick: (j) => j.map((p) => p.number),
        }
      );
      for (const n of (open.json ?? []).map((p) => p.number)) {
        await api(`cleanup: close ${repo}#${n}`, 'PATCH', `/repos/${repo}/pulls/${n}`, {
          auth: user,
          body: { state: 'closed' },
          pick: (j) => ({ state: j.state }),
        });
      }
    }
    await api(
      'cleanup: final probe comment',
      'POST',
      `/repos/${UPSTREAM}/issues/${ISSUE}/comments`,
      {
        auth: user,
        body: {
          body: `${marker(runId, 'final')}\nThis was a credential feasibility probe run for imboard-ai/ai-dossier#1011. The probe PR has been closed and every token it minted has been revoked. The bug remains open on purpose: it is the fixture.`,
        },
        pick: (j) => ({
          id: j.id,
          user: j.user.login,
          performed_via_github_app: j.performed_via_github_app?.slug ?? null,
        }),
      }
    );
  },

  // Q3, last because a refresh-token reuse test may kill the chain.
  // Order matters: scoped children outlive their parent (observed), so the
  // phase ends with a grant deletion made with a still-live child token.
  revocation: async () => {
    const cid = secret('client-id');
    const { forkId } = loadState();
    const child = async (step, access) => {
      const r = await api(step, 'POST', `/applications/${cid}/token/scoped`, {
        auth: basicClient(),
        body: {
          access_token: access,
          target: CONTRIBUTOR,
          repository_ids: [forkId],
          permissions: { contents: 'read' },
        },
        pick: (j) => ({ token: `${j.token.slice(0, 4)}…`, expires_at: j.expires_at }),
      });
      return r.ok ? bearer(r.json.token, `ghu(${step.replace(/^Q3 /, '')})`) : null;
    };
    const whoami = (step, auth) =>
      api(step, 'GET', '/user', { auth, pick: (j) => ({ login: j.login }) });
    const t0 = await refresh('Q3 rotate (t0)');
    const c0 = await child('Q3 scoped child of t0', t0.access);
    const t1 = await refresh('Q3 rotate again (t1)', t0.refresh);
    await whoami(
      'Q3 old access token after refresh (expect 401)',
      bearer(t0.access, 'ghu(t0, rotated away)')
    );
    await whoami('Q3 scoped child of t0 after parent rotated', c0);
    await oauthToken('Q3 reuse old refresh token (expect refusal)', {
      grant_type: 'refresh_token',
      refresh_token: t0.refresh,
    });
    await whoami('Q3 current access token after old-refresh reuse', bearer(t1.access, 'ghu(t1)'));
    const c1 = await child('Q3 scoped child of t1', t1.access);
    await revokeToken('Q3 DELETE /applications/{client_id}/token on t1', t1.access);
    await whoami(
      'Q3 revoked access token reuse (expect 401)',
      bearer(t1.access, 'ghu(t1, revoked)')
    );
    await whoami('Q3 scoped child of t1 after parent revoked', c1);
    await oauthToken('Q3 refresh token after its access token was revoked', {
      grant_type: 'refresh_token',
      refresh_token: t1.refresh,
    });
    rmSync(REFRESH_FILE, { force: true });
    await revokeToken('Q3 DELETE /applications/{client_id}/token on scoped child of t0', c0.token);
    await whoami('Q3 revoked scoped child reuse (expect 401)', c0);
    const c1b = await child('Q3 scoped grandchild (scoped from a scoped token)', c1.token);
    await api(
      'Q3 DELETE /applications/{client_id}/grant using a live child',
      'DELETE',
      `/applications/${cid}/grant`,
      {
        auth: basicClient(),
        body: { access_token: c1.token },
      }
    );
    await whoami('Q3 child after grant deletion (expect 401)', c1);
    if (c1b) await whoami('Q3 grandchild after grant deletion (expect 401)', c1b);
    record({ step: 'local refresh token deleted', status: 'ok' });
  },
};

const phase = process.argv[2];
if (!phases[phase]) {
  console.error(`usage: probe.mjs <${Object.keys(phases).join('|')}>`);
  process.exit(2);
}
phases[phase]().catch((err) => {
  console.error(redact(err.stack ?? err));
  process.exit(1);
});
