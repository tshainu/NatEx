/**
 * The one place an unexpected server error is reported (§10 M5 — Sentry).
 *
 * Today it writes a stack trace to stderr, which is what the host's log
 * collector keeps. Sentry is NOT wired: no DSN has been supplied. When one is,
 * this is the only file that changes — add `@sentry/bun`, call `Sentry.init`
 * once with `process.env.SENTRY_DSN`, and `Sentry.captureException(err, { tags })`
 * here. Expected failures (RFC 7807 problems: validation, 404, 409…) never
 * reach this function, so Sentry would only see real bugs.
 *
 * Context is limited to route + request id on purpose: request bodies can hold
 * phone numbers, bank details and OTPs, and must not leave the server.
 */
export function reportError(err: unknown, context: { route: string; requestId: string }): void {
  console.error(`[unhandled] ${context.route} ${context.requestId}`, err);
}
