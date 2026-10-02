/**
 * Ops and finance alerts — the destination for the money module's outbox
 * escalations (PROJECT.md §8's controls table, §4's outbox rule).
 *
 * THE BUG THIS FIXES. `service.ts` and `settlement.ts` enqueue eight `cod.*`
 * topics. `jobs/worker.ts` had a handler for none of them, so every one fell
 * through to `throw new Error("unknown outbox topic")`, retried five times and
 * dead-lettered. §8's controls all end in "ops notified" / "escalated to
 * finance"; in practice nobody was notified of anything. Confirmed against the
 * live `shared_outbox` table before this file existed:
 *
 *     cod.amount_mismatch     failed  1  unknown outbox topic: cod.amount_mismatch
 *     cod.ceiling_breached    failed  1  unknown outbox topic: cod.ceiling_breached
 *     cod.deposit_variance    failed  2  unknown outbox topic: cod.deposit_variance
 *     cod.stale_collection    failed  1  unknown outbox topic: cod.stale_collection
 *
 * WHY A TABLE AND NOT A NO-OP. The M2 custody topics (`trip.departed`,
 * `bag.received`, `custody.exception_raised`) are handled as deliberate no-ops
 * because the durable record — the `parcel_event`, `hub_scan` or
 * `transport_exception` row — was already written inside the request. Two of
 * the eight `cod.*` topics are in that position (`amount_mismatch` and
 * `deposit_variance` raise a `cod_hold`, `invariant_breached` writes a
 * `cod_invariant_run`), but `ceiling_breached`, `stale_collection` and the
 * settlement pair have no such row: a rider over the cash ceiling blocks
 * dispatch, not a payout, so it is not a hold, and before this file it existed
 * only as a line in `audit_log`. Rather than handle three topics one way and
 * five another, every escalation lands here and the ones that also have a hold
 * carry its id — so a single query answers "what does the ops desk owe work
 * on" regardless of which control fired.
 *
 * DESIGN INFERENCE — FLAG TO THE CLIENT. §8 requires notification but names no
 * mechanism, and §15 asks nothing about alert routing. A durable worklist is
 * the reading that survives a process restart, which is the whole point of
 * putting these through the outbox. If NatEx wants a push to a duty officer's
 * phone, it hangs off `listAlerts()` without touching a single caller.
 *
 * CLIENT-CONFIRMED, AND SPLIT. The merchant IS told when a payout is released:
 * `settlement.ts`'s `recordPayout()` enqueues a `notify.dispatch` on the
 * `settlement.paid` template alongside the `cod.settlement_paid` alert. It
 * fires on *paid* only, not on *approved* — an approved run has no UTR yet, and
 * a merchant told "released" before the bank moves phones the desk the same
 * afternoon. Both `settlement_approved` and `settlement_paid` stay recorded
 * here too, as the finance desk's own durable activity trail (actionRequired
 * false): the merchant's SMS and finance's record are separate concerns that
 * must fail independently.
 */

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../database";
import { codDispute, codOpsAlert } from "../../database/schema/cod";
import { errors, fail, isUniqueViolationOn, problem } from "../../shared/errors";
import { formatLkr } from "../../shared/money";
import { colomboToday } from "../../shared/time";
import { prefixedId } from "../../shared/ulid";
import { writeAudit } from "../../shared/audit";
import type { Principal } from "../../shared/auth";

export type CodOpsAlertRow = typeof codOpsAlert.$inferSelect;

/** One per `cod.*` outbox topic, named without the `cod.` prefix. */
export const ALERT_KINDS = [
  "amount_mismatch",
  "ceiling_breached",
  "deposit_variance",
  "stale_collection",
  "invariant_breached",
  "settlement_approved",
  "settlement_paid",
  "dispute_opened",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertSeverity = "low" | "medium" | "high";
export type AlertAudience = "ops" | "finance";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface RaiseAlertInput {
  topic: string;
  kind: AlertKind;
  severity: AlertSeverity;
  audience: AlertAudience;
  /** False for informational records — news for the feed, not work for a desk. */
  actionRequired?: boolean;
  summary: string;
  sourceKey: string;
  payload?: unknown;
  riderId?: string | null;
  merchantId?: string | null;
  parcelId?: string | null;
  awb?: string | null;
  entryId?: string | null;
  depositId?: string | null;
  settlementId?: string | null;
  disputeId?: string | null;
  invariantRunId?: string | null;
  amountCents?: number | null;
}

/**
 * Record an escalation, or return the existing one for the same `sourceKey`.
 *
 * Idempotent by unique constraint rather than read-then-write, for the same
 * reason `raiseHold()` is: the outbox is at-least-once, so this function WILL
 * be called twice for one event, and two concurrent drains would both pass a
 * read check.
 *
 * An already-resolved alert is not re-opened. A redelivered job is not new
 * evidence; a genuinely new occurrence carries a new `sourceKey` (which is why
 * the recurring detectors below date-stamp theirs).
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<{
  alert: CodOpsAlertRow;
  created: boolean;
}> {
  if (!input.summary?.trim()) {
    fail(
      "BAD_REQUEST",
      problem("summary-required", "Summary required", 422, "An alert must say what happened."),
    );
  }

  const id = prefixedId("alrt");
  try {
    await db.insert(codOpsAlert).values({
      id,
      topic: input.topic,
      kind: input.kind,
      severity: input.severity,
      audience: input.audience,
      actionRequired: input.actionRequired ?? true,
      riderId: input.riderId ?? null,
      merchantId: input.merchantId ?? null,
      parcelId: input.parcelId ?? null,
      awb: input.awb ?? null,
      entryId: input.entryId ?? null,
      depositId: input.depositId ?? null,
      settlementId: input.settlementId ?? null,
      disputeId: input.disputeId ?? null,
      invariantRunId: input.invariantRunId ?? null,
      amountCents: input.amountCents ?? null,
      summary: input.summary.trim(),
      payloadJson: input.payload === undefined ? null : JSON.stringify(input.payload),
      sourceKey: input.sourceKey,
      status: "open",
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "cod_ops_alert.source_key")) {
      const [existing] = await db
        .select()
        .from(codOpsAlert)
        .where(eq(codOpsAlert.sourceKey, input.sourceKey));
      return { alert: existing!, created: false };
    }
    throw error;
  }

  const [alert] = await db.select().from(codOpsAlert).where(eq(codOpsAlert.id, id));
  return { alert: alert!, created: true };
}

// ------------------------------------------------------------ outbox mapping

interface AmountMismatchPayload {
  parcelId: string;
  /** Nullable on `cod_entry`, so never required — the summary falls back to ids. */
  awb: string | null;
  riderId: string;
  expectedCents: number;
  collectedCents: number;
  varianceCents: number;
}

interface CeilingBreachedPayload {
  riderId: string;
  liabilityCents: number;
  ceilingCents: number;
}

interface DepositVariancePayload {
  depositId: string;
  code: string;
  riderId: string;
  expectedCents: number;
  declaredCents: number;
  countedCents: number;
  varianceCents: number;
  declaredVarianceCents: number;
  reason: string | null;
}

interface StaleCollectionPayload {
  entryId: string;
  /** Nullable on `cod_entry`, so never required. */
  awb: string | null;
  riderId: string;
  amountCents: number;
  ageHours: number;
}

interface InvariantBreachedPayload {
  runId: string;
  breachCount: number;
  breaches: { kind: string; riderId?: string; detail: string; amountCents: number }[];
}

interface SettlementApprovedPayload {
  settlementId: string;
  code: string;
  merchantId: string;
  merchantName: string;
  netCents: number;
  payoutDate: string;
  approvedByName: string;
}

interface SettlementPaidPayload {
  settlementId: string;
  code: string;
  merchantId: string;
  merchantName: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  utr: string;
  lineCount: number;
}

interface DisputeOpenedPayload {
  disputeId: string;
  merchantId?: string | null;
  parcelId?: string | null;
  awb?: string | null;
  amountCents?: number | null;
  reason?: string | null;
  /** Human case code (DSP…/CLM…). Older payloads may lack it. */
  code?: string | null;
  /** Whether the case raised a settlement hold. */
  held?: boolean | null;
}

/** Topics this module owns. `handle()` in the worker delegates exactly these. */
export const ALERT_TOPICS = [
  "cod.amount_mismatch",
  "cod.ceiling_breached",
  "cod.deposit_variance",
  "cod.stale_collection",
  "cod.invariant_breached",
  "cod.settlement_approved",
  "cod.settlement_paid",
  "cod.dispute_opened",
] as const;
export type AlertTopic = (typeof ALERT_TOPICS)[number];

export function isAlertTopic(topic: string): topic is AlertTopic {
  return (ALERT_TOPICS as readonly string[]).includes(topic);
}

/**
 * Turn one drained `cod.*` outbox job into an alert row.
 *
 * Called from `jobs/worker.ts`. It throws on an unmapped topic so a new
 * `cod.*` topic added without a case here dead-letters loudly instead of
 * vanishing — the failure mode that produced this file in the first place.
 *
 * `now` is injectable so a probe can pin the date-stamped dedupe keys.
 */
/**
 * Parse one drained job's payload, or refuse it.
 *
 * WHY THIS EXISTS. The first cut did `JSON.parse(payloadJson) as XPayload` in
 * every case and trusted the cast. A probe enqueued the string `"not json at
 * all"` — valid JSON, wrong shape — and the handler happily wrote an alert
 * reading "undefined: rider collected Rs. NaN against an expected Rs. NaN"
 * under the dedupe key `amount_mismatch:undefined`, then marked the job done.
 * That is worse than the dead-letter bug this file was written to fix: a
 * fabricated alert occupies the sourceKey the real escalation needs, so the
 * genuine one is silently swallowed as a duplicate forever after.
 *
 * So the shape is checked, and a payload missing the fields its summary and
 * dedupe key are built from throws. The job goes back to `pending` with the
 * reason on the row and dead-letters after five attempts — loud, inspectable,
 * and with nothing written to the worklist.
 */
function parsePayload<T>(topic: string, payloadJson: string, required: (keyof T & string)[]): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    fail(
      "BAD_REQUEST",
      problem("alert-payload-unparseable", "Alert payload is not JSON", 422, `${topic}: payload is not JSON.`, {
        topic,
      }),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(
      "BAD_REQUEST",
      problem(
        "alert-payload-invalid",
        "Alert payload is not an object",
        422,
        `${topic}: expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
        { topic },
      ),
    );
  }
  const row = parsed as Record<string, unknown>;
  const missing = required.filter((k) => row[k] === undefined || row[k] === null);
  if (missing.length > 0) {
    fail(
      "BAD_REQUEST",
      problem(
        "alert-payload-invalid",
        "Alert payload is missing fields",
        422,
        `${topic}: payload is missing ${missing.join(", ")}.`,
        { topic, missing },
      ),
    );
  }
  return parsed as T;
}

export async function recordOutboxAlert(
  topic: string,
  payloadJson: string,
  now: Date = new Date(),
): Promise<{ alert: CodOpsAlertRow; created: boolean }> {
  const day = colomboToday(now);

  switch (topic) {
    /**
     * A POD amount that does not match the booked COD. High: the variance is
     * real money and the parcel is already held out of settlement.
     */
    case "cod.amount_mismatch": {
      const p = parsePayload<AmountMismatchPayload>(topic, payloadJson, [
        "parcelId",
        "riderId",
        "collectedCents",
        "expectedCents",
        "varianceCents",
      ]);
      return raiseAlert({
        topic,
        kind: "amount_mismatch",
        severity: "high",
        audience: "finance",
        // One per parcel, matching the hold's own key — an offline retry of the
        // same POD is the same problem.
        sourceKey: `amount_mismatch:${p.parcelId}`,
        summary: `${p.awb ?? p.parcelId}: rider collected ${formatLkr(p.collectedCents)} against an expected ${formatLkr(p.expectedCents)} — ${formatLkr(Math.abs(p.varianceCents))} ${p.varianceCents > 0 ? "over" : "short"}. Parcel is held from settlement.`,
        payload: p,
        parcelId: p.parcelId,
        awb: p.awb,
        riderId: p.riderId,
        amountCents: p.varianceCents,
      });
    }

    /**
     * §8 / §15 q9: a rider past the Rs. 50,000 ceiling is blocked from further
     * dispatch. High, and ops not finance: it strands parcels on a shift, and
     * only ops can send the rider to a deposit point.
     *
     * Dated dedupe key — the rider is over the ceiling on every subsequent
     * scan of the shift, and that is one problem, not twenty.
     */
    case "cod.ceiling_breached": {
      const p = parsePayload<CeilingBreachedPayload>(topic, payloadJson, ["riderId", "liabilityCents", "ceilingCents"]);
      return raiseAlert({
        topic,
        kind: "ceiling_breached",
        severity: "high",
        audience: "ops",
        sourceKey: `ceiling_breached:${p.riderId}:${day}`,
        summary: `Rider ${p.riderId} is holding ${formatLkr(p.liabilityCents)} in cash, past the ${formatLkr(p.ceilingCents)} ceiling. Further dispatch is blocked until they deposit.`,
        payload: p,
        riderId: p.riderId,
        amountCents: p.liabilityCents,
      });
    }

    /**
     * Counted cash ≠ collections behind the deposit. High: the parcels in that
     * deposit are held, and the gap is either a miscount or a shortfall.
     */
    case "cod.deposit_variance": {
      const p = parsePayload<DepositVariancePayload>(topic, payloadJson, ["depositId", "code", "riderId", "countedCents", "expectedCents", "declaredCents", "varianceCents", "declaredVarianceCents"]);
      const gap = p.varianceCents !== 0 ? p.varianceCents : p.declaredVarianceCents;
      return raiseAlert({
        topic,
        kind: "deposit_variance",
        severity: "high",
        audience: "finance",
        sourceKey: `deposit_variance:${p.depositId}`,
        summary: `Deposit ${p.code} (rider ${p.riderId}) counted ${formatLkr(p.countedCents)} against ${formatLkr(p.expectedCents)} of collections, declared ${formatLkr(p.declaredCents)} — ${formatLkr(Math.abs(gap))} ${gap < 0 ? "short" : "over"}.${p.reason ? ` Reason given: ${p.reason}` : ""}`,
        payload: p,
        depositId: p.depositId,
        riderId: p.riderId,
        amountCents: gap,
      });
    }

    /**
     * §8's second control: cash collected but not deposited inside 48h.
     * Medium — it is not yet a loss, it is a rider who has not banked.
     *
     * Dated key: the nightly job re-reports the same entry every night it is
     * still stale, and the ops desk wants today's list, not a growing pile of
     * duplicates for one parcel.
     */
    case "cod.stale_collection": {
      const p = parsePayload<StaleCollectionPayload>(topic, payloadJson, [
        "entryId",
        "riderId",
        "amountCents",
        "ageHours",
      ]);
      return raiseAlert({
        topic,
        kind: "stale_collection",
        severity: "medium",
        audience: "ops",
        sourceKey: `stale_collection:${p.entryId}:${day}`,
        summary: `${formatLkr(p.amountCents)} collected on ${p.awb ?? p.entryId} by rider ${p.riderId} has not been deposited in ${Math.floor(p.ageHours)}h (limit 48h).`,
        payload: p,
        entryId: p.entryId,
        awb: p.awb,
        riderId: p.riderId,
        amountCents: p.amountCents,
      });
    }

    /**
     * The nightly balance invariant found a breach. High and unconditional:
     * per §8 a negative account or a non-zero ledger sum is impossible by
     * design, so its existence means something wrote outside this module.
     */
    case "cod.invariant_breached": {
      const p = parsePayload<InvariantBreachedPayload>(topic, payloadJson, ["runId", "breachCount", "breaches"]);
      if (!Array.isArray(p.breaches)) {
        fail(
          "BAD_REQUEST",
          problem("alert-payload-invalid", "Alert payload is malformed", 422, `${topic}: breaches must be an array.`, {
            topic,
          }),
        );
      }
      const first = p.breaches[0];
      return raiseAlert({
        topic,
        kind: "invariant_breached",
        severity: "high",
        audience: "finance",
        // One per run: a run is already one nightly pass over the whole book.
        sourceKey: `invariant_breached:${p.runId}`,
        summary: `Nightly COD invariant run ${p.runId} found ${p.breachCount} breach(es)${first ? ` — first: ${first.kind}, ${first.detail}` : ""}`,
        payload: p,
        invariantRunId: p.runId,
        riderId: first?.riderId ?? null,
        amountCents: first?.amountCents ?? null,
      });
    }

    /**
     * Informational finance activity: a run cleared approval and is queued for
     * the payout file. Recorded so the finance feed has a durable trail of who
     * approved what, independent of `audit_log`.
     */
    case "cod.settlement_approved": {
      const p = parsePayload<SettlementApprovedPayload>(topic, payloadJson, ["settlementId", "code", "merchantId", "merchantName", "netCents", "payoutDate", "approvedByName"]);
      return raiseAlert({
        topic,
        kind: "settlement_approved",
        severity: "low",
        audience: "finance",
        actionRequired: false,
        sourceKey: `settlement_approved:${p.settlementId}`,
        summary: `Settlement ${p.code} for ${p.merchantName} approved by ${p.approvedByName} — ${formatLkr(p.netCents)} due on ${p.payoutDate}.`,
        payload: p,
        settlementId: p.settlementId,
        merchantId: p.merchantId,
        amountCents: p.netCents,
      });
    }

    /** Informational: money left the bank. See the DEFERRED note in the header. */
    case "cod.settlement_paid": {
      const p = parsePayload<SettlementPaidPayload>(topic, payloadJson, ["settlementId", "code", "merchantId", "merchantName", "netCents", "deductionsCents", "lineCount", "utr"]);
      return raiseAlert({
        topic,
        kind: "settlement_paid",
        severity: "low",
        audience: "finance",
        actionRequired: false,
        sourceKey: `settlement_paid:${p.settlementId}`,
        summary: `Settlement ${p.code} paid to ${p.merchantName}: ${formatLkr(p.netCents)} net of ${formatLkr(p.deductionsCents)} deductions across ${p.lineCount} line(s), UTR ${p.utr}.`,
        payload: p,
        settlementId: p.settlementId,
        merchantId: p.merchantId,
        amountCents: p.netCents,
      });
    }

    /** Raised by disputes.ts openDispute(); finance works the queue. */
    case "cod.dispute_opened": {
      const p = parsePayload<DisputeOpenedPayload>(topic, payloadJson, ["disputeId"]);
      const raised = await raiseAlert({
        topic,
        kind: "dispute_opened",
        severity: "medium",
        audience: "finance",
        sourceKey: `dispute_opened:${p.disputeId}`,
        summary: `Dispute ${p.code ?? p.disputeId} opened${p.awb ? ` on ${p.awb}` : ""}${
          p.amountCents ? ` for ${formatLkr(p.amountCents)}` : ""
        }${p.reason ? `: ${p.reason}` : ""}.${p.held ? " The parcel's payout is held until it closes." : ""}`,
        payload: p,
        disputeId: p.disputeId,
        merchantId: p.merchantId ?? null,
        parcelId: p.parcelId ?? null,
        awb: p.awb ?? null,
        amountCents: p.amountCents ?? null,
      });
      // The outbox drains after the request: a case decided or withdrawn
      // before the worker got here must not leave a live alert behind.
      const [dispute] = await db
        .select({ status: codDispute.status, code: codDispute.code })
        .from(codDispute)
        .where(eq(codDispute.id, p.disputeId));
      if (dispute && !["open", "investigating"].includes(dispute.status)) {
        await closeDisputeAlerts(p.disputeId, `${dispute.code} was already ${dispute.status} when this alert was raised.`, null);
      }
      return raised;
    }

    default:
      throw new Error(`cod alerts: no mapping for topic ${topic}`);
  }
}

// --------------------------------------------------------------- the worklist

export interface ListAlertsFilter {
  status?: AlertStatus | AlertStatus[];
  kind?: AlertKind;
  audience?: AlertAudience;
  riderId?: string;
  merchantId?: string;
  /** Only the rows a desk has to work. Drops the informational records. */
  actionRequiredOnly?: boolean;
  limit?: number;
  offset?: number;
}

function alertWhere(filter: ListAlertsFilter): SQL | undefined {
  const where: SQL[] = [];
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    where.push(inArray(codOpsAlert.status, statuses));
  }
  if (filter.kind) where.push(eq(codOpsAlert.kind, filter.kind));
  if (filter.audience) where.push(eq(codOpsAlert.audience, filter.audience));
  if (filter.riderId) where.push(eq(codOpsAlert.riderId, filter.riderId));
  if (filter.merchantId) where.push(eq(codOpsAlert.merchantId, filter.merchantId));
  if (filter.actionRequiredOnly) where.push(eq(codOpsAlert.actionRequired, true));
  return where.length ? and(...where) : undefined;
}

export async function listAlerts(filter: ListAlertsFilter = {}): Promise<CodOpsAlertRow[]> {
  return db
    .select()
    .from(codOpsAlert)
    .where(alertWhere(filter))
    .orderBy(desc(codOpsAlert.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500))
    .offset(filter.offset ?? 0);
}

/** One page plus the filtered total (§11 server-side paging). */
export async function alertPage(
  filter: ListAlertsFilter,
): Promise<{ rows: CodOpsAlertRow[]; total: number }> {
  const [rows, [count]] = await Promise.all([
    listAlerts(filter),
    db.select({ n: sql<number>`count(*)` }).from(codOpsAlert).where(alertWhere(filter)),
  ]);
  return { rows, total: Number(count?.n ?? 0) };
}

/** Counts for the ops/finance dashboard badge. Open work only. */
export async function alertCounts(): Promise<{
  open: number;
  acknowledged: number;
  highOpen: number;
  byKind: Record<string, number>;
}> {
  const rows = await db
    .select()
    .from(codOpsAlert)
    .where(inArray(codOpsAlert.status, ["open", "acknowledged"]));
  const live = rows.filter((r) => r.actionRequired);
  const byKind: Record<string, number> = {};
  for (const r of live) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return {
    open: live.filter((r) => r.status === "open").length,
    acknowledged: live.filter((r) => r.status === "acknowledged").length,
    highOpen: live.filter((r) => r.status === "open" && r.severity === "high").length,
    byKind,
  };
}

export async function getAlert(id: string): Promise<CodOpsAlertRow> {
  const [row] = await db.select().from(codOpsAlert).where(eq(codOpsAlert.id, id));
  if (!row) errors.notFound(`Alert ${id}`);
  return row!;
}

/** "Someone is on it." Does not close anything. */
export async function acknowledgeAlert(
  id: string,
  actor?: Principal | null,
): Promise<CodOpsAlertRow> {
  const row = await getAlert(id);
  if (row.status === "resolved") {
    fail(
      "CONFLICT",
      problem(
        "alert-resolved",
        "Alert already resolved",
        409,
        `Alert ${id} was resolved on ${row.resolvedAt?.toISOString() ?? "an earlier date"} and cannot be acknowledged.`,
      ),
    );
  }
  if (row.status === "acknowledged") return row;

  await db
    .update(codOpsAlert)
    .set({
      status: "acknowledged",
      acknowledgedAt: new Date(),
      acknowledgedById: actor?.userId ?? null,
      acknowledgedByName: actor?.name ?? null,
    })
    .where(eq(codOpsAlert.id, id));

  await writeAudit({
    entity: "cod_ops_alert",
    entityId: id,
    action: "cod.alert_acknowledged",
    actor,
    before: { status: row.status },
    after: { status: "acknowledged" },
  });
  return getAlert(id);
}

/**
 * Close it. A note is mandatory for the same reason clearing a hold needs one
 * (§8): an escalation about money is never closed without a stated reason.
 */
export async function resolveAlert(
  id: string,
  note: string,
  actor?: Principal | null,
): Promise<CodOpsAlertRow> {
  if (!note?.trim()) {
    fail(
      "BAD_REQUEST",
      problem(
        "resolution-note-required",
        "Resolution note required",
        422,
        "Say what was done. A money escalation is never closed silently.",
      ),
    );
  }
  const row = await getAlert(id);
  if (row.status === "resolved") {
    fail(
      "CONFLICT",
      problem(
        "alert-resolved",
        "Alert already resolved",
        409,
        `Alert ${id} is already resolved: ${row.resolutionNote ?? "(no note)"}`,
      ),
    );
  }

  await db
    .update(codOpsAlert)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
      resolvedById: actor?.userId ?? null,
      resolvedByName: actor?.name ?? null,
      resolutionNote: note.trim(),
    })
    .where(eq(codOpsAlert.id, id));

  await writeAudit({
    entity: "cod_ops_alert",
    entityId: id,
    action: "cod.alert_resolved",
    actor,
    before: { status: row.status },
    after: { status: "resolved", resolutionNote: note.trim() },
  });
  return getAlert(id);
}

/**
 * Close the live alerts that point at a dispute once the case itself closes.
 *
 * The dispute queue is the worklist for a case; the `dispute_opened` alert is
 * only the doorbell. Without this, every decided or withdrawn case kept an
 * open alert and the finance alert count only ever grew.
 */
export async function closeDisputeAlerts(
  disputeId: string,
  note: string,
  actor: Principal | null,
): Promise<number> {
  const live = await db
    .select({ id: codOpsAlert.id, status: codOpsAlert.status })
    .from(codOpsAlert)
    .where(and(eq(codOpsAlert.disputeId, disputeId), inArray(codOpsAlert.status, ["open", "acknowledged"])));
  for (const row of live) {
    await db
      .update(codOpsAlert)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        resolvedById: actor?.userId ?? null,
        resolvedByName: actor?.name ?? null,
        resolutionNote: note,
      })
      .where(eq(codOpsAlert.id, row.id));
    await writeAudit({
      entity: "cod_ops_alert",
      entityId: row.id,
      action: "cod.alert_resolved",
      actor,
      before: { status: row.status },
      after: { status: "resolved", resolutionNote: note, closedWith: disputeId },
    });
  }
  return live.length;
}
