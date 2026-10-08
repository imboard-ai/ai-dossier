/** Typed authority for model output (PRD §5.4, scenario 5). Model output is
 * untrusted data: it can only PROPOSE one of a closed set of actions, and every
 * binding — repository, fork, issue, identity, network, budget — comes from the
 * controller, never from the proposal. There is no action that reads secrets. */
import type { IntentInput } from './intents';
import { SHIPPING_KINDS, type ShippingKind } from './receipt/schema';
import { assertNoSecrets, SecretRedactionError } from './redaction';
import type { ContainerProfile } from './vm/adapter';
import { assertWorkspacePath, MAX_FILE_BYTES, validateExecArgv } from './vm/broker';

export interface AuthorityBinding {
  readonly contributionId: string;
  /** Controller-computed targets for each publication kind. */
  readonly publicationTargets: Readonly<Record<ShippingKind, string>>;
  readonly candidateSha: string | null;
}

export type AdmittedAction =
  | {
      readonly kind: 'worker_exec';
      readonly profile: ContainerProfile;
      readonly argv: readonly string[];
    }
  | { readonly kind: 'worker_write_file'; readonly path: string; readonly content: string }
  | { readonly kind: 'submit_plan'; readonly text: string }
  | ({ readonly kind: 'candidate_ready' } & CandidateMetadata)
  | {
      readonly kind: 'request_publication';
      readonly intent: IntentInput;
      readonly title: string;
      readonly body: string;
    }
  | { readonly kind: 'hand_off'; readonly reason: string };

export interface CandidateMetadata {
  readonly title: string;
  readonly cause: string;
  readonly scope: string;
  readonly limitations: readonly string[];
}

export class AuthorityError extends Error {
  constructor(readonly code: string) {
    super(`Model action rejected: ${code}`);
    this.name = 'AuthorityError';
  }
}

const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 65536;
const MAX_REASON_CHARS = 2000;
export const MAX_PLAN_BYTES = 8 * 1024;
export const MAX_CANDIDATE_TEXT_BYTES = 4 * 1024;

const FIELDS: Readonly<Record<AdmittedAction['kind'], readonly string[]>> = Object.freeze({
  worker_exec: ['kind', 'profile', 'argv'],
  worker_write_file: ['kind', 'path', 'content'],
  submit_plan: ['kind', 'text'],
  candidate_ready: ['kind', 'title', 'cause', 'scope', 'limitations'],
  request_publication: ['kind', 'operation', 'title', 'body'],
  hand_off: ['kind', 'reason'],
});

function isActionKind(value: unknown): value is AdmittedAction['kind'] {
  return typeof value === 'string' && Object.hasOwn(FIELDS, value);
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new AuthorityError('invalid_field');
  try {
    assertNoSecrets(value);
  } catch {
    throw new AuthorityError('credential_material');
  }
  return value;
}

function byteText(value: unknown, max: number): string {
  const result = text(value, max);
  if (Buffer.byteLength(result, 'utf8') > max) throw new AuthorityError('invalid_field');
  return result;
}

/** Shared controller write policy for authority admission and direct overlay consumers. */
export function admitWorkspaceWrite(
  file: unknown,
  value: unknown
): { path: string; content: string } {
  let path: string;
  try {
    path = assertWorkspacePath(file);
  } catch {
    throw new AuthorityError('invalid_field');
  }
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_FILE_BYTES)
    throw new AuthorityError('invalid_field');
  try {
    assertNoSecrets(path);
    assertNoSecrets(value);
  } catch {
    throw new AuthorityError('credential_material');
  }
  return { path, content: value };
}

export function admitModelAction(proposal: unknown, binding: AuthorityBinding): AdmittedAction {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal))
    throw new AuthorityError('not_an_action');
  const raw = proposal as Record<string, unknown>;
  const kind = raw.kind;
  if (!isActionKind(kind)) throw new AuthorityError('unknown_action');
  const allowed = FIELDS[kind];
  // Any extra key (target, repo, base, head, token, network, budget...) is an override attempt.
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) throw new AuthorityError('unexpected_field');
  switch (kind) {
    case 'worker_exec': {
      try {
        const { profile, argv } = validateExecArgv(raw.profile, raw.argv);
        return { kind, profile, argv };
      } catch (error) {
        throw new AuthorityError(
          error instanceof SecretRedactionError ? 'credential_material' : 'invalid_field'
        );
      }
    }
    case 'worker_write_file': {
      return { kind, ...admitWorkspaceWrite(raw.path, raw.content) };
    }
    case 'request_publication': {
      const operation = raw.operation;
      if (!SHIPPING_KINDS.includes(operation as ShippingKind))
        throw new AuthorityError('invalid_field');
      if (!binding.candidateSha) throw new AuthorityError('no_candidate');
      const target = binding.publicationTargets[operation as ShippingKind];
      return {
        kind,
        intent: {
          contributionId: binding.contributionId,
          target,
          operationKind: operation as ShippingKind,
          candidateSha: binding.candidateSha,
        },
        title: text(raw.title, MAX_TITLE_CHARS),
        body: text(raw.body, MAX_BODY_CHARS),
      };
    }
    case 'submit_plan': {
      return { kind, text: byteText(raw.text, MAX_PLAN_BYTES) };
    }
    case 'candidate_ready': {
      const limitations = raw.limitations;
      if (!Array.isArray(limitations) || limitations.length > 10)
        throw new AuthorityError('invalid_field');
      return {
        kind,
        title: text(raw.title, MAX_TITLE_CHARS),
        cause: byteText(raw.cause, MAX_CANDIDATE_TEXT_BYTES),
        scope: byteText(raw.scope, MAX_CANDIDATE_TEXT_BYTES),
        limitations: limitations.map((item) => text(item, 500)),
      };
    }
    case 'hand_off':
      return { kind, reason: text(raw.reason, MAX_REASON_CHARS) };
    default: {
      const unhandled: never = kind;
      throw new AuthorityError(`unknown_action:${String(unhandled)}`);
    }
  }
}
