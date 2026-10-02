/**
 * Per-request scope used by the request-id middleware to decide whether a
 * failed request may be transparently re-run.
 *
 * The database is Turso over HTTP. Its pooled keep-alive sockets are
 * occasionally reset by the far end ("socket hang up" / ECONNRESET), which
 * surfaced to users as a bare 500 on an ordinary list read. A read is safe to
 * re-run; a write is not, because the reset may land after the statement
 * committed. So every write path (`mutate`, `publicMutate`) marks the scope,
 * and the middleware only retries a request that never marked it.
 */
interface RequestScope {
  wrote: boolean;
}

/**
 * The minimal AsyncLocalStorage surface used here. Loaded through
 * `process.getBuiltinModule` (Node ≥ 22.3, Bun) rather than an
 * `import "node:async_hooks"`: the mobile and desktop packages type-check the
 * API through `AppRouter`, and they have no Node type definitions.
 */
interface ScopeStorage<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}
type AsyncHooks = { AsyncLocalStorage: new <T>() => ScopeStorage<T> };
const builtins = (globalThis as unknown as {
  process?: { getBuiltinModule?: (id: string) => unknown };
}).process;
const hooks = builtins?.getBuiltinModule?.("node:async_hooks") as AsyncHooks | undefined;
if (!hooks) throw new Error("request-scope: node:async_hooks is unavailable in this runtime");

const storage = new hooks.AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ wrote: false }, fn);
}

/** Called at the top of every write path. Outside a request it is a no-op. */
export function markWrite(): void {
  const scope = storage.getStore();
  if (scope) scope.wrote = true;
}

export function requestWrote(): boolean {
  return storage.getStore()?.wrote ?? false;
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "UND_ERR_SOCKET"]);
const TRANSIENT_TEXT = [
  "socket hang up",
  "socket connection was closed unexpectedly",
  "other side closed",
];

/**
 * True when the failure is a network drop between this server and the
 * database, found anywhere on the `cause` chain (Drizzle wraps the libsql
 * error, which wraps the fetch error). Never true for an ORPCError, a
 * constraint violation or a bad query.
 */
export function isTransientDbError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 6; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
    if (typeof e.message === "string") {
      const m = e.message.toLowerCase();
      if (TRANSIENT_TEXT.some((t) => m.includes(t))) return true;
    }
    cur = e.cause;
  }
  return false;
}
