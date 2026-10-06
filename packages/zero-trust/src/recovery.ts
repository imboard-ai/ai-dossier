/** Recovery observations carry no authorization and must still validate on replay. */
export interface LockOwner {
  pid: number;
  startToken: string;
  createdAt: string;
  id: string;
}
export interface TailRecovery {
  v: 1;
  type: 'journal_tail_recovered';
  quarantine: string;
  offset: number;
  bytes: number;
  sha256: string;
  prefixSha256: string;
}
export interface LockRecovery {
  v: 1;
  type: 'lock_reclaimed';
  lock: string;
  owner: LockOwner;
  at: string;
  pendingReservations: string[];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected;
}
function timestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function uuid(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
}
export function isLockOwner(value: unknown): value is LockOwner {
  return (
    record(value) &&
    keys(value, 'createdAt,id,pid,startToken') &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.startToken === 'string' &&
    /^[a-f0-9-]{36}:\d+$/.test(value.startToken) &&
    timestamp(value.createdAt) &&
    uuid(value.id)
  );
}
export function isTailRecovery(value: unknown): value is TailRecovery {
  return (
    record(value) &&
    keys(value, 'bytes,offset,prefixSha256,quarantine,sha256,type,v') &&
    value.v === 1 &&
    value.type === 'journal_tail_recovered' &&
    Number.isSafeInteger(value.offset) &&
    (value.offset as number) >= 0 &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.prefixSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.prefixSha256) &&
    value.quarantine === `events.jsonl.quarantine-${value.offset}-${value.sha256}`
  );
}
export function isLockRecovery(value: unknown): value is LockRecovery {
  return (
    record(value) &&
    keys(value, 'at,lock,owner,pendingReservations,type,v') &&
    value.v === 1 &&
    value.type === 'lock_reclaimed' &&
    typeof value.lock === 'string' &&
    /^[A-Za-z0-9._-]{1,255}$/.test(value.lock) &&
    isLockOwner(value.owner) &&
    timestamp(value.at) &&
    Array.isArray(value.pendingReservations) &&
    value.pendingReservations.every(uuid) &&
    new Set(value.pendingReservations).size === value.pendingReservations.length
  );
}
export function isRecoveryEvent(value: unknown): value is TailRecovery | LockRecovery {
  return isTailRecovery(value) || isLockRecovery(value);
}
