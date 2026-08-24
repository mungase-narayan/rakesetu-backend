/**
 * Per-request context, carried without threading it through every signature.
 *
 * A correlation id is only useful if it reaches every log line, including ones
 * written six calls deep in a service that has no idea an HTTP request exists.
 * Passing it explicitly would mean adding a parameter to every function in the
 * codebase and would still be missed. AsyncLocalStorage keeps it on the async
 * call chain instead: anything awaited from inside `run()` can read it, and
 * nothing outside can.
 */
import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  correlationId: string;
  userId?: string;
  orgId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` visible to everything it awaits. */
export const runWithContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined =>
  storage.getStore();

export const getCorrelationId = (): string | undefined =>
  storage.getStore()?.correlationId;

/**
 * Adds to the current context in place — used once the JWT has been verified
 * and the user is known, which happens after the context was created.
 * A no-op outside a request, so a script calling the same service is safe.
 */
export const setRequestContext = (patch: Partial<RequestContext>): void => {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
};

export default storage;
