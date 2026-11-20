/** The contributor's answer to an `ecosystem_ambiguous` hand-off (#1276): which side of a
 * mixed npm + Python root this run installs and tests. It is bound to the canonical
 * source manifest digest it answered, so it never carries over to different source. */
import { isRecord } from '../state';
import { type Ecosystem, isEcosystem } from './detect';

export interface OperatorEcosystem {
  readonly ecosystem: Ecosystem;
  readonly operator: string;
  readonly sourceDigest: string;
}

export class OperatorEcosystemError extends Error {
  constructor() {
    super('invalid_ecosystem');
    this.name = 'OperatorEcosystemError';
  }
}

/** Returns the normalized record (fixed key order) or throws. */
export function validateOperatorEcosystem(value: unknown): OperatorEcosystem {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'ecosystem,operator,sourceDigest' ||
    !isEcosystem(value.ecosystem) ||
    typeof value.operator !== 'string' ||
    !/^[A-Za-z0-9-]{1,39}$/u.test(value.operator) ||
    typeof value.sourceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sourceDigest)
  )
    throw new OperatorEcosystemError();
  return Object.freeze({
    ecosystem: value.ecosystem,
    operator: value.operator,
    sourceDigest: value.sourceDigest,
  });
}
