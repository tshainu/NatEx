import { eq } from "drizzle-orm";
import { db } from "../database";
import { smsLog } from "../database/schema/shared";
import { claimBatch, markDone, markFailed } from "../shared/outbox";
import { sendSms } from "../shared/sms";
import * as notifications from "../modules/notifications/service";
import type { NotifyInput } from "../modules/notifications/service";
import * as alerts from "../modules/cod/alerts";

/**
 * Outbox drain (PROJECT.md §4 — "every background job runs off the outbox
 * table").
 *
 * KNOWN DEVIATION: §2 specifies Redis 7 + BullMQ 5 with a separate worker
 * process. The managed stack has no Redis, so this drains the SQLite outbox on
 * an interval inside the same process. What is preserved: the enqueue/drain
 * split, at-least-once delivery, the attempt counter, exponential backoff and
 * the dead-letter state after 5 attempts. What is lost: multi-process
 * concurrency and sub-second latency (the claim is still race-safe — see
 * shared/outbox.ts — so a second process would be correct, just unused here).
 */

const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 3000);
const BATCH = 10;

interface SmsSendPayload {
  to: string;
  body: string;
  purpose: string;
}

interface StatusChangedPayload {
  awb: string;
  toStatus: string;
  /** Consignee phone, when the status is one the consignee is told about. */
  notify?: string | null;
}

interface HandedOverPayload {
  manifestId: string;
  merchantPhone?: string | null;
  itemCount: number;
}

function parse<T>(json: string): T {
  return JSON.parse(json) as T;
}

/** Handlers are keyed by topic — an unknown topic is a dead letter, not a crash. */
async function handle(topic: string, payloadJson: string): Promise<void> {
  switch (topic) {
    case "sms.send": {
      const p = parse<SmsSendPayload>(payloadJson);
      const res = await sendSms(p);
      // A gateway failure is a job failure so the backoff retries it. The
      // no-gateway-configured case also lands here in development; the sms_log
      // row records exactly why.
      if (res.state === "failed") throw new Error(`sms gateway: ${res.raw.slice(0, 200)}`);
      return;
    }

    case "parcel.status_changed": {
      const p = parse<StatusChangedPayload>(payloadJson);
      if (!p.notify) return; // Nothing to tell anyone — internal move.
      const res = await sendSms({
        to: p.notify,
        body: `NatEx ${p.awb}: ${p.toStatus}. Track at natex.lk/track/${p.awb}`,
        purpose: "notification",
      });
      if (res.state === "failed") throw new Error(`sms gateway: ${res.raw.slice(0, 200)}`);
      return;
    }

    case "manifest.handed_over": {
      const p = parse<HandedOverPayload>(payloadJson);
      if (!p.merchantPhone) return;
      const res = await sendSms({
        to: p.merchantPhone,
        body: `NatEx collected ${p.itemCount} parcel(s) on manifest ${p.manifestId}.`,
        purpose: "notification",
      });
      if (res.state === "failed") throw new Error(`sms gateway: ${res.raw.slice(0, 200)}`);
      return;
    }

    /**
     * Milestone 3 — the templated notification ladder (§9). The whole walk
     * (WhatsApp → SMS → push, stopping at the first channel that accepts)
     * lives in the notifications module; this case only hands it the payload.
     *
     * A ladder that reached nobody is a job failure so the backoff retries it.
     * Every individual attempt is already recorded in `notify_message`, so a
     * retry is auditable rather than silent.
     */
    case "notify.dispatch": {
      const p = parse<NotifyInput>(payloadJson);
      const res = await notifications.dispatch(p);
      if (!res.delivered) {
        const why = res.attempts
          .map((a) => `${a.channel}:${a.state}${a.reason ? ` (${a.reason})` : ""}`)
          .join(", ");
        throw new Error(`notify ${p.templateKey} reached nobody — ${why || "no channels tried"}`);
      }
      return;
    }

    // Milestone 2 custody events are audit-only: the durable record is the
    // parcel_event / hub_scan / exception row written in the same request. The
    // job is consumed so the outbox stays drained, and this is where a
    // notification or finance hook attaches later without touching callers.
    case "trip.departed":
    case "bag.received":
    case "custody.exception_raised":
      return;

    /**
     * Milestone 4 — the money module's escalations (§8's controls table).
     *
     * These are NOT audit-only. Before this case existed all eight `cod.*`
     * topics hit the `default` below, retried five times and dead-lettered, so
     * §8's "ops notified" / "escalated to finance" happened nowhere: verified
     * against the live outbox, which held failed `cod.amount_mismatch`,
     * `cod.ceiling_breached`, `cod.deposit_variance` and
     * `cod.stale_collection` rows.
     *
     * `modules/cod/alerts.ts` owns the mapping and writes the durable
     * `cod_ops_alert` row (idempotent on its own source key, which matters
     * because the outbox is at-least-once). A `cod.*` topic added later with no
     * mapping there throws — so it dead-letters loudly rather than silently,
     * which is the failure this whole path exists to prevent.
     */
    case "cod.amount_mismatch":
    case "cod.ceiling_breached":
    case "cod.deposit_variance":
    case "cod.stale_collection":
    case "cod.invariant_breached":
    case "cod.settlement_approved":
    case "cod.settlement_paid":
    case "cod.dispute_opened": {
      await alerts.recordOutboxAlert(topic, payloadJson);
      return;
    }

    default:
      throw new Error(`unknown outbox topic: ${topic}`);
  }
}

/** One drain pass. Exported so a test or an ops endpoint can force a tick. */
export async function drainOnce(): Promise<{ claimed: number; done: number; failed: number }> {
  const batch = await claimBatch(BATCH);
  let done = 0;
  let failed = 0;
  for (const job of batch) {
    try {
      await handle(job.topic, job.payloadJson);
      await markDone(job.id);
      done += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // attempts was already incremented by the claim.
      await markFailed(job.id, job.attempts + 1, message);
      failed += 1;
      console.warn(`[worker] ${job.topic} ${job.id} attempt ${job.attempts + 1} failed: ${message}`);
    }
  }
  return { claimed: batch.length, done, failed };
}

/**
 * The timer handle lives on globalThis, not in a module-level `let`.
 *
 * Under Vite's SSR HMR every edit in the API graph loads a *fresh* instance of
 * this module while the previous instance's interval keeps firing — and that
 * stale interval closes over the stale `handle()`. Symptom: the log fills with
 * "unknown outbox topic: <topic>" for topics the code on disk plainly handles,
 * because the topic was added after the old instance loaded.
 *
 * Keying the handle globally lets a new instance clear the previous loop and
 * take ownership, so exactly one drain runs and it is always the newest code.
 */
type WorkerGlobal = typeof globalThis & {
  __natexOutboxTimer?: ReturnType<typeof setInterval> | null;
};
const workerGlobal = globalThis as WorkerGlobal;

/** Start the interval drain. A second call replaces the previous loop. */
export function startWorker(): void {
  if (workerGlobal.__natexOutboxTimer) clearInterval(workerGlobal.__natexOutboxTimer);
  const timer = setInterval(() => {
    void drainOnce().catch((err: unknown) => {
      console.error("[worker] drain pass threw:", err);
    });
  }, POLL_MS);
  // Do not hold the process open on its own.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }
  workerGlobal.__natexOutboxTimer = timer;
  console.log(`[worker] outbox drain started (every ${POLL_MS}ms)`);
}

export function stopWorker(): void {
  if (workerGlobal.__natexOutboxTimer) clearInterval(workerGlobal.__natexOutboxTimer);
  workerGlobal.__natexOutboxTimer = null;
}

/**
 * Delivery receipt from the SMS gateway (PROJECT.md §9). The gateway's payload
 * shape is unknown, so every plausible field name for the reference and the
 * state is accepted and the raw body is kept verbatim.
 */
export async function recordDeliveryReceipt(
  fields: Record<string, string>,
  rawBody: string,
): Promise<{ matched: boolean; logId: string | null; state: string }> {
  const ref =
    fields.messageId ??
    fields.message_id ??
    fields.id ??
    fields.ref ??
    fields.reference ??
    fields.transactionId ??
    null;

  const rawState = (fields.status ?? fields.state ?? fields.dlr ?? "").toLowerCase();
  const state =
    rawState.includes("deliver") || rawState === "dlvrd" || rawState === "success"
      ? "delivered"
      : rawState.includes("fail") || rawState.includes("undeliv") || rawState.includes("reject")
        ? "failed"
        : rawState.includes("sent")
          ? "sent"
          : "unknown";

  if (!ref) return { matched: false, logId: null, state };

  const [row] = await db.select().from(smsLog).where(eq(smsLog.gatewayRef, ref)).limit(1);
  if (!row) return { matched: false, logId: null, state };

  await db
    .update(smsLog)
    .set({
      state: state === "unknown" ? row.state : state,
      rawResponse: rawBody.slice(0, 4000),
      updatedAt: new Date(),
    })
    .where(eq(smsLog.id, row.id));

  return { matched: true, logId: row.id, state };
}

if (import.meta.main) {
  startWorker();
  // Keep the standalone process alive.
  setInterval(() => {}, 1 << 30);
}
