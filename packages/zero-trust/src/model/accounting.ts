import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelAdapter } from './adapter';

// Controller-only provenance. Arbitrary adapters cannot release a reservation by
// throwing an error captured from a different built-in call or metering scope.
const origins = new WeakMap<ModelAdapter, ModelAdapter>();
const contexts = new AsyncLocalStorage<{ origin?: ModelAdapter; token: object }>();
const rejections = new WeakMap<object, { token: object; evidence: string }>();

export function registerModelAccounting(adapter: ModelAdapter): void {
  origins.set(adapter, adapter);
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
  if (context?.origin === adapter) rejections.set(error, { token: context.token, evidence });
}

export function modelAccountingScope(adapter: ModelAdapter) {
  const context = { origin: origins.get(adapter), token: {} };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return contexts.run(context, operation);
    },
    consume(error: unknown): string | undefined {
      if (typeof error !== 'object' || error === null) return;
      const rejection = rejections.get(error);
      rejections.delete(error);
      return rejection?.token === context.token ? rejection.evidence : undefined;
    },
  };
}
