/** Stateful GitHub fake replaying the gate-3 probe's observed status codes
 * (docs/reports/evidence/ztfc-github-credentials-probe.jsonl). No network. */
import { randomBytes } from 'node:crypto';
import type { GitHubHttp, GitHubRequest, GitHubResponse } from '../app-auth';

export const CLIENT_ID = 'Iv23fixtureclient';
export const FORK_ID = 4242;
export const UPSTREAM_ID = 1717;
export const INSTALLATION_ID = 99;
export const OWNER = 'contributor';
const HOUR = 60 * 60 * 1000;

type Kind = 'installation' | 'user' | 'user_scoped';
interface FakeToken {
  kind: Kind;
  live: boolean;
  /** Unscoped user tokens only: refresh chain still usable. */
  refreshAlive?: boolean;
}
type Override = GitHubResponse | 'throw';

export class GitHubFake {
  readonly tokens = new Map<string, FakeToken>();
  readonly calls: { method: string; path: string; body?: unknown; token?: string }[] = [];
  private readonly overrides: { match: string; response: Override; times: number }[] = [];
  constructor(private readonly now: () => number) {}

  issue(kind: Kind): string {
    const value = `${kind === 'installation' ? 'ghs' : 'ghu'}_${randomBytes(18).toString('hex')}`;
    this.tokens.set(value, {
      kind,
      live: true,
      ...(kind === 'user' ? { refreshAlive: true } : {}),
    });
    return value;
  }
  /** Contributor authorization (web flow): a fresh unscoped user token in the grant. */
  authorizeUser(): string {
    return this.issue('user');
  }
  /** A refresh: the old access token dies (observed 401); scoped children survive. */
  refresh(old: string): string {
    const token = this.tokens.get(old);
    if (token) token.live = false;
    return this.issue('user');
  }
  live(value: string): boolean {
    return this.tokens.get(value)?.live === true;
  }
  /** `METHOD /path` prefix; the next `times` matching calls get `response`. */
  override(match: string, response: Override, times = 1): void {
    this.overrides.push({ match, response, times });
  }
  count(match: string): number {
    return this.calls.filter((c) => `${c.method} ${c.path}`.startsWith(match)).length;
  }

  readonly http: GitHubHttp = async (request) => {
    const body = request.body as Record<string, unknown> | undefined;
    const bearer = request.authorization.startsWith('Bearer ')
      ? request.authorization.slice(7)
      : undefined;
    this.calls.push({
      method: request.method,
      path: request.path,
      body,
      token: bearer ?? (body?.access_token as string | undefined),
    });
    const line = `${request.method} ${request.path}`;
    const override = this.overrides.find((o) => o.times > 0 && line.startsWith(o.match));
    if (override) {
      override.times--;
      if (override.response === 'throw') throw new Error('synthetic transport failure');
      return override.response;
    }
    return this.route(request, bearer, body);
  };

  private killGrant(): void {
    for (const token of this.tokens.values())
      if (token.kind !== 'installation') {
        token.live = false;
        token.refreshAlive = false;
      }
  }

  private route(
    request: GitHubRequest,
    bearer: string | undefined,
    body: Record<string, unknown> | undefined
  ): GitHubResponse {
    const basicOk = request.authorization.startsWith('Basic ');
    const subject = typeof body?.access_token === 'string' ? body.access_token : undefined;
    const held = subject ? this.tokens.get(subject) : undefined;
    const path = request.path;
    if (
      request.method === 'POST' &&
      path === `/app/installations/${INSTALLATION_ID}/access_tokens`
    ) {
      if (!bearer || bearer.split('.').length !== 3) return { status: 401, json: null };
      const ids = body?.repository_ids as number[];
      // Probe Q4: any repository outside the installation → 422.
      if (!Array.isArray(ids) || ids.some((id) => id !== FORK_ID))
        return { status: 422, json: { message: 'not accessible to the parent installation' } };
      return {
        status: 201,
        json: {
          token: this.issue('installation'),
          expires_at: new Date(this.now() + HOUR).toISOString(),
          permissions: { contents: 'write', metadata: 'read' },
          repository_selection: 'selected',
          repositories: [{ id: FORK_ID, full_name: `${OWNER}/fixture` }],
        },
      };
    }
    if (request.method === 'POST' && path === `/applications/${CLIENT_ID}/token/scoped`) {
      if (!basicOk || !held?.live) return { status: 404, json: null };
      // Probe Q3: narrowing is one level deep.
      if (held.kind === 'user_scoped')
        return {
          status: 401,
          json: { message: 'A scoped token cannot create another scoped token.' },
        };
      if (body?.target !== OWNER)
        return {
          status: 403,
          json: { message: 'Your app does not have access to the given target.' },
        };
      if ((body?.repository_ids as number[]).some((id) => id !== FORK_ID))
        return { status: 403, json: { message: 'not accessible to the parent installation' } };
      return {
        status: 200,
        json: {
          token: this.issue('user_scoped'),
          // Probe Q2: 8 h from SCOPING, independent of the parent.
          expires_at: new Date(this.now() + 8 * HOUR).toISOString(),
          installation: {
            permissions: { contents: 'write', metadata: 'read' },
            repository_selection: 'selected',
          },
        },
      };
    }
    if (request.method === 'DELETE' && path === '/installation/token') {
      const token = bearer ? this.tokens.get(bearer) : undefined;
      if (!token?.live) return { status: 401, json: { message: 'Bad credentials' } };
      token.live = false;
      return { status: 204, json: null };
    }
    if (request.method === 'DELETE' && path === `/applications/${CLIENT_ID}/token`) {
      if (!basicOk || !held?.live) return { status: 404, json: null };
      // Probe Q3: revoking a ghu kills its refresh chain; scoped children survive.
      held.live = false;
      held.refreshAlive = false;
      return { status: 204, json: null };
    }
    if (request.method === 'DELETE' && path === `/applications/${CLIENT_ID}/grant`) {
      // Probe Q3: only a LIVE token from the grant works; a revoked one gets 404.
      if (!basicOk || !held?.live || held.kind === 'installation')
        return { status: 404, json: null };
      this.killGrant();
      return { status: 204, json: null };
    }
    if (request.method === 'GET' && (path === '/user' || path === '/installation/repositories')) {
      const token = bearer ? this.tokens.get(bearer) : undefined;
      const fits =
        path === '/user' ? token?.kind !== 'installation' : token?.kind === 'installation';
      return token?.live && fits
        ? { status: 200, json: {} }
        : { status: 401, json: { message: 'Bad credentials' } };
    }
    return { status: 404, json: null };
  }
}
