import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelAdapter } from './adapter';

// Controller-only provenance. Arbitrary adapters cannot release a reservation by
// throwing an error captured from a different built-in call or metering scope.
type Origin = { adapter: ModelAdapter; complete: ModelAdapter['complete'] };
const origins = new WeakMap<ModelAdapter, Origin>();
const contexts = new AsyncLocalStorage<{ origin?: Origin; token: object; calls: number }>();
const rejections = new WeakMap<object, { token: object; evidence: string }>();

export function registerModelAccounting(adapter: ModelAdapter): void {
  origins.set(adapter, { adapter, complete: adapter.complete });
}

/** Trusted decorators preserve accounting provenance as well as request metadata. */
export function forwardModelAccounting<T extends ModelAdapter>(
  wrapper: T,
  source: ModelAdapter
): T {
  const origin = origins.get(source);
  if (origin) origins.set(wrapper, origin);
  return wrapper;
}

export function recordModelRejection(adapter: ModelAdapter, error: object, evidence: string): void {
  const context = contexts.getStore();
  if (
    context?.calls === 1 &&
    context.origin?.adapter === adapter &&
    adapter.complete === context.origin.complete
  )
    rejections.set(error, { token: context.token, evidence });
}

/** A second complete call in one reservation permanently makes total billing unknown. */
export function beginModelAccounting(): void {
  const context = contexts.getStore();
  if (context) context.calls++;
}

export function modelAccountingScope(adapter: ModelAdapter) {
  const context = { origin: origins.get(adapter), token: {}, calls: 0 };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return contexts.run(context, operation);
    },
    consume(error: unknown): string | undefined {
      if (typeof error !== 'object' || error === null) return;
      const rejection = rejections.get(error);
      rejections.delete(error);
      return context.calls === 1 && rejection?.token === context.token
        ? rejection.evidence
        : undefined;
    },
  };
}
