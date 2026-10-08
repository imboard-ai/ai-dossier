import {
  type AuthorityBinding,
  AuthorityError,
  admitModelAction,
  type CandidateMetadata,
} from '../authority';
import type { BudgetLedger } from '../budget';
import type { BudgetRate } from '../budget-types';
import { CanonicalError, type SourceManifest, sha256 } from '../canonical/export';
import { type ModelAdapter, ModelError, type ModelMessage } from '../model/adapter';
import { BudgetExhaustedError, meteredComplete } from '../model/metered';
import { assertNoSecrets, assertSecretFree, REDACTED, redactedExcerpt } from '../redaction';
import { BrokerError, type VmAdapter, type VmHandle } from '../vm/adapter';
import { abortProvisionedVm, assertProvisionedVm, leaseProvisionedVm } from './evidence-runner';
import type { OutputCollector } from './output-collector';
import { AGENT_SYSTEM, type AgentPhase, agentTools, untrustedFrame } from './prompts';
import { WorkspaceOverlay } from './workspace-overlay';

export const DEFAULT_PLANNING_TURNS = 15;
export const DEFAULT_IMPLEMENTATION_TURNS = 60;
export const MAX_WORKER_REPLY_BYTES = 16 * 1024;
export const DEFAULT_LOOP_CLEANUP_TIMEOUT_MS = 5000;
export const TERMINAL_TRANSCRIPT_TIMEOUT_MS = 1000;
const MODEL_TIMEOUT_MS = 60_000;
const MODEL_OUTPUT_TOKENS = 16384;

/** Shared active execution accounting across phases, fresh VMs and repairs. Seed
 * elapsedMs from persisted controller state on resume; time between loops is idle. */
export class ActiveTimeBudget {
  private elapsed: number;
  private held = false;
  constructor(elapsedMs = 0) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError('Invalid active time');
    this.elapsed = elapsedMs;
  }
  get elapsedMs(): number {
    return this.elapsed;
  }
  enter(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  leave(elapsedMs: number): void {
    this.elapsed += elapsedMs;
    this.held = false;
  }
}
const ACTIVE_TIME = new WeakMap<BudgetLedger, Map<string, ActiveTimeBudget>>();
function activeTime(ctx: AgentLoopContext): ActiveTimeBudget {
  if (ctx.activeTime) return ctx.activeTime;
  let sessions = ACTIVE_TIME.get(ctx.ledger);
  if (!sessions) {
    sessions = new Map();
    ACTIVE_TIME.set(ctx.ledger, sessions);
  }
  let budget = sessions.get(ctx.sessionId);
  if (!budget) {
    budget = new ActiveTimeBudget();
    sessions.set(ctx.sessionId, budget);
  }
  return budget;
}
class ActiveTimeExpired extends Error {}
class WorkerDeadline extends Error {
  constructor(readonly active: boolean) {
    super('Worker deadline');
  }
}

async function bounded<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  error: Error
): Promise<T> {
  if (timeoutMs <= 0) throw error;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(error), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AgentLoopContext {
  readonly adapter: VmAdapter;
  /** Exact live handle returned by provisionWorkspace, never a provisioning VM. */
  readonly vm: VmHandle;
  readonly model: ModelAdapter;
  readonly ledger: BudgetLedger;
  readonly sessionId: string;
  readonly rates: BudgetRate[];
  readonly limits: { readonly commandTimeoutMs: number; readonly activeMinutes: number };
  readonly binding: AuthorityBinding;
  readonly issue: { readonly title: string; readonly body: string };
  readonly baseManifest: SourceManifest;
  readonly collector: OutputCollector;
  readonly now: () => Date;
  /** Controller-owned transcript sink. Receives detached JSON, or literal [redacted].
   * Failure stops the loop before any further call or worker operation. */
  readonly persist: (entry: string) => void | Promise<void>;
  /** Trusted override; never supplied by a proposal. */
  readonly maxTurns?: number;
  /** Optional explicit run-owned account, retained and persisted by the caller.
   * Default is shared by ledger identity/session in this process. */
  readonly activeTime?: ActiveTimeBudget;
  /** Separate bounded cleanup allowance after a worker deadline. */
  readonly cleanupTimeoutMs?: number;
}

export type AgentStop =
  | { readonly kind: 'hand_off'; readonly reason: string }
  | { readonly kind: 'budget_exhausted'; readonly reason: 'budget' | 'active_time' }
  | { readonly kind: 'turns_exhausted' };
export interface AgentPlan {
  readonly kind: 'plan';
  readonly text: string;
  readonly digest: string;
}
export type PlanningResult = AgentPlan | AgentStop;
export type ImplementationResult =
  | {
      readonly kind: 'candidate';
      readonly overlay: WorkspaceOverlay;
      readonly meta: CandidateMetadata;
    }
  | AgentStop;
export interface ImplementationInput {
  readonly plan: AgentPlan;
  /** Untrusted failure summary. Caller must enforce assertRepairAllowed first and
   * supply the exact failed candidate as baseManifest in the newly provisioned VM. */
  readonly repairOf?: string;
}

function safeRecord(data: unknown): string {
  try {
    assertSecretFree(data);
    const entry = JSON.stringify(data);
    assertNoSecrets(entry);
    return entry;
  } catch {
    return REDACTED;
  }
}

/** A UTF-8 tail bounded in bytes, starting only at a character boundary. */
function outputTail(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let start = Math.max(0, bytes.length - MAX_WORKER_REPLY_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

interface LoopTracking {
  turn: number;
  stage: string;
  code?: string;
  finish?: () => void;
}

async function loop(
  ctx: AgentLoopContext,
  phase: AgentPhase,
  input: ImplementationInput | undefined,
  tracking: LoopTracking
): Promise<PlanningResult | ImplementationResult> {
  const maxTurns =
    ctx.maxTurns ?? (phase === 'planning' ? DEFAULT_PLANNING_TURNS : DEFAULT_IMPLEMENTATION_TURNS);
  let started: number;
  try {
    started = ctx.now().getTime();
  } catch {
    return { kind: 'hand_off', reason: 'invalid_context' };
  }
  const ceiling = ctx.limits.activeMinutes * 60_000;
  if (
    !Number.isSafeInteger(maxTurns) ||
    maxTurns < 1 ||
    !Number.isFinite(started) ||
    !Number.isFinite(ceiling) ||
    ceiling <= 0 ||
    ceiling > 2_147_483_647 ||
    !Number.isSafeInteger(ctx.limits.commandTimeoutMs) ||
    ctx.limits.commandTimeoutMs < 1000 ||
    ctx.limits.commandTimeoutMs > 6 * 3600 * 1000 ||
    !Number.isSafeInteger(ctx.cleanupTimeoutMs ?? DEFAULT_LOOP_CLEANUP_TIMEOUT_MS) ||
    (ctx.cleanupTimeoutMs ?? DEFAULT_LOOP_CLEANUP_TIMEOUT_MS) < 1 ||
    (ctx.cleanupTimeoutMs ?? DEFAULT_LOOP_CLEANUP_TIMEOUT_MS) > 2_147_483_647
  )
    return { kind: 'hand_off', reason: 'invalid_context' };
  let lastNow = started;
  const account = activeTime(ctx);
  if (!account.enter()) return { kind: 'hand_off', reason: 'session_busy' };
  let release: (() => void) | undefined;
  tracking.finish = () => {
    release?.();
    let end = lastNow;
    try {
      const at = ctx.now().getTime();
      if (Number.isFinite(at) && at >= end) end = at;
    } catch {
      /* Last validated clock still contributes active time. */
    }
    account.leave(Math.max(0, end - started));
  };
  let activeModelDeadline = false;
  const remaining = (): number => {
    const at = ctx.now().getTime();
    if (!Number.isFinite(at) || at < lastNow) throw new Error('invalid_clock');
    lastNow = at;
    return Math.floor(ceiling - account.elapsedMs - (at - started));
  };
  let persistenceFailed = false;
  const record = async (turn: number, event: string, data: unknown): Promise<void> => {
    try {
      await bounded(
        async () => ctx.persist(safeRecord({ phase, turn, event, data })),
        remaining(),
        new ActiveTimeExpired()
      );
    } catch (error) {
      if (error instanceof ActiveTimeExpired) throw error;
      if (remaining() <= 0) throw new ActiveTimeExpired();
      persistenceFailed = true;
      throw new Error('persistence_failed');
    }
  };
  try {
    release = leaseProvisionedVm(ctx.adapter, ctx.vm);
    const overlay = new WorkspaceOverlay(ctx.baseManifest);
    const messages: ModelMessage[] = [
      { role: 'user', content: untrustedFrame('issue', ctx.issue) },
    ];
    if (input) {
      const plan = admitModelAction({ kind: 'submit_plan', text: input.plan.text }, ctx.binding);
      if (plan.kind !== 'submit_plan' || input.plan.digest !== sha256(plan.text))
        return { kind: 'hand_off', reason: 'invalid_plan' };
      messages.push({ role: 'user', content: untrustedFrame('plan', plan.text) });
      if (input.repairOf !== undefined)
        messages.push({ role: 'user', content: untrustedFrame('repair_evidence', input.repairOf) });
    }
    await record(0, 'start', messages);
    // Secret-bearing issue/repair data never goes to the provider.
    assertSecretFree(messages);
    let rejected = 0;
    for (let turn = 1; turn <= maxTurns; turn++) {
      tracking.turn = turn;
      tracking.stage = 'model';
      const time = remaining();
      if (time <= 0) return { kind: 'budget_exhausted', reason: 'active_time' };
      assertProvisionedVm(ctx.adapter, ctx.vm);
      activeModelDeadline = time <= MODEL_TIMEOUT_MS;
      const produced = await meteredComplete(ctx.model, ctx.ledger, ctx.sessionId, ctx.rates, {
        system: AGENT_SYSTEM,
        messages,
        tools: agentTools(phase),
        maxOutputTokens: MODEL_OUTPUT_TOKENS,
        timeoutMs: Math.min(MODEL_TIMEOUT_MS, time),
      });
      // Snapshot the adapter-owned result before the asynchronous transcript sink.
      const result = JSON.parse(JSON.stringify(produced)) as typeof produced;
      await record(turn, 'model', result);
      assertProvisionedVm(ctx.adapter, ctx.vm);
      if (remaining() <= 0) return { kind: 'budget_exhausted', reason: 'active_time' };
      if (result.kind !== 'tool_calls' || result.calls.length !== 1)
        return { kind: 'hand_off', reason: 'model_invalid_response' };
      const call = result.calls[0];
      // Detached JSON only: later producer mutation cannot change admission or history.
      let proposal: unknown;
      let reply: unknown;
      try {
        proposal = JSON.parse(JSON.stringify(call.arguments));
        if (call.name !== 'propose_action') throw new AuthorityError('unknown_action');
        if (typeof call.id !== 'string' || !call.id || call.id.length > 256)
          throw new AuthorityError('invalid_field');
        try {
          assertNoSecrets(call.id);
        } catch {
          throw new AuthorityError('credential_material');
        }
        const admitted = admitModelAction(proposal, ctx.binding);
        if (
          admitted.kind === 'request_publication' ||
          (phase === 'planning' &&
            (admitted.kind === 'worker_write_file' || admitted.kind === 'candidate_ready')) ||
          (phase === 'implementing' && admitted.kind === 'submit_plan')
        )
          throw new AuthorityError('unexpected_action');
        await record(turn, 'admitted', admitted);
        tracking.stage = admitted.kind;
        assertProvisionedVm(ctx.adapter, ctx.vm);
        if (remaining() <= 0) return { kind: 'budget_exhausted', reason: 'active_time' };
        switch (admitted.kind) {
          case 'hand_off':
            return { kind: 'hand_off', reason: admitted.reason };
          case 'submit_plan':
            return { kind: 'plan', text: admitted.text, digest: sha256(admitted.text) };
          case 'candidate_ready': {
            const { kind: _kind, ...meta } = admitted;
            return { kind: 'candidate', overlay, meta };
          }
          case 'worker_write_file': {
            try {
              overlay.write(admitted.path, admitted.content);
            } catch (error) {
              if (error instanceof CanonicalError) throw new AuthorityError('invalid_field');
              throw error;
            }
            await bounded(
              () =>
                ctx.adapter.putFile(
                  ctx.vm,
                  admitted.path,
                  Buffer.from(admitted.content, 'utf8'),
                  overlay.executable(admitted.path)
                ),
              remaining(),
              new WorkerDeadline(true)
            );
            assertProvisionedVm(ctx.adapter, ctx.vm);
            reply = { kind: 'written', path: admitted.path };
            break;
          }
          case 'worker_exec': {
            const activeRemaining = remaining();
            const timeoutMs = Math.min(ctx.limits.commandTimeoutMs, activeRemaining);
            if (timeoutMs < 1000) return { kind: 'budget_exhausted', reason: 'active_time' };
            const { stdout, stderr, exitCode, timedOut, truncated } = await bounded(
              () =>
                ctx.adapter.exec(ctx.vm, {
                  profile: admitted.profile,
                  argv: admitted.argv,
                  network: 'none',
                  timeoutMs,
                  wallTimeoutMs: timeoutMs,
                  env: {},
                }),
              timeoutMs,
              new WorkerDeadline(activeRemaining <= ctx.limits.commandTimeoutMs)
            );
            assertProvisionedVm(ctx.adapter, ctx.vm);
            if (
              typeof stdout !== 'string' ||
              typeof stderr !== 'string' ||
              typeof timedOut !== 'boolean' ||
              typeof truncated !== 'boolean' ||
              (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0))
            )
              throw new Error('invalid_worker_output');
            ctx.collector.append(stdout);
            ctx.collector.append(stderr);
            if (truncated || ctx.collector.truncated)
              return { kind: 'hand_off', reason: 'output_truncated' };
            const { excerpt } = redactedExcerpt(`${stdout}\n--- stderr ---\n${stderr}`, outputTail);
            reply = {
              kind: 'exec_result',
              exitCode,
              timedOut,
              output: excerpt,
            };
            break;
          }
          default:
            throw new AuthorityError('unexpected_action');
        }
        rejected = 0;
      } catch (error) {
        if (!(error instanceof AuthorityError)) throw error;
        rejected++;
        // Publication is unavailable regardless of whether a candidate is bound yet.
        const code = error.code === 'no_candidate' ? 'unexpected_action' : error.code;
        reply = { kind: 'rejected', code };
        await record(turn, 'rejected', reply);
        if (rejected >= 5) return { kind: 'hand_off', reason: 'model_noncompliant' };
      }
      await record(turn, 'reply', reply);
      // Rejected secret proposals and identifiers are omitted from the next request.
      const history = safeRecord({ proposal, id: call.id });
      if (history === REDACTED || typeof call.id !== 'string' || !call.id || call.id.length > 256)
        messages.push({ role: 'user', content: untrustedFrame('action_result', reply) });
      else {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: 'function',
              function: { name: 'propose_action', arguments: JSON.stringify(proposal) },
            },
          ],
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: untrustedFrame('action_result', reply),
        });
      }
    }
    return { kind: 'turns_exhausted' };
  } catch (error) {
    tracking.code = error instanceof BrokerError ? 'broker_failure' : 'controller_failure';
    if (error instanceof ActiveTimeExpired)
      return { kind: 'budget_exhausted', reason: 'active_time' };
    if (error instanceof WorkerDeadline) {
      tracking.stage = 'deadline_cleanup';
      try {
        await bounded(
          () => abortProvisionedVm(ctx.adapter, ctx.vm),
          ctx.cleanupTimeoutMs ?? DEFAULT_LOOP_CLEANUP_TIMEOUT_MS,
          new Error('cleanup_timeout')
        );
      } catch {
        return { kind: 'hand_off', reason: 'cleanup_failed' };
      }
      return error.active
        ? { kind: 'budget_exhausted', reason: 'active_time' }
        : { kind: 'hand_off', reason: 'command_timeout' };
    }
    if (error instanceof BudgetExhaustedError)
      return { kind: 'budget_exhausted', reason: 'budget' };
    if (persistenceFailed) return { kind: 'hand_off', reason: 'persistence_failed' };
    if (error instanceof ModelError) {
      tracking.code = 'provider_failure';
      if (error.code === 'model_timeout' && activeModelDeadline)
        return { kind: 'budget_exhausted', reason: 'active_time' };
      return { kind: 'hand_off', reason: error.code };
    }
    return { kind: 'hand_off', reason: 'loop_failed' };
  }
}

async function runLoop(
  ctx: AgentLoopContext,
  phase: AgentPhase,
  input?: ImplementationInput
): Promise<PlanningResult | ImplementationResult> {
  const tracking: LoopTracking = { turn: 0, stage: 'startup' };
  try {
    const result = await loop(ctx, phase, input, tracking);
    // A failed sink is never recursively asked to report its own failure. Stopping
    // events get a separate small durability allowance even after active expiry.
    if (result.kind === 'hand_off' && result.reason === 'persistence_failed') return result;
    const data = result.kind === 'candidate' ? { kind: result.kind, meta: result.meta } : result;
    try {
      await bounded(
        async () =>
          ctx.persist(
            safeRecord({
              phase,
              turn: tracking.turn,
              stage: tracking.stage,
              code: tracking.code,
              event: 'stop',
              data,
            })
          ),
        TERMINAL_TRANSCRIPT_TIMEOUT_MS,
        new Error('terminal_persistence_timeout')
      );
    } catch {
      return result.kind === 'candidate' || result.kind === 'plan'
        ? { kind: 'hand_off', reason: 'persistence_failed' }
        : result;
    }
    if (result.kind === 'candidate' || result.kind === 'plan') {
      try {
        assertProvisionedVm(ctx.adapter, ctx.vm);
      } catch {
        return { kind: 'hand_off', reason: 'loop_failed' };
      }
    }
    return result;
  } finally {
    tracking.finish?.();
  }
}

export async function runPlanning(ctx: AgentLoopContext): Promise<PlanningResult> {
  return (await runLoop(ctx, 'planning')) as PlanningResult;
}

export async function runImplementation(
  ctx: AgentLoopContext,
  input: ImplementationInput
): Promise<ImplementationResult> {
  return (await runLoop(ctx, 'implementing', input)) as ImplementationResult;
}
