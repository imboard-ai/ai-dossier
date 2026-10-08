import { GitHubFake } from '../../github/__tests__/github-fake';
import type { GitHubRead } from '../../github/reconcile';
import { classifyPolicy, type PolicyAssessment, policyDigest } from '../classify';
import { POLICY_PATHS, POLICY_TEMPLATE_DIRECTORY, type PolicyFile } from '../discover';
import { assessIssue } from '../eligibility';
import { createFreshnessProbe, type FreshnessDeps } from '../freshness';

export const FRESH_TARGET = { owner: 'up', repo: 'proj', issue: 8 };
export const FRESH_PREFIX = '/repos/up/proj';
export const FRESH_HEAD = 'a'.repeat(40);
export const FRESH_AT = '2026-10-06T09:00:00.000Z';
export const freshActor = (login: string) => ({ login, html_url: `https://github.com/${login}` });

export async function freshnessRig() {
  const fake = new GitHubFake(() => Date.parse(FRESH_AT));
  const issue = {
    number: 8,
    html_url: 'https://github.com/up/proj/issues/8',
    state: 'open',
    locked: false,
    user: freshActor('reporter'),
    author_association: 'CONTRIBUTOR',
    labels: [{ name: 'bug' }],
    assignees: [] as ReturnType<typeof freshActor>[],
    created_at: '2026-10-05T00:00:00Z',
  };
  const repo = {
    id: 1717,
    full_name: 'up/proj',
    default_branch: 'main',
    private: false,
    archived: false,
    disabled: false,
  };
  const timeline: unknown[] = [];
  const comments: unknown[] = [];
  const set = (path: string, body: unknown, status = 200) =>
    fake.publicResponses.set(path, { status, body });
  set(FRESH_PREFIX, repo);
  set(`${FRESH_PREFIX}/issues/8`, issue);
  set(`${FRESH_PREFIX}/issues/8/timeline?per_page=100&page=1`, timeline);
  set(`${FRESH_PREFIX}/issues/8/comments?per_page=100&page=1`, comments);
  set(`${FRESH_PREFIX}/git/ref/heads/main`, {
    ref: 'refs/heads/main',
    object: { type: 'commit', sha: FRESH_HEAD },
  });
  const contentPath = (path: string) => `${FRESH_PREFIX}/contents/${path}?ref=${FRESH_HEAD}`;
  for (const path of [...POLICY_PATHS, `${POLICY_TEMPLATE_DIRECTORY}/`])
    set(contentPath(path), null, 404);
  const files: PolicyFile[] = [];
  const policy: PolicyAssessment = {
    ...classifyPolicy(files),
    assignment: 'not_required',
    directPr: 'welcomed',
  };
  const eligibility = await assessIssue(fake.read, FRESH_TARGET, 'contributor');
  if (eligibility.kind === 'unknown') throw new Error('Broken fixture');
  const deps: FreshnessDeps = {
    read: fake.read,
    upstream: { ...FRESH_TARGET },
    contributor: 'contributor',
    gated: {
      policy,
      policyDigest: policyDigest(policy, files),
      eligibilityDigest: eligibility.evidenceDigest,
    },
  };
  fake.calls.length = 0;
  const probe = (patch: Partial<FreshnessDeps> = {}) => createFreshnessProbe({ ...deps, ...patch });
  const invitation = {
    actor: 'maintainer',
    association: 'MEMBER',
    url: 'https://github.com/up/proj/issues/8#issuecomment-1',
    policyDigest: deps.gated.policyDigest,
    at: FRESH_AT,
  };
  const revoke = () =>
    comments.push({
      id: 2,
      user: freshActor('maintainer'),
      author_association: 'MEMBER',
      html_url: 'https://github.com/up/proj/issues/8#issuecomment-2',
      created_at: '2026-10-06T10:00:00Z',
      updated_at: '2026-10-06T10:00:00Z',
      body: 'Do not proceed.',
    });
  const addPull = (number: number, author: string, fullName = 'up/proj') => {
    timeline.push({
      event: 'cross-referenced',
      created_at: '2026-10-06T10:00:00Z',
      actor: freshActor(author),
      source: {
        issue: {
          number,
          html_url: `https://github.com/${fullName}/pull/${number}`,
          pull_request: { url: `https://api.github.com/repos/${fullName}/pulls/${number}` },
        },
      },
    });
    set(`/repos/${fullName}/pulls/${number}`, {
      number,
      html_url: `https://github.com/${fullName}/pull/${number}`,
      state: 'open',
      merged_at: null,
      user: freshActor(author),
    });
  };
  const setFile = (content: string) => {
    set(contentPath('CONTRIBUTING.md'), {
      type: 'file',
      path: 'CONTRIBUTING.md',
      sha: 'b'.repeat(40),
      size: Buffer.byteLength(content),
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
    });
  };
  const read: GitHubRead = fake.read;
  return {
    fake,
    issue,
    repo,
    timeline,
    comments,
    deps,
    policy,
    probe,
    set,
    contentPath,
    invitation,
    revoke,
    addPull,
    setFile,
    read,
  };
}
