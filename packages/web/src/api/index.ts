import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { startNightly } from "./jobs/nightly";
import { recordDeliveryReceipt, startWorker } from "./jobs/worker";
import { cod } from "./routes/cod";
import { collection } from "./routes/collection";
import { delivery } from "./routes/delivery";
import { disputes } from "./routes/disputes";
import { finance } from "./routes/finance";
import { identity } from "./routes/identity";
import { merchants } from "./routes/merchants";
import { ndr } from "./routes/ndr";
import { notifications } from "./routes/notifications";
import { parcels } from "./routes/parcels";
import { ping } from "./routes/ping";
import { routing } from "./routes/routing";
import { sync } from "./routes/sync";
import { transport } from "./routes/transport";
import { problemResponse, problem } from "./shared/errors";

// API features are oRPC procedures, one file per feature in ./routes/,
// composed into this router — typed end-to-end via the clients
// (web: src/web/lib/api.ts, mobile: lib/api.ts).
// Keep each routes/ file under 500 lines (`bun run lint` enforces this);
// split into more feature files as they grow.
// Patterns and examples: skills/app/references/api.md
//
// Namespaces mirror PROJECT.md's module boundaries (§3): identity, merchants,
// parcels, collection, routing, transport, delivery, ndr, notifications, and
// the money module split across two namespaces: cod (rider cash, deposits,
// reconciliation), finance (settlement, holds, invoices, AR) and disputes
// (the dispute queue and claim register). sync is the
// device-facing offline engine (Â§7) and its ops exception queue. Rating
// arrives in a later milestone.
export const router = {
  ping,
  identity,
  merchants,
  parcels,
  collection,
  routing,
  transport,
  delivery,
  ndr,
  notifications,
  cod,
  finance,
  disputes,
  sync,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);

/**
 * SMS delivery receipt (PROJECT.md §9). Plain HTTP, not oRPC: the gateway posts
 * whatever shape it likes, so the body is read as text and parsed leniently.
 * Shared-secret guarded via the `s` query param or the X-DLR-Secret header —
 * the gateway cannot hold a JWT.
 */
app.post("/api/webhooks/sms/dlr", async (c) => {
  const expected = process.env.SMS_DLR_WEBHOOK_SECRET;
  const supplied = c.req.query("s") ?? c.req.header("x-dlr-secret") ?? "";
  if (!expected || supplied !== expected) {
    return problemResponse(
      problem("unauthenticated", "Not authenticated", 401, "Invalid delivery-receipt secret."),
    );
  }

  const raw = await c.req.text();
  const fields: Record<string, string> = {};
  // Query params first, then form-encoded or JSON body — gateways use all three.
  for (const [k, v] of new URL(c.req.url).searchParams) fields[k] = v;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number") fields[k] = String(v);
      }
    }
  } catch {
    for (const [k, v] of new URLSearchParams(raw)) fields[k] = v;
  }

  const result = await recordDeliveryReceipt(fields, raw);
  // Always 200 once authenticated: an unmatched receipt is the gateway's
  // problem to stop resending, not an error we want retried forever.
  return c.json({ received: true, ...result });
});

// The outbox drain and the nightly invariant run in-process (see jobs/*.ts).
startWorker();
startNightly();

export default app;
