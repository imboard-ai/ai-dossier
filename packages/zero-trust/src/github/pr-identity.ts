import { sha256 } from '../canonical/export';
import { isGitHubLogin } from '../github-login';
import { canonicalJson } from '../receipt/schema';
import { isRecord } from '../state';

/** Closed, credential-free identity; names are canonical lower case, refs are exact. */
export interface PrIdentity {
  upstreamId: number;
  upstreamOwner: string;
  upstreamName: string;
  baseRef: string;
  forkId: number;
  forkOwner: string;
  forkName: string;
  headRef: string;
  contributor: string;
  number: number;
  htmlUrl: string;
  apiUrl: string;
}
type Fields = Partial<PrIdentity>;
const name = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(value)) throw new Error('identity');
  return value.toLowerCase();
};
const login = (value: unknown): string => {
  if (typeof value !== 'string' || !isGitHubLogin(value)) throw new Error('identity');
  return value.toLowerCase();
};
const ref = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('identity');
  return value;
};
const id = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('identity');
  return value as number;
};
function repository(value: unknown, fork: boolean, api?: boolean): Fields {
  if (typeof value !== 'string') throw new Error('identity');
  const match =
    api === undefined
      ? /^([^/]+)\/([^/]+)$/u.exec(value)
      : (api
          ? /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/u
          : /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/u
        ).exec(value);
  if (!match) throw new Error('identity');
  return fork
    ? { forkOwner: login(match[1]), forkName: name(match[2]) }
    : { upstreamOwner: login(match[1]), upstreamName: name(match[2]) };
}
function pull(value: unknown, api: boolean): Fields {
  if (typeof value !== 'string') throw new Error('identity');
  const match = (
    api
      ? /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9][0-9]*)$/u
      : /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/u
  ).exec(value);
  if (!match) throw new Error('identity');
  return {
    upstreamOwner: login(match[1]),
    upstreamName: name(match[2]),
    number: id(Number(match[3])),
  };
}
function label(value: unknown, fork: boolean): Fields {
  if (typeof value !== 'string') throw new Error('identity');
  const colon = value.indexOf(':');
  if (colon < 1) throw new Error('identity');
  return fork
    ? { forkOwner: login(value.slice(0, colon)), headRef: ref(value.slice(colon + 1)) }
    : { upstreamOwner: login(value.slice(0, colon)), baseRef: ref(value.slice(colon + 1)) };
}
/** Single enumerated decoder: every present path contributes constraints to one tuple.
 * Null/malformed parents are contradictions, not absent optional children. */
export const PR_IDENTITY_PATHS = Object.freeze([
  ['url', (v: unknown) => pull(v, true)],
  ['html_url', (v: unknown) => pull(v, false)],
  ['number', (v: unknown) => ({ number: id(v) })],
  ['user.login', (v: unknown) => ({ contributor: login(v) })],
  ['base.ref', (v: unknown) => ({ baseRef: ref(v) })],
  ['base.repo.id', (v: unknown) => ({ upstreamId: id(v) })],
  ['base.repo.name', (v: unknown) => ({ upstreamName: name(v) })],
  ['base.repo.full_name', (v: unknown) => repository(v, false)],
  ['base.repo.owner.login', (v: unknown) => ({ upstreamOwner: login(v) })],
  ['base.repo.url', (v: unknown) => repository(v, false, true)],
  ['base.repo.html_url', (v: unknown) => repository(v, false, false)],
  ['head.ref', (v: unknown) => ({ headRef: ref(v) })],
  ['head.label', (v: unknown) => label(v, true)],
  ['head.user.login', (v: unknown) => ({ forkOwner: login(v) })],
  ['head.repo.id', (v: unknown) => ({ forkId: id(v) })],
  ['head.repo.name', (v: unknown) => ({ forkName: name(v) })],
  ['head.repo.full_name', (v: unknown) => repository(v, true)],
  ['head.repo.owner.login', (v: unknown) => ({ forkOwner: login(v) })],
  ['head.repo.url', (v: unknown) => repository(v, true, true)],
  ['head.repo.html_url', (v: unknown) => repository(v, true, false)],
  ['base.user.login', (v: unknown) => ({ upstreamOwner: login(v) })],
  ['base.label', (v: unknown) => label(v, false)],
] as const);
export function extractPrIdentity(input: unknown): PrIdentity {
  input = JSON.parse(canonicalJson(input, 1024 * 1024));
  const fields: Fields = {};
  for (const [path, decode] of PR_IDENTITY_PATHS) {
    let value: unknown = input;
    let absent = false;
    for (const key of path.split('.')) {
      if (!isRecord(value)) throw new Error('identity');
      if (!Object.hasOwn(value, key)) {
        absent = true;
        break;
      }
      value = value[key];
    }
    if (absent) continue;
    for (const [key, observed] of Object.entries(decode(value))) {
      const field = key as keyof PrIdentity;
      if (fields[field] !== undefined && fields[field] !== observed) throw new Error('identity');
      Object.assign(fields, { [field]: observed });
    }
  }
  // Never complete missing observed identity from the expected binding.
  for (const field of [
    'upstreamId',
    'upstreamOwner',
    'upstreamName',
    'baseRef',
    'forkId',
    'forkOwner',
    'forkName',
    'headRef',
    'contributor',
    'number',
  ] as const)
    if (fields[field] === undefined) throw new Error('identity');
  const identity = fields as PrIdentity;
  identity.htmlUrl = `https://github.com/${identity.upstreamOwner}/${identity.upstreamName}/pull/${identity.number}`;
  identity.apiUrl = `https://api.github.com/repos/${identity.upstreamOwner}/${identity.upstreamName}/pulls/${identity.number}`;
  return Object.freeze(identity);
}
export function prIdentityDigest(identity: PrIdentity): string {
  return sha256(canonicalJson(identity));
}
export function samePrIdentity(a: PrIdentity, b: PrIdentity): boolean {
  return prIdentityDigest(a) === prIdentityDigest(b);
}
/** Validate closed canonical portable proof, independent of a detail response. */
export function validatePrIdentity(value: unknown): PrIdentity {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'apiUrl,baseRef,contributor,forkId,forkName,forkOwner,headRef,htmlUrl,number,upstreamId,upstreamName,upstreamOwner'
  )
    throw new Error('identity');
  const parsed = extractPrIdentity({
    url: value.apiUrl,
    html_url: value.htmlUrl,
    number: value.number,
    user: { login: value.contributor },
    base: {
      ref: value.baseRef,
      repo: {
        id: value.upstreamId,
        name: value.upstreamName,
        owner: { login: value.upstreamOwner },
      },
    },
    head: {
      ref: value.headRef,
      repo: { id: value.forkId, name: value.forkName, owner: { login: value.forkOwner } },
    },
  });
  if (canonicalJson(value) !== canonicalJson(parsed)) throw new Error('identity');
  return parsed;
}
