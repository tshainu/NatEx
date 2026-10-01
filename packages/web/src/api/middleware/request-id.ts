import { base } from "../__core/app";
import { errors } from "../shared/errors";
import { ulid } from "../shared/ulid";

/**
 * oRPC's own input-validation rejection: a BAD_REQUEST carrying `data.issues`
 * but no RFC 7807 members, because it is raised by the framework before any
 * handler (and therefore before `fail()`) runs.
 */
function isRawValidationError(e: {
  code?: string;
  data?: { status?: number; issues?: unknown };
}): boolean {
  return (
    e.code === "BAD_REQUEST" &&
    typeof e.data?.status !== "number" &&
    Array.isArray(e.data?.issues)
  );
}

/**
 * STEP 1 of the cross-cutting chain (PROJECT.md §4): request id (ULID),
 * propagated into every log line and every job enqueued by the request.
 */
export const withRequestId = base.middleware(async ({ context, next, path }) => {
  const incoming = context.headers.get("x-request-id");
  const requestId = incoming && incoming.length <= 64 ? incoming : ulid();
  const started = Date.now();
  const route = path.join(".");

  try {
    const result = await next({ context: { requestId, route } });
    console.log(
      JSON.stringify({
        requestId,
        route,
        durationMs: Date.now() - started,
        at: new Date().toISOString(),
      }),
    );
    return result;
  } catch (err) {
    // Expected failures (ORPCError) carry an RFC 7807 document and are logged
    // at their status; anything else is a bug and gets a stack trace, because a
    // bare 500 with no server-side trace is undebuggable.
    const e = err as { code?: string; data?: { status?: number }; message?: string };
    const expected = typeof e.code === "string" && typeof e.data?.status === "number";
    console.log(
      JSON.stringify({
        requestId,
        route,
        durationMs: Date.now() - started,
        status: e.data?.status ?? 500,
        error: e.code ?? "INTERNAL_SERVER_ERROR",
        message: e.message,
        at: new Date().toISOString(),
      }),
    );
    if (!expected) console.error(`[unhandled] ${route} ${requestId}`, err);
    // Give framework-raised validation failures the problem document §11
    // mandates, so a client reads field errors the same way it reads every
    // other error instead of special-casing oRPC's envelope.
    if (isRawValidationError(e as { code?: string; data?: { issues?: unknown } })) {
      errors.validation((e as { data: { issues: unknown[] } }).data.issues);
    }
    throw err;
  }
});
