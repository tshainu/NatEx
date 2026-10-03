import type { MiddlewareHandler } from "hono";

/**
 * Response headers for every /api response (M5 security review).
 *
 * API bodies are JSON holding phone numbers, addresses, COD amounts and bank
 * details, so nothing may be cached by a shared proxy or the browser's disk
 * cache, sniffed as HTML, framed, or leak its URL in a Referer. Set only when
 * the handler has not set its own (the SMS DLR webhook and health probes stay
 * as they are).
 *
 * HTML pages are served by the template's static server (src/__server.ts,
 * template-managed) and by the hosting edge — their CSP/HSTS belongs there.
 * See RUNBOOK.md "Security headers".
 */
const HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-site",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cache-Control": "no-store",
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(HEADERS)) {
    if (!c.res.headers.has(name)) c.res.headers.set(name, value);
  }
};
