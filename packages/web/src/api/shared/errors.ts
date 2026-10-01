import { ORPCError } from "@orpc/server";

/**
 * RFC 7807 problem+json (PROJECT.md §11).
 *
 * oRPC serialises its own envelope, so the problem document is carried in the
 * error `data` field with the exact RFC 7807 members (type, title, status,
 * detail, instance) plus any extensions. Plain HTTP routes (webhooks) return
 * `application/problem+json` directly via `problemResponse()`.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

const BASE = "https://natex.lk/problems";

export function problem(
  slug: string,
  title: string,
  status: number,
  detail?: string,
  extensions: Record<string, unknown> = {},
): Problem {
  // Extensions are spread FIRST so the five RFC 7807 members always win. An
  // extension is domain data supplied by a caller — several legitimately carry
  // a field called `status` (a runsheet's status, a parcel's status), and when
  // those were spread last they overwrote the document's HTTP status code with
  // a string like "dispatched", leaving clients unable to tell a 409 from a
  // 403. The domain value stays readable under its own key on the way in;
  // callers that need both should name theirs `currentStatus`.
  return { ...extensions, type: `${BASE}/${slug}`, title, status, detail };
}

export function problemResponse(p: Problem): Response {
  return new Response(JSON.stringify(p), {
    status: p.status,
    headers: { "content-type": "application/problem+json" },
  });
}

/**
 * Flatten an error and every `cause` beneath it into one string.
 *
 * Drizzle wraps a driver failure in a plain `Error` whose message is only the
 * offending SQL ("Failed query: insert into ..."), and hangs the real driver
 * error off `.cause`. A constraint check written against the top-level
 * `.message` therefore never matches — it inspects the query text instead of
 * the failure. Verified empirically against libsql: the useful message sits two
 * causes down, on the `ResponseError`.
 */
export function errorChain(error: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < maxDepth; depth++) {
    if (current instanceof Error || typeof current === "object") {
      const e = current as { message?: unknown; cause?: unknown };
      if (e.message !== undefined) parts.push(String(e.message));
      current = e.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}

/**
 * The columns named by a UNIQUE constraint violation, or null if this error is
 * not one.
 *
 * SQLite reports the violated *columns*, never the index name — a composite
 * index fails as "UNIQUE constraint failed: cod_entry.type, cod_entry.parcel_id"
 * and a single-column one as "UNIQUE constraint failed: cod_entry.client_id".
 * Matching on the index name (`cod_entry_one_collect_per_parcel`) silently
 * never fires, which is why this parses the column list instead.
 */
export function uniqueViolationColumns(error: unknown): string[] | null {
  const match = /UNIQUE constraint failed:\s*([^|\n"]+)/.exec(errorChain(error));
  if (!match?.[1]) return null;
  return match[1]
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}

/**
 * True when `error` is a UNIQUE violation on exactly this set of columns.
 *
 * Exact set equality on purpose: a substring test for "cod_entry.client_id"
 * would also match a composite violation that happens to include that column,
 * and the two demand opposite responses (one is a 409, the other an idempotent
 * replay).
 */
export function isUniqueViolationOn(error: unknown, ...columns: string[]): boolean {
  const violated = uniqueViolationColumns(error);
  if (!violated || violated.length !== columns.length) return false;
  const expected = [...columns].sort();
  return [...violated].sort().every((column, index) => column === expected[index]);
}

type OrpcCode = ConstructorParameters<typeof ORPCError>[0];

/** Throw an oRPC error carrying an RFC 7807 document. */
export function fail(
  code: string,
  p: Problem,
): never {
  throw new ORPCError(code as OrpcCode, { message: p.detail ?? p.title, data: p });
}

export const errors = {
  unauthenticated: (detail = "Valid access token required."): never =>
    fail("UNAUTHORIZED", problem("unauthenticated", "Not authenticated", 401, detail)),

  forbidden: (detail: string, extensions: Record<string, unknown> = {}): never =>
    fail("FORBIDDEN", problem("forbidden", "Not permitted", 403, detail, extensions)),

  notFound: (what: string): never =>
    fail("NOT_FOUND", problem("not-found", `${what} not found`, 404)),

  conflict: (detail: string, extensions: Record<string, unknown> = {}): never =>
    fail("CONFLICT", problem("conflict", "Conflict", 409, detail, extensions)),

  /**
   * Illegal parcel state transition — 422 with the current state
   * (PROJECT.md §6: "anything else returns 422 with the current state").
   */
  illegalTransition: (
    awb: string,
    current: string,
    attempted: string,
    legal: string[],
    /** A workflow guard (POD, sealed bag) refused an otherwise-listed edge. */
    guard?: { reason: string; detail: string },
  ): never =>
    fail(
      "UNPROCESSABLE_CONTENT",
      problem(
        "illegal-transition",
        "Illegal parcel transition",
        422,
        guard
          ? `Parcel ${awb} is ${current}: ${guard.detail}`
          : `Parcel ${awb} is ${current} and cannot move to ${attempted}.`,
        {
          awb,
          currentStatus: current,
          attemptedStatus: attempted,
          legalTransitions: legal,
          ...(guard ? { guard: guard.reason } : {}),
        },
      ),
    ),

  rateLimited: (retryAfterSeconds: number): never =>
    fail(
      "TOO_MANY_REQUESTS",
      problem("rate-limited", "Too many requests", 429, "Rate limit exceeded.", {
        retryAfterSeconds,
      }),
    ),

  idempotencyRequired: (route: string): never =>
    fail(
      "BAD_REQUEST",
      problem(
        "idempotency-key-required",
        "Idempotency-Key required",
        400,
        `${route} is a mutating endpoint; send an Idempotency-Key header.`,
      ),
    ),

  idempotencyMismatch: (): never =>
    fail(
      "CONFLICT",
      problem(
        "idempotency-key-reused",
        "Idempotency-Key reused with a different payload",
        409,
        "This Idempotency-Key was already used for a different request body.",
      ),
    ),

  badRequest: (detail: string, extensions: Record<string, unknown> = {}): never =>
    fail("BAD_REQUEST", problem("bad-request", "Bad request", 400, detail, extensions)),

  /**
   * Zod rejected the input. oRPC raises its own BAD_REQUEST for this before any
   * handler runs, so it never passes through `fail()` and arrives without an
   * RFC 7807 document — §11 requires every API error to carry one. Rewritten
   * centrally in middleware/request-id.ts, which is the one chokepoint every
   * procedure passes through.
   */
  validation: (issues: unknown[]): never =>
    fail(
      "BAD_REQUEST",
      problem(
        "validation-failed",
        "Input validation failed",
        400,
        "One or more fields are missing or malformed.",
        { issues },
      ),
    ),

  upstream: (detail: string): never =>
    fail("BAD_GATEWAY", problem("upstream-failure", "Upstream failure", 502, detail)),
};
