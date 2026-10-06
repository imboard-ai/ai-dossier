/** Typed authority for model output (PRD §5.4, scenario 5). Model output is
 * untrusted data: it can only PROPOSE one of a closed set of actions, and every
 * binding — repository, fork, issue, identity, network, budget — comes from the
 * controller, never from the proposal. There is no action that reads secrets. */
import type { IntentInput } from './intents';
import { SHIPPING_KINDS, type ShippingKind } from './receipt/schema';
import { assertNoSecrets } from './redaction';
import type { ContainerProfile } from './vm/adapter';
import { assertWorkspacePath, MAX_FILE_BYTES, validateRequest } from './vm/broker';

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
  | {
      readonly kind: 'request_publication';
      readonly intent: IntentInput;
      readonly title: string;
      readonly body: string;
    }
  | { readonly kind: 'hand_off'; readonly reason: string };

export class AuthorityError extends Error {
  constructor(readonly code: string) {
    super(`Model action rejected: ${code}`);
    this.name = 'AuthorityError';
  }
}

const FIELDS: Readonly<Record<AdmittedAction['kind'], readonly string[]>> = Object.freeze({
  worker_exec: ['kind', 'profile', 'argv'],
  worker_write_file: ['kind', 'path', 'content'],
  request_publication: ['kind', 'operation', 'title', 'body'],
  hand_off: ['kind', 'reason'],
});

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new AuthorityError('invalid_field');
  try {
    assertNoSecrets(value);
  } catch {
    throw new AuthorityError('credential_material');
  }
  return value;
}

export function admitModelAction(proposal: unknown, binding: AuthorityBinding): AdmittedAction {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal))
    throw new AuthorityError('not_an_action');
  const raw = proposal as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind))
    throw new AuthorityError('unknown_action');
  const allowed = FIELDS[kind as AdmittedAction['kind']];
  // Any extra key (target, repo, base, head, token, network, budget...) is an override attempt.
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) throw new AuthorityError('unexpected_field');
  switch (kind) {
    case 'worker_exec': {
      try {
        const request = validateRequest({
          op: 'exec',
          profile: raw.profile as ContainerProfile,
          argv: raw.argv as string[],
          cwd: '',
          timeoutMs: 60_000,
        });
        if (request.op !== 'exec') throw new AuthorityError('invalid_field');
        return { kind, profile: request.profile, argv: request.argv };
      } catch (error) {
        throw error instanceof AuthorityError
          ? error
          : new AuthorityError(
              error instanceof Error && error.name === 'SecretRedactionError'
                ? 'credential_material'
                : 'invalid_field'
            );
      }
    }
    case 'worker_write_file': {
      let path: string;
      try {
        path = assertWorkspacePath(raw.path);
      } catch {
        throw new AuthorityError('invalid_field');
      }
      const content = raw.content;
      if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES)
        throw new AuthorityError('invalid_field');
      return { kind, path, content };
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
        title: text(raw.title, 256),
        body: text(raw.body, 65536),
      };
    }
    default:
      return { kind: 'hand_off', reason: text(raw.reason, 2000) };
  }
}
