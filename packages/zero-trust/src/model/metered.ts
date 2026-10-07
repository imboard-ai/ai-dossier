import { performance } from 'node:perf_hooks';
import { type BudgetLedger, estimateBudget, observeModelBudget } from '../budget';
import {
  BudgetError,
  type BudgetObservation,
  type BudgetRate,
  type BudgetReservation,
} from '../budget-types';
import {
  type ModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelResult,
  modelRequestBody,
  snapshotModelRequest,
  withModelDeadline,
} from './adapter';

export class BudgetExhaustedError extends Error {
  constructor(readonly code: 'ceiling_exceeded' | 'limit_exceeded') {
    super('Model budget exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

/** No provider call without a durable reservation covering the entire attempt budget. */
export async function meteredComplete(
  adapter: ModelAdapter,
  ledger: BudgetLedger,
  sessionId: string,
  rates: BudgetRate[],
  input: ModelRequest
): Promise<ModelResult> {
  const request = snapshotModelRequest(input);
  if (request.signal?.aborted) throw new ModelError('model_aborted');
  const id = adapter.id;
  const pinnedRates = structuredClone(rates);
  const session = ledger.snapshot().sessions.find((item) => item.id === sessionId);
  if (!session) throw new BudgetError('unknown_session', 'Unknown budget session');
  const inputBound = Buffer.byteLength(modelRequestBody(id, request), 'utf8');
  const estimate = estimateBudget(
    {
      currency: session.ceiling.currency,
      model: {
        resource: id,
        maxInputTokens: inputBound,
        maxOutputTokens: request.maxOutputTokens,
        retries: request.attempts - 1,
        streamingTimeMs: request.timeoutMs,
      },
    },
    pinnedRates
  );
  let reservation: BudgetReservation;
  try {
    reservation = ledger.reserve(sessionId, estimate, 'work');
  } catch (error) {
    if (
      error instanceof BudgetError &&
      (error.code === 'ceiling_exceeded' || error.code === 'limit_exceeded')
    )
      throw new BudgetExhaustedError(error.code);
    throw error;
  }
  const started = performance.now();
  let result: ModelResult;
  try {
    result = await withModelDeadline(
      { ...request, timeoutMs: request.timeoutMs * request.attempts },
      (signal) => adapter.complete({ ...request, signal })
    );
  } catch (error) {
    ledger.settle(reservation.id, null);
    // Never propagate provider exception text/cause.
    if (error instanceof ModelError) throw new ModelError(error.code, error.status);
    throw new ModelError('model_unavailable');
  }
  const usage = result.usage;
  if (
    !usage ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  ) {
    ledger.settle(reservation.id, null);
  } else {
    let observed: BudgetObservation;
    try {
      observed = observeModelBudget(
        {
          currency: session.ceiling.currency,
          resource: id,
          ...usage,
          timeMs: Math.ceil(performance.now() - started),
        },
        pinnedRates
      );
    } catch (error) {
      if (!(error instanceof BudgetError)) throw error;
      ledger.settle(reservation.id, null);
      return { ...result, usage: null };
    }
    ledger.settle(reservation.id, observed);
  }
  return result;
}
