import { performance } from 'node:perf_hooks';
import { type BudgetLedger, estimateBudget } from '../budget';
import { BudgetError, type BudgetRate, type BudgetReservation } from '../budget-types';
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
        retries: (request.attempts ?? 1) - 1,
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
    result = await withModelDeadline(request, (signal) => adapter.complete({ ...request, signal }));
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
    const observed = estimateBudget(
      {
        currency: session.ceiling.currency,
        model: {
          resource: id,
          maxInputTokens: usage.inputTokens,
          maxOutputTokens: Math.max(1, usage.outputTokens),
          retries: 0,
          streamingTimeMs: Math.max(1, Math.ceil(performance.now() - started)),
        },
      },
      pinnedRates
    );
    // estimateBudget requires a positive output ceiling; charge actual zero output exactly.
    const tokenRate = pinnedRates.find((rate) => rate.resource === id) as BudgetRate;
    const tokens = usage.inputTokens + usage.outputTokens;
    const numerator = BigInt(tokens) * BigInt(tokenRate.price) * BigInt(tokenRate.fx.numerator);
    const denominator = BigInt(tokenRate.units) * BigInt(tokenRate.fx.denominator);
    const minor = Number((numerator + denominator - 1n) / denominator);
    ledger.settle(reservation.id, {
      money: { currency: observed.money.currency, minor },
      tokens,
      timeMs: observed.timeMs,
      source: 'model_usage',
    });
  }
  return result;
}
