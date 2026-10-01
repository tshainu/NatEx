import { and, eq, lte } from "drizzle-orm";
import { db } from "../database";
import { outbox } from "../database/schema/shared";
import { prefixedId } from "./ulid";

/**
 * Transactional outbox (PROJECT.md §4): a request handler that needs background
 * work appends a row here instead of calling the worker directly.
 *
 * KNOWN DEVIATION: §2 specifies Redis 7 + BullMQ 5. The managed stack has no
 * Redis, so jobs/worker.ts polls this table. The outbox contract — enqueue
 * inside the request, drain outside it — is preserved exactly.
 */

export type OutboxTopic =
  | "sms.send"
  | "parcel.status_changed"
  | "manifest.handed_over"
  // Milestone 2 — custody events. Audit-only for now: they exist so linehaul
  // and exception activity is replayable, and so a later milestone can hang a
  // notification or a finance hook off them without changing call sites.
  | "trip.departed"
  | "bag.received"
  | "custody.exception_raised"
  /**
   * Milestone 3 — the templated notification ladder (§9: WhatsApp → SMS →
   * push). The payload is a modules/notifications/service.ts `NotifyInput`.
   *
   * Notifications go through the outbox rather than being sent inline because
   * a rider standing at a doorstep must not wait on a messaging gateway, and
   * because a gateway outage must retry rather than fail the delivery.
   */
  | "notify.dispatch"
  /**
   * Milestone 4 — the money module's escalations (§8's controls table).
   *
   * Every one of these is a finance or ops signal that must survive a request
   * failing: a rider crossing the cash ceiling still crossed it, and a
   * breached balance invariant must reach a human whether or not the nightly
   * job's caller is still listening.
   */
  | "cod.amount_mismatch"
  | "cod.ceiling_breached"
  | "cod.deposit_variance"
  | "cod.stale_collection"
  | "cod.invariant_breached"
  | "cod.settlement_approved"
  | "cod.settlement_paid"
  | "cod.dispute_opened";

export async function enqueue(topic: OutboxTopic, payload: unknown): Promise<string> {
  const id = prefixedId("obx");
  await db.insert(outbox).values({
    id,
    topic,
    payloadJson: JSON.stringify(payload),
    state: "pending",
    availableAt: new Date(),
  });
  return id;
}

export async function claimBatch(limit = 10) {
  const now = new Date();
  const pending = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.state, "pending"), lte(outbox.availableAt, now)))
    .limit(limit);

  const claimed: typeof pending = [];
  for (const row of pending) {
    // Conditional update is the claim — a second worker loses the race and skips.
    const res = await db
      .update(outbox)
      .set({ state: "processing", attempts: row.attempts + 1 })
      .where(and(eq(outbox.id, row.id), eq(outbox.state, "pending")))
      .returning({ id: outbox.id });
    if (res.length > 0) claimed.push(row);
  }
  return claimed;
}

export async function markDone(id: string): Promise<void> {
  await db
    .update(outbox)
    .set({ state: "done", processedAt: new Date(), lastError: null })
    .where(eq(outbox.id, id));
}

export async function markFailed(id: string, attempts: number, error: string): Promise<void> {
  const giveUp = attempts >= 5;
  await db
    .update(outbox)
    .set({
      state: giveUp ? "failed" : "pending",
      lastError: error.slice(0, 1000),
      // Exponential backoff: 5s, 10s, 20s, 40s...
      availableAt: new Date(Date.now() + 5000 * 2 ** Math.min(attempts, 4)),
    })
    .where(eq(outbox.id, id));
}
