import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface TraceContext {
  readonly traceId: string;
  readonly startedAt: number;
}

// Single ALS instance shared across the process. Each tk.track() call
// establishes a new child context without affecting sibling or parent traces.
export const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Runs `fn` inside a new trace context. Every instrumented function call made
 * within `fn` (including across await boundaries) is tagged with the same
 * `traceId` in the registry.
 *
 * @returns A Promise that resolves to whatever `fn` returns.
 */
export function track<T>(fn: () => Promise<T> | T): Promise<T> {
  const ctx: TraceContext = {
    traceId: randomUUID(),
    startedAt: Date.now(),
  };
  // Promise.resolve normalises sync (T) and async (Promise<T>) return values.
  // The try/catch converts synchronous throws into rejected Promises so that
  // callers can always use .catch() / await, matching async function semantics.
  return traceStorage.run(ctx, () => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err) as Promise<T>;
    }
  });
}
