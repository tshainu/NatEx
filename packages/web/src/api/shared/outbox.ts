import { and, asc, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../database";
import type { DbTransaction } from "../database/transaction";
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

export async function enqueue(
  topic: OutboxTopic,
  payload: unknown,
  executor: DbTransaction | typeof db = db,
): Promise<string> {
  const id = prefixedId("obx");
  await executor.insert(outbox).values({
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

// ─────────────────────────────────────────────── job monitor (§10 M5)

/** Counts by topic × state, plus the oldest still-pending job. */
export async function outboxSummary() {
  const rows = await db
    .select({ topic: outbox.topic, state: outbox.state, n: sql<number>`count(*)` })
    .from(outbox)
    .groupBy(outbox.topic, outbox.state);
  const [oldest] = await db
    .select({ id: outbox.id, topic: outbox.topic, createdAt: outbox.createdAt, availableAt: outbox.availableAt })
    .from(outbox)
    .where(inArray(outbox.state, ["pending", "processing"]))
    .orderBy(asc(outbox.createdAt))
    .limit(1);
  const totals: Record<string, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const r of rows) totals[r.state] = (totals[r.state] ?? 0) + Number(r.n);
  return {
    totals,
    byTopic: rows.map((r) => ({ topic: r.topic, state: r.state, count: Number(r.n) })),
    oldestPending: oldest ?? null,
  };
}

export async function listOutbox(q: { state?: string; topic?: string; limit: number; offset: number }) {
  const filters: SQL[] = [];
  if (q.state) filters.push(eq(outbox.state, q.state));
  if (q.topic) filters.push(eq(outbox.topic, q.topic));
  const where = filters.length ? and(...filters) : undefined;
  const limit = Math.min(Math.max(q.limit, 1), 200);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: outbox.id,
        topic: outbox.topic,
        state: outbox.state,
        attempts: outbox.attempts,
        lastError: outbox.lastError,
        availableAt: outbox.availableAt,
        processedAt: outbox.processedAt,
        createdAt: outbox.createdAt,
      })
      .from(outbox)
      .where(where)
      .orderBy(desc(outbox.createdAt))
      .limit(limit)
      .offset(Math.max(q.offset, 0)),
    db.select({ n: sql<number>`count(*)` }).from(outbox).where(where),
  ]);
  return { rows, total: Number(total?.n ?? 0) };
}

/**
 * Put a dead-lettered job back in the queue. It keeps its attempt count, so a
 * job that fails again goes straight back to `failed` (markFailed gives up at
 * 5): a manual retry buys exactly one more attempt, never an unbounded loop.
 */
export async function retryFailed(id: string): Promise<{ id: string; retried: boolean }> {
  const res = await db
    .update(outbox)
    .set({ state: "pending", availableAt: new Date() })
    .where(and(eq(outbox.id, id), eq(outbox.state, "failed")))
    .returning({ id: outbox.id });
  return { id, retried: res.length > 0 };
}
