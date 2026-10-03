import { and, asc, count, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import { db } from "../../database";
import {
  deliveryAttempt,
  deliveryOtp,
  deliveryPod,
  runsheet,
  runsheetItem,
} from "../../database/schema/delivery";
import { prefixedId } from "../../shared/ulid";
import { insertWithFreshCode, mintDocumentCode } from "../../shared/codes";
import { errors, fail, problem } from "../../shared/errors";
import { enqueue } from "../../shared/outbox";
import { hashSecret, isGlobalScope, verifySecret, type Principal } from "../../shared/auth";
import { distanceMetres } from "../../shared/geo";
import { formatLkr } from "../../shared/money";
import { codLine as codLineFor } from "../notifications/service";
import { normaliseLkPhone, sendSms } from "../../shared/sms";
import { colomboToday, formatLkDate } from "../../shared/time";
import {
  getParcelByAwb,
  getParcelById,
  incrementDeliveryAttempts,
  parcelsAwaiting,
  resolveAwbs,
  transitionParcel,
  type ParcelRow,
} from "../parcels/service";
import { MAX_DELIVERY_ATTEMPTS, shouldAutoRto } from "../parcels/state-machine";
import { getBranch, getUserById } from "../identity/service";
import { getMerchant } from "../merchants/service";
import {
  assertDispatchAllowed,
  collectionForParcel,
  recordCollection,
} from "../cod/service";
import { requireReasonCode, type ReasonCodeRow } from "./reasons";
import {
  autoRto,
  liveNdrForParcel,
  openOrUpdateNdr,
  reasonRto,
  resolveNdrForParcel,
} from "./ndr";
import { SETTING_KEYS, settingValue } from "../settings/service";
import { isDevelopment } from "../../shared/env";

/**
 * MODULE: delivery — runsheets, route order, doorstep attempts, proof of
 * delivery and the delivery OTP (PROJECT.md §10 M3).
 *
 * §4: the ONLY files that read `delivery_*` tables are this one, ./ndr.ts and
 * ./reasons.ts. Parcels, merchants and users are reached through their own
 * services — never SELECTed here.
 *
 * The two invariants this file exists to protect (§1, §6):
 *
 *   1. A parcel is never marked Delivered without a POD row. The POD is
 *      written first, in the same call, and the transition is refused if the
 *      merchant's required method is missing. There is no code path that
 *      produces Delivered without proof.
 *   2. Money reconciles to the cent. A COD parcel cannot be delivered unless
 *      the collected amount equals the amount owed, exactly, in integer cents.
 */

export type RunsheetRow = typeof runsheet.$inferSelect;
export type RunsheetItemRow = typeof runsheetItem.$inferSelect;
export type AttemptRow = typeof deliveryAttempt.$inferSelect;
export type PodRow = typeof deliveryPod.$inferSelect;

/** Statuses a parcel may be in to go onto a runsheet. */
const RUNSHEET_ELIGIBLE = ["AtDestHub", "DeliveryAttempted", "OnHold"] as const;

/** How long a delivery OTP is valid (§9: SMS-only, resend-and-expire). */
// §10 M5: doorstep OTP validity is settings.delivery_otp_ttl_minutes (default 15).
/** Wrong-code attempts before the challenge locks. */
const OTP_MAX_ATTEMPTS = 5;
/** How long a verified OTP stays usable for the delivery it was verified for. */
const OTP_GRACE_MINUTES = 30;

// ------------------------------------------------------------------- scoping

function assertRunsheetVisible(row: RunsheetRow, scope: Principal): void {
  if (isGlobalScope(scope.role)) return;
  if (scope.role === "rider") {
    // §7's conflict policy: a runsheet belongs to exactly one rider, and
    // another rider reaching it is refused rather than shown a read-only copy.
    if (row.riderId !== scope.userId) {
      errors.forbidden("This runsheet is assigned to another rider.");
    }
    return;
  }
  if (scope.role === "merchant") errors.forbidden("Runsheets are not visible to merchants.");
  if (row.branchId !== scope.branchId) {
    errors.forbidden("This runsheet belongs to another branch.");
  }
}

function mintRunsheetCode(runDate: string): string {
  return mintDocumentCode("RS", runDate);
}

// ---------------------------------------------------------------- read paths

export async function getRunsheet(id: string): Promise<RunsheetRow | null> {
  const [row] = await db.select().from(runsheet).where(eq(runsheet.id, id));
  return row ?? null;
}

export interface ListRunsheetsInput {
  status?: ("draft" | "dispatched" | "closed" | "cancelled")[];
  runDate?: string;
  riderId?: string;
  limit?: number;
}

function runsheetFilters(
  scope: Principal,
  input: ListRunsheetsInput & { search?: string },
): SQL[] {
  if (scope.role === "merchant") errors.forbidden("Runsheets are not visible to merchants.");
  const filters: SQL[] = [];
  if (input.status && input.status.length > 0) {
    filters.push(inArray(runsheet.status, input.status));
  }
  if (input.runDate) filters.push(eq(runsheet.runDate, input.runDate));
  if (input.riderId) filters.push(eq(runsheet.riderId, input.riderId));
  // A rider sees only their own runs. Asking for someone else's is refused
  // (§5: 403, never a silently re-scoped empty list).
  if (scope.role === "rider") {
    if (input.riderId && input.riderId !== scope.userId) {
      errors.forbidden("A rider may only read their own runsheets.");
    }
    filters.push(eq(runsheet.riderId, scope.userId));
  } else if (!isGlobalScope(scope.role)) filters.push(eq(runsheet.branchId, scope.branchId));
  const term = input.search?.trim();
  if (term) {
    const safe = term.replace(/[%_]/g, "");
    filters.push(or(like(runsheet.code, `%${safe.toUpperCase()}%`), like(runsheet.riderName, `%${safe}%`))!);
  }
  return filters;
}

export async function listRunsheets(scope: Principal, input: ListRunsheetsInput = {}) {
  const filters = runsheetFilters(scope, input);
  return db
    .select()
    .from(runsheet)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(runsheet.runDate), asc(runsheet.code))
    .limit(input.limit ?? 100);
}

/**
 * The ops runsheet register (§11: server-side pagination). Newest run date
 * first; within a day, by code. Same scope as listRunsheets.
 */
export async function pageRunsheets(
  scope: Principal,
  input: Omit<ListRunsheetsInput, "limit"> & { search?: string; page: number; pageSize: number },
) {
  const filters = runsheetFilters(scope, input);
  const where = filters.length > 0 ? and(...filters) : undefined;
  const pageSize = Math.min(Math.max(input.pageSize, 1), 100);
  const page = Math.max(input.page, 1);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(runsheet)
      .where(where)
      .orderBy(desc(runsheet.runDate), asc(runsheet.code))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(runsheet).where(where),
  ]);
  return { rows, total: totalRow?.value ?? 0, page, pageSize };
}

export interface RunsheetDetail {
  runsheet: RunsheetRow;
  hubName: string | null;
  items: (RunsheetItemRow & { status: string | null; podPolicy: string | null })[];
  /** Cash the rider is accountable for right now, in integer cents. */
  cash: { expectedCents: number; collectedCents: number; outstandingCents: number };
}

export async function getRunsheetDetail(
  id: string,
  scope: Principal,
): Promise<RunsheetDetail> {
  const row = await getRunsheet(id);
  if (!row) errors.notFound(`Runsheet ${id}`);
  assertRunsheetVisible(row!, scope);

  const items = await db
    .select()
    .from(runsheetItem)
    .where(eq(runsheetItem.runsheetId, id))
    .orderBy(asc(runsheetItem.seq));

  // Parcel status and the merchant's POD policy come from their own modules —
  // the rider's screen needs both to know which proof to capture.
  const enriched = [];
  for (const item of items) {
    const p = await getParcelById(item.parcelId);
    const merchant = p ? await getMerchant(p.merchantId) : null;
    enriched.push({
      ...item,
      status: p?.status ?? null,
      podPolicy: merchant?.podPolicy ?? null,
    });
  }

  const hub = await getBranch(row!.hubId);
  return {
    runsheet: row!,
    hubName: hub?.name ?? null,
    items: enriched,
    cash: {
      expectedCents: row!.codExpectedCents,
      collectedCents: row!.codCollectedCents,
      outstandingCents: row!.codExpectedCents - row!.codCollectedCents,
    },
  };
}

/**
 * The rider's own run for a date — what the mobile app opens to. Returns null
 * rather than 404: "no run today" is a normal answer, not an error.
 */
export async function myRunsheet(
  scope: Principal,
  runDate?: string,
): Promise<RunsheetDetail | null> {
  const date = runDate ?? colomboToday();
  const [row] = await db
    .select()
    .from(runsheet)
    .where(
      and(
        eq(runsheet.riderId, scope.userId),
        eq(runsheet.runDate, date),
        inArray(runsheet.status, ["draft", "dispatched"]),
      ),
    )
    .orderBy(desc(runsheet.createdAt))
    .limit(1);
  if (!row) return null;
  return getRunsheetDetail(row.id, scope);
}

/**
 * Parcels at this branch that are ready to be put on a run.
 *
 * Deliberately conservative: a parcel that has used all three attempts, or
 * whose last failure the reason flags say cannot be retried without an
 * instruction, is excluded with the reason why rather than silently dropped —
 * an ops user must be able to see what is stuck and why.
 */
export async function deliverableParcels(scope: Principal) {
  const rows = await parcelsAwaiting([...RUNSHEET_ELIGIBLE], scope, 300);
  const ready = [];
  const blocked: { awb: string; status: string; reason: string }[] = [];

  for (const p of rows) {
    const gate = await reattemptGate(p);
    if (gate.ok) {
      ready.push({
        id: p.id,
        awb: p.awb,
        status: p.status,
        consigneeName: p.consigneeName,
        consigneePhone: p.consigneePhone,
        destAddress: p.destAddress,
        destLat: p.destLat,
        destLng: p.destLng,
        codAmountCents: p.codAmountCents,
        deliveryAttempts: p.deliveryAttempts,
        merchantId: p.merchantId,
      });
    } else {
      blocked.push({ awb: p.awb, status: p.status, reason: gate.reason });
    }
  }
  return { ready, blocked };
}

/**
 * May this parcel go out again? The single place that rule lives.
 *
 * Three gates, in order: the §6 attempt ceiling; the reason code's
 * `allowsReattempt` flag; and — for a reason that needs an instruction — an
 * actual merchant answer on the live NDR.
 */
async function reattemptGate(p: ParcelRow): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (p.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
    return {
      ok: false,
      reason: `All ${MAX_DELIVERY_ATTEMPTS} delivery attempts used — this parcel must be returned.`,
    };
  }
  if (p.status === "AtDestHub") return { ok: true };

  const live = await liveNdrForParcel(p.id);
  if (!live) {
    // DeliveryAttempted or OnHold with no live report: ops moved it by hand.
    // Allow it — a human is already driving this parcel.
    return { ok: true };
  }

  if (live.lastReasonCode) {
    const reason = await requireReasonCode(live.lastReasonCode);
    if (!reason.allowsReattempt) {
      const instructed = live.merchantInstruction;
      if (instructed !== "reattempt" && instructed !== "address_change") {
        return {
          ok: false,
          reason: `"${reason.label}" needs a merchant instruction before another attempt. NDR ${live.id} is ${live.state}.`,
        };
      }
    }
  }
  if (p.status === "OnHold" && live.merchantInstruction === "hold") {
    return { ok: false, reason: "Held on merchant instruction." };
  }
  return { ok: true };
}

export async function attemptsForParcel(parcelId: string): Promise<AttemptRow[]> {
  return db
    .select()
    .from(deliveryAttempt)
    .where(eq(deliveryAttempt.parcelId, parcelId))
    .orderBy(asc(deliveryAttempt.ts));
}

export async function podForParcel(parcelId: string): Promise<PodRow | null> {
  const [row] = await db
    .select()
    .from(deliveryPod)
    .where(eq(deliveryPod.parcelId, parcelId))
    .orderBy(desc(deliveryPod.ts))
    .limit(1);
  return row ?? null;
}

/** Everything the ops board and the parcel drawer need about one parcel's delivery. */
export async function deliveryHistory(awb: string, scope: Principal) {
  const p = await getParcelByAwb(awb);
  if (!p) errors.notFound(`Parcel ${awb}`);
  if (scope.role === "merchant" && p!.merchantId !== scope.merchantId) {
    errors.notFound(`Parcel ${awb}`);
  }
  const attempts = await attemptsForParcel(p!.id);
  const pod = await podForParcel(p!.id);
  const ndrRow = await liveNdrForParcel(p!.id);
  return {
    awb: p!.awb,
    status: p!.status,
    attemptsUsed: p!.deliveryAttempts,
    attemptsAllowed: MAX_DELIVERY_ATTEMPTS,
    attempts,
    pod,
    ndr: ndrRow,
  };
}

export async function deliveryCounts(scope: Principal) {
  const today = colomboToday();
  // Filtered to today in SQL: a capped all-time list would drop today's runs
  // once the history outgrew the cap, and undercount without saying so.
  const todays = await listRunsheets(scope, { runDate: today, limit: 500 });
  return {
    runsheetsToday: todays.length,
    dispatched: todays.filter((s) => s.status === "dispatched").length,
    stopsPlanned: todays.reduce((n, s) => n + s.plannedCount, 0),
    delivered: todays.reduce((n, s) => n + s.deliveredCount, 0),
    failed: todays.reduce((n, s) => n + s.failedCount, 0),
    codExpectedCents: todays.reduce((n, s) => n + s.codExpectedCents, 0),
    codCollectedCents: todays.reduce((n, s) => n + s.codCollectedCents, 0),
  };
}

// ------------------------------------------------------------ build a run

export interface CreateRunsheetInput {
  riderId: string;
  /** YYYY-MM-DD, Asia/Colombo. Defaults to today (§9). */
  runDate?: string;
  /** Defaults to the rider's own branch. */
  hubId?: string;
}

export async function createRunsheet(
  input: CreateRunsheetInput,
  actor: Principal,
): Promise<RunsheetRow> {
  const rider = await getUserById(input.riderId);
  if (!rider) errors.notFound(`Rider ${input.riderId}`);
  if (rider!.role !== "rider") {
    errors.badRequest(`${rider!.name} is a ${rider!.role}, not a rider.`);
  }
  if (rider!.status !== "active") {
    errors.badRequest(`${rider!.name}'s account is ${rider!.status}.`);
  }
  if (!isGlobalScope(actor.role) && rider!.branchId !== actor.branchId) {
    errors.forbidden("That rider belongs to another branch.");
  }

  const runDate = input.runDate ?? colomboToday();
  const hubId = input.hubId ?? rider!.branchId;
  const hub = await getBranch(hubId);
  if (!hub) errors.notFound(`Hub ${hubId}`);

  // One live run per rider per day. A second one splits the rider's cash
  // accountability across two sheets, which §1's "money must reconcile"
  // makes unacceptable.
  const [existing] = await db
    .select()
    .from(runsheet)
    .where(
      and(
        eq(runsheet.riderId, input.riderId),
        eq(runsheet.runDate, runDate),
        inArray(runsheet.status, ["draft", "dispatched"]),
      ),
    )
    .limit(1);
  if (existing) {
    errors.conflict(
      `${rider!.name} already has runsheet ${existing.code} open for ${formatLkDate(runDate)}.`,
      { runsheetId: existing.id, code: existing.code, currentStatus: existing.status },
    );
  }

  const { result: [row] } = await insertWithFreshCode("delivery_runsheet", () => mintRunsheetCode(runDate), (code) => db
    .insert(runsheet)
    .values({
      id: prefixedId("rsh"),
      code,
      riderId: rider!.id,
      riderName: rider!.name,
      branchId: rider!.branchId,
      hubId,
      runDate,
      status: "draft",
      createdByName: actor.name,
    })
    .returning());

  return row!;
}

export interface AddToRunsheetLine {
  awb: string;
  verdict: "added" | "duplicate" | "unknown" | "rejected";
  reason?: string;
  seq?: number;
}

export interface AddToRunsheetResult {
  runsheet: RunsheetRow;
  lines: AddToRunsheetLine[];
  added: number;
}

/**
 * Bulk-add stops. One call carries the whole scan burst and comes back with a
 * verdict per label rather than failing the batch on the first stray — the same
 * contract as the M2 bag scan, because a rider loading a van scans fast and
 * must be told exactly which labels did not make it.
 */
export async function addToRunsheet(
  input: { runsheetId: string; awbs: string[] },
  actor: Principal,
): Promise<AddToRunsheetResult> {
  const sheet = await getRunsheet(input.runsheetId);
  if (!sheet) errors.notFound(`Runsheet ${input.runsheetId}`);
  assertRunsheetVisible(sheet!, actor);
  if (sheet!.status !== "draft") {
    errors.conflict(`Runsheet ${sheet!.code} is ${sheet!.status}; stops can only be added to a draft.`, {
      currentStatus: sheet!.status,
    });
  }

  const { found, unknown } = await resolveAwbs(input.awbs);
  const lines: AddToRunsheetLine[] = unknown.map((awb) => ({
    awb,
    verdict: "unknown" as const,
    reason: "No parcel with that AWB.",
  }));

  const existing = await db
    .select({ parcelId: runsheetItem.parcelId })
    .from(runsheetItem)
    .where(eq(runsheetItem.runsheetId, sheet!.id));
  const alreadyOn = new Set(existing.map((r) => r.parcelId));

  let added = 0;
  let codDelta = 0;

  for (const p of found) {
    if (alreadyOn.has(p.id)) {
      lines.push({ awb: p.awb, verdict: "duplicate", reason: "Already a stop on this run." });
      continue;
    }
    if (!(RUNSHEET_ELIGIBLE as readonly string[]).includes(p.status)) {
      lines.push({
        awb: p.awb,
        verdict: "rejected",
        reason: `Parcel is ${p.status} — only ${RUNSHEET_ELIGIBLE.join(", ")} can go on a run.`,
      });
      continue;
    }
    if (!isGlobalScope(actor.role) && p.branchId !== sheet!.branchId) {
      lines.push({
        awb: p.awb,
        verdict: "rejected",
        reason: "Parcel is accountable to another branch.",
      });
      continue;
    }
    const gate = await reattemptGate(p);
    if (!gate.ok) {
      lines.push({ awb: p.awb, verdict: "rejected", reason: gate.reason });
      continue;
    }

    await db.insert(runsheetItem).values({
      id: prefixedId("rsi"),
      runsheetId: sheet!.id,
      parcelId: p.id,
      awb: p.awb,
      // Insertion order until the route is optimised; optimiseRunsheet rewrites it.
      seq: alreadyOn.size + added + 1,
      state: "pending",
      attemptNo: p.deliveryAttempts,
      consigneeName: p.consigneeName,
      consigneePhone: p.consigneePhone,
      destAddress: p.destAddress,
      destLat: p.destLat,
      destLng: p.destLng,
      codAmountCents: p.codAmountCents,
    });
    alreadyOn.add(p.id);
    added += 1;
    codDelta += p.codAmountCents;
    lines.push({ awb: p.awb, verdict: "added" });
  }

  const [updated] = await db
    .update(runsheet)
    .set({
      plannedCount: sheet!.plannedCount + added,
      codExpectedCents: sheet!.codExpectedCents + codDelta,
      // Any change invalidates the stop order.
      optimisedAt: added > 0 ? null : sheet!.optimisedAt,
    })
    .where(eq(runsheet.id, sheet!.id))
    .returning();

  return { runsheet: updated!, lines, added };
}

export async function removeFromRunsheet(
  input: { runsheetId: string; awb: string; reason?: string | null },
  actor: Principal,
): Promise<{ runsheet: RunsheetRow; removed: boolean }> {
  const sheet = await getRunsheet(input.runsheetId);
  if (!sheet) errors.notFound(`Runsheet ${input.runsheetId}`);
  assertRunsheetVisible(sheet!, actor);

  const [item] = await db
    .select()
    .from(runsheetItem)
    .where(and(eq(runsheetItem.runsheetId, sheet!.id), eq(runsheetItem.awb, input.awb)))
    .limit(1);
  if (!item) errors.notFound(`${input.awb} on runsheet ${sheet!.code}`);
  if (item!.state !== "pending") {
    errors.conflict(`${input.awb} is already ${item!.state} on this run and cannot be removed.`, {
      state: item!.state,
    });
  }

  // Marked removed, never deleted: the fact that a parcel was loaded and then
  // taken off the van is part of its custody story.
  await db
    .update(runsheetItem)
    .set({ state: "removed" })
    .where(eq(runsheetItem.id, item!.id));

  const [updated] = await db
    .update(runsheet)
    .set({
      plannedCount: Math.max(0, sheet!.plannedCount - 1),
      codExpectedCents: Math.max(0, sheet!.codExpectedCents - item!.codAmountCents),
      optimisedAt: null,
    })
    .where(eq(runsheet.id, sheet!.id))
    .returning();

  return { runsheet: updated!, removed: true };
}

// ------------------------------------------------------- route-order (§10 M3)

export interface OptimiseResult {
  runsheet: RunsheetRow;
  method: string;
  totalMetres: number;
  ordered: { seq: number; awb: string; legMetres: number | null; located: boolean }[];
  /** Stops with no stored coordinates — appended at the end, in booking order. */
  unlocated: string[];
}

/**
 * Order the stops.
 *
 * KNOWN DEVIATION (§5 specifies PostGIS): this is a greedy nearest-neighbour
 * sweep in JavaScript over the microdegree points already stored on each
 * parcel, starting at the hub. It is not a shortest tour, it has no road
 * network, no turn restrictions and no traffic — it produces a sane order, and
 * `route_method` on the row says exactly which algorithm produced it so the
 * number is never mistaken for a routing-engine answer. Recorded in README's
 * deviations table.
 *
 * Stops with no coordinates cannot be swept, so they are appended at the end in
 * booking order rather than being dropped or guessed at.
 */
export async function optimiseRunsheet(
  runsheetId: string,
  actor: Principal,
): Promise<OptimiseResult> {
  const sheet = await getRunsheet(runsheetId);
  if (!sheet) errors.notFound(`Runsheet ${runsheetId}`);
  assertRunsheetVisible(sheet!, actor);

  const items = await db
    .select()
    .from(runsheetItem)
    .where(and(eq(runsheetItem.runsheetId, sheet!.id), eq(runsheetItem.state, "pending")))
    .orderBy(asc(runsheetItem.createdAt));

  const hub = await getBranch(sheet!.hubId);
  if (!hub) errors.notFound(`Hub ${sheet!.hubId}`);

  const located = items.filter((i) => i.destLat !== null && i.destLng !== null);
  const unlocated = items.filter((i) => i.destLat === null || i.destLng === null);

  const remaining = [...located];
  const ordered: OptimiseResult["ordered"] = [];
  let curLat = hub!.lat;
  let curLng = hub!.lng;
  let total = 0;
  let seq = 0;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestMetres = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;
      const d = distanceMetres(curLat, curLng, candidate.destLat!, candidate.destLng!);
      if (d < bestMetres) {
        bestMetres = d;
        bestIndex = i;
      }
    }
    const next = remaining.splice(bestIndex, 1)[0]!;
    seq += 1;
    total += bestMetres;
    await db
      .update(runsheetItem)
      .set({ seq, legMetres: bestMetres })
      .where(eq(runsheetItem.id, next.id));
    ordered.push({ seq, awb: next.awb, legMetres: bestMetres, located: true });
    curLat = next.destLat!;
    curLng = next.destLng!;
  }

  for (const item of unlocated) {
    seq += 1;
    await db
      .update(runsheetItem)
      .set({ seq, legMetres: null })
      .where(eq(runsheetItem.id, item.id));
    ordered.push({ seq, awb: item.awb, legMetres: null, located: false });
  }

  const method = "nearest_neighbour_js";
  const [updated] = await db
    .update(runsheet)
    .set({
      routeMethod: method,
      routeDistanceMetres: total,
      optimisedAt: new Date(),
    })
    .where(eq(runsheet.id, sheet!.id))
    .returning();

  return {
    runsheet: updated!,
    method,
    totalMetres: total,
    ordered,
    unlocated: unlocated.map((i) => i.awb),
  };
}

// ---------------------------------------------------------------- dispatch

export interface DispatchResult {
  runsheet: RunsheetRow;
  movedOut: string[];
  rejected: { awb: string; reason: string }[];
}

/**
 * Hand the run to the rider: every pending stop moves to OutForDelivery.
 *
 * OutForDelivery is an ops/transport/admin transition in §6's role table — a
 * rider does not put parcels on their own van, the hub does. The route is
 * optimised first if it has not been (or if stops changed since), because a
 * rider must never be handed an unordered list.
 */
export async function dispatchRunsheet(
  input: { runsheetId: string; notes?: string | null },
  actor: Principal,
): Promise<DispatchResult> {
  const sheet = await getRunsheet(input.runsheetId);
  if (!sheet) errors.notFound(`Runsheet ${input.runsheetId}`);
  assertRunsheetVisible(sheet!, actor);
  if (sheet!.status !== "draft") {
    errors.conflict(`Runsheet ${sheet!.code} is already ${sheet!.status}.`, {
      currentStatus: sheet!.status,
    });
  }

  const pending = await db
    .select()
    .from(runsheetItem)
    .where(and(eq(runsheetItem.runsheetId, sheet!.id), eq(runsheetItem.state, "pending")));
  if (pending.length === 0) {
    errors.badRequest(`Runsheet ${sheet!.code} has no stops to dispatch.`);
  }

  // §8: "Rider exceeds configurable limit → further dispatch blocked."
  await assertDispatchAllowed(sheet!.riderId, sheet!.riderName);

  if (!sheet!.optimisedAt) await optimiseRunsheet(sheet!.id, actor);

  const movedOut: string[] = [];
  const rejected: { awb: string; reason: string }[] = [];

  for (const item of pending) {
    try {
      const moved = await transitionParcel(
        {
          awbOrId: item.awb,
          to: "OutForDelivery",
          notes: `Runsheet ${sheet!.code}, rider ${sheet!.riderName}. ${input.notes ?? ""}`.trim(),
        },
        actor,
      );
      movedOut.push(item.awb);

      await enqueue("notify.dispatch", {
        templateKey: "parcel.out_for_delivery",
        parcelId: moved.parcel.id,
        awb: item.awb,
        merchantId: moved.parcel.merchantId,
        toPhone: item.consigneePhone,
        vars: {
          awb: item.awb,
          consigneeName: item.consigneeName,
          riderName: sheet!.riderName,
          // The OFD bodies interpolate {{codLine}} (a whole sentence that
          // disappears for a non-COD parcel), not a bare amount. Both are
          // passed so an admin editing the template can use either.
          codLine: codLineFor(item.codAmountCents),
          codAmount: item.codAmountCents > 0 ? formatLkr(item.codAmountCents) : "",
          trackUrl: `natex.lk/track/${item.awb}`,
        },
      });
    } catch (err) {
      // One bad parcel does not strand the whole van. The stop comes off the
      // run and the reason is reported back to the hub.
      rejected.push({ awb: item.awb, reason: err instanceof Error ? err.message : "Unknown error" });
      await db
        .update(runsheetItem)
        .set({ state: "removed" })
        .where(eq(runsheetItem.id, item.id));
    }
  }

  if (movedOut.length === 0) {
    errors.conflict(`No stop on ${sheet!.code} could be dispatched.`, { rejected });
  }

  const removedCod = pending
    .filter((i) => rejected.some((r) => r.awb === i.awb))
    .reduce((n, i) => n + i.codAmountCents, 0);

  const [updated] = await db
    .update(runsheet)
    .set({
      status: "dispatched",
      dispatchedAt: new Date(),
      plannedCount: movedOut.length,
      codExpectedCents: Math.max(0, sheet!.codExpectedCents - removedCod),
    })
    .where(eq(runsheet.id, sheet!.id))
    .returning();

  return { runsheet: updated!, movedOut, rejected };
}

// -------------------------------------------------------------- delivery OTP

export interface OtpRequestResult {
  challengeId: string;
  sentTo: string;
  expiresInMinutes: number;
  smsState: string;
  resendCount: number;
  /** Dev-only, and only when no gateway is configured — flagged, never hidden. */
  devCode?: string;
}

/**
 * Send the consignee a delivery OTP.
 *
 * §9: "OTP is SMS-only. No WhatsApp OTP, no voice fallback. If no DLR arrives,
 * fall back to resend-and-expire." So this bypasses the notification ladder
 * entirely and goes straight through shared/sms.ts — there is deliberately no
 * OTP template row in the notifications module.
 *
 * The code is stored as an argon2id hash: an ops user reading the database must
 * not be able to complete a delivery on a rider's behalf.
 */
export async function requestDeliveryOtp(
  input: { awb: string },
  actor: Principal,
): Promise<OtpRequestResult> {
  const p = await getParcelByAwb(input.awb);
  if (!p) errors.notFound(`Parcel ${input.awb}`);
  if (p!.status !== "OutForDelivery") {
    errors.conflict(`Parcel ${p!.awb} is ${p!.status}, not out for delivery.`, {
      currentStatus: p!.status,
    });
  }

  const phone = normaliseLkPhone(p!.consigneePhone);
  const code = (100000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 900000)).toString();

  // A live challenge is superseded, not duplicated — resend-and-expire (§9).
  const [live] = await db
    .select()
    .from(deliveryOtp)
    .where(eq(deliveryOtp.parcelId, p!.id))
    .orderBy(desc(deliveryOtp.createdAt))
    .limit(1);
  const resendCount =
    live && !live.consumedAt && live.expiresAt.getTime() > Date.now() ? live.resendCount + 1 : 0;

  const OTP_TTL_MINUTES = await settingValue(SETTING_KEYS.DELIVERY_OTP_TTL_MINUTES);
  const challengeId = prefixedId("dotp");
  const sms = await sendSms({
    to: phone,
    purpose: "otp",
    body: `NatEx delivery code for ${p!.awb}: ${code}. Give it to the courier. Valid ${OTP_TTL_MINUTES} minutes.`,
  });

  await db.insert(deliveryOtp).values({
    id: challengeId,
    parcelId: p!.id,
    awb: p!.awb,
    codeHash: await hashSecret(code),
    sentToPhone: phone,
    smsLogId: sms.logId,
    resendCount,
    requestedById: actor.userId,
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
  });

  const exposeCode = isDevelopment() && sms.state !== "sent";
  return {
    challengeId,
    sentTo: phone,
    expiresInMinutes: OTP_TTL_MINUTES,
    smsState: sms.state,
    resendCount,
    ...(exposeCode ? { devCode: code } : {}),
  };
}

export async function verifyDeliveryOtp(
  input: { awb: string; code: string },
  _actor: Principal,
): Promise<{ verified: boolean; challengeId: string; attemptsLeft: number }> {
  const p = await getParcelByAwb(input.awb);
  if (!p) errors.notFound(`Parcel ${input.awb}`);

  const [challenge] = await db
    .select()
    .from(deliveryOtp)
    .where(eq(deliveryOtp.parcelId, p!.id))
    .orderBy(desc(deliveryOtp.createdAt))
    .limit(1);
  if (!challenge) errors.notFound(`Delivery OTP for ${p!.awb}`);
  if (challenge!.consumedAt) {
    errors.conflict("That code has already been used.", { challengeId: challenge!.id });
  }
  if (challenge!.expiresAt.getTime() < Date.now()) {
    errors.conflict("That code has expired. Send a new one.", { challengeId: challenge!.id });
  }
  if (challenge!.attempts >= OTP_MAX_ATTEMPTS) {
    errors.forbidden("Too many wrong codes on this parcel. Send a new one.", {
      challengeId: challenge!.id,
    });
  }

  const ok = await verifySecret(input.code, challenge!.codeHash);
  const attempts = challenge!.attempts + 1;
  await db
    .update(deliveryOtp)
    .set({ attempts, consumedAt: ok ? new Date() : null })
    .where(eq(deliveryOtp.id, challenge!.id));

  if (!ok) {
    errors.badRequest("Wrong code.", {
      challengeId: challenge!.id,
      attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
    });
  }
  return {
    verified: true,
    challengeId: challenge!.id,
    attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
  };
}

// ------------------------------------------------------------- the doorstep

export interface RecordDeliveryInput {
  awb: string;
  /** Who physically took it — may not be the consignee. */
  receivedByName: string;
  receivedByRelation?: "self" | "family" | "neighbour" | "security" | "reception" | "other" | null;
  /** Defaults to the merchant's configured POD policy (§6). */
  method?: "otp" | "signature" | "photo" | null;
  signatureData?: string | null;
  photoUrl?: string | null;
  photoNote?: string | null;
  /** MONEY: integer cents. Must equal the amount owed, exactly (§1, §9). */
  codCollectedCents?: number | null;
  notes?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Client-minted ULID so an offline replay dedupes (§7). */
  clientId?: string | null;
  clientTs?: Date | null;
}

export interface RecordDeliveryResult {
  parcel: ParcelRow;
  attempt: AttemptRow;
  podId: string;
  deduped: boolean;
  codCollectedCents: number;
  /** The COLLECT ledger entry this delivery posted (null when no cash, or on a replay). */
  codEntryId?: string | null;
  /** The rider's position against the §8 cash ceiling after this collection. */
  cashCeiling?: { liabilityCents: number; ceilingCents: number; blocked: boolean } | null;
}

/**
 * Mark a parcel Delivered. The POD row is written FIRST, then the transition —
 * so a crash between the two leaves an orphan POD (harmless, visible) rather
 * than a Delivered parcel with no proof (a hole in the audit trail).
 *
 * §6's rules enforced here, in order:
 *   - the parcel must be OutForDelivery
 *   - the POD method the merchant requires must actually be present
 *   - an `otp` policy needs a *server-verified* challenge, not a rider's word
 *   - COD must reconcile to the cent before the parcel changes hands
 */
export async function recordDelivery(
  input: RecordDeliveryInput,
  actor: Principal,
): Promise<RecordDeliveryResult> {
  const p = await getParcelByAwb(input.awb);
  if (!p) errors.notFound(`Parcel ${input.awb}`);

  // §7 offline dedupe: the same client-minted id is never applied twice.
  if (input.clientId) {
    const [seen] = await db
      .select()
      .from(deliveryAttempt)
      .where(
        and(eq(deliveryAttempt.clientId, input.clientId), eq(deliveryAttempt.parcelId, p!.id)),
      )
      .limit(1);
    if (seen) {
      // A crash between the transition and the ledger write would otherwise
      // leave a Delivered COD parcel with no COLLECT forever, because every
      // retry lands here. The replay finishes the job; it never adds a second.
      if (p!.status === "Delivered" && p!.codAmountCents > 0 && !(await collectionForParcel(p!.id))) {
        await postCollection(p!, p!.codAmountCents, seen.riderId ?? actor.userId, input.clientId, actor);
      }
      return {
        parcel: p!,
        attempt: seen,
        podId: seen.podId ?? "",
        deduped: true,
        codCollectedCents: p!.codAmountCents,
      };
    }
  }

  if (p!.status !== "OutForDelivery") {
    errors.conflict(`Parcel ${p!.awb} is ${p!.status}, not out for delivery.`, {
      awb: p!.awb,
      currentStatus: p!.status,
    });
  }
  if (!input.receivedByName.trim()) {
    errors.badRequest("A delivery needs the name of the person who took the parcel.");
  }

  const merchant = await getMerchant(p!.merchantId);
  const policy = (merchant?.podPolicy ?? "signature") as "otp" | "signature" | "photo";
  const method = input.method ?? policy;

  // §6: "Delivered requires POD: signature or OTP or photo, configurable per
  // merchant." A rider may capture MORE than the policy asks for, never less.
  if (method !== policy) {
    errors.badRequest(
      `${merchant?.name ?? "This merchant"} requires ${policy} proof of delivery, not ${method}.`,
      { requiredMethod: policy, suppliedMethod: method },
    );
  }

  let otpChallengeId: string | null = null;
  let otpVerified = false;

  if (method === "otp") {
    const [challenge] = await db
      .select()
      .from(deliveryOtp)
      .where(eq(deliveryOtp.parcelId, p!.id))
      .orderBy(desc(deliveryOtp.createdAt))
      .limit(1);
    if (!challenge?.consumedAt) {
      errors.badRequest(
        `${p!.awb} needs a verified delivery OTP before it can be marked delivered.`,
        { requiredMethod: "otp" },
      );
    }
    if (challenge!.consumedAt!.getTime() < Date.now() - OTP_GRACE_MINUTES * 60_000) {
      errors.badRequest(
        `The verified OTP for ${p!.awb} is older than ${OTP_GRACE_MINUTES} minutes. Verify again.`,
      );
    }
    otpChallengeId = challenge!.id;
    otpVerified = true;
  }
  if (method === "signature" && !input.signatureData?.trim()) {
    errors.badRequest(`${p!.awb} needs a captured signature.`, { requiredMethod: "signature" });
  }
  if (method === "photo" && !input.photoUrl?.trim()) {
    errors.badRequest(`${p!.awb} needs a doorstep photo.`, { requiredMethod: "photo" });
  }
  // Evidence must be an object this server issued an upload slot for, under
  // THIS parcel's prefix (delivery.podPhotoUpload). A pasted URL, or another
  // parcel's photo, is not proof of this doorstep.
  if (method === "photo" && !input.photoUrl!.trim().startsWith(`s3:pod/${p!.awb}/`)) {
    errors.badRequest(`${p!.awb}: the doorstep photo must be uploaded for this parcel.`, {
      requiredMethod: "photo",
    });
  }

  // §1: "money must reconcile to the cent". Integer cents, exact equality.
  const collected = input.codCollectedCents ?? 0;
  if (p!.codAmountCents > 0 && collected !== p!.codAmountCents) {
    errors.badRequest(
      `COD on ${p!.awb} is ${formatLkr(p!.codAmountCents)} — ${formatLkr(collected)} was entered. The amounts must match exactly.`,
      { owedCents: p!.codAmountCents, collectedCents: collected },
    );
  }
  if (p!.codAmountCents === 0 && collected !== 0) {
    errors.badRequest(`${p!.awb} is not a COD parcel; no cash should be collected.`, {
      collectedCents: collected,
    });
  }
  // §7 "COD collected twice for one parcel → second entry rejected". Asked of
  // the cod module up front, so the refusal leaves no POD, attempt or
  // transition behind; the cod slug is what sync maps to `double_cod`.
  if (collected > 0) {
    const prior = await collectionForParcel(p!.id);
    if (prior) {
      fail(
        "CONFLICT",
        problem(
          "cod-already-collected",
          "COD already collected",
          409,
          `COD for ${p!.awb} is already recorded in the ledger (entry #${prior.seq}). A second collection cannot be posted.`,
          { awb: p!.awb, parcelId: p!.id, entryId: prior.id },
        ),
      );
    }
  }

  const [item] = await db
    .select()
    .from(runsheetItem)
    .where(and(eq(runsheetItem.parcelId, p!.id), eq(runsheetItem.state, "pending")))
    .orderBy(desc(runsheetItem.createdAt))
    .limit(1);

  const podId = prefixedId("pod");
  await db.insert(deliveryPod).values({
    id: podId,
    parcelId: p!.id,
    awb: p!.awb,
    method,
    receivedByName: input.receivedByName.trim(),
    receivedByRelation: input.receivedByRelation ?? "self",
    otpVerified,
    otpChallengeId,
    signatureData: input.signatureData ?? null,
    photoUrl: input.photoUrl ?? null,
    photoNote: input.photoNote ?? null,
    capturedById: actor.userId,
    capturedByName: actor.name,
    deviceId: actor.deviceId ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    clientId: input.clientId ?? null,
    ts: new Date(),
  });

  const attemptNo = p!.deliveryAttempts + 1;
  const [attempt] = await db
    .insert(deliveryAttempt)
    .values({
      id: prefixedId("att"),
      parcelId: p!.id,
      awb: p!.awb,
      runsheetId: item?.runsheetId ?? null,
      runsheetItemId: item?.id ?? null,
      attemptNo,
      outcome: "delivered",
      notes: input.notes ?? null,
      podId,
      riderId: actor.userId,
      riderName: actor.name,
      deviceId: actor.deviceId ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      clientId: input.clientId ?? null,
      clientTs: input.clientTs ?? null,
      ts: new Date(),
    })
    .returning();

  // Only now does the parcel change state — and this call locks the COD amount.
  const moved = await transitionParcel(
    {
      awbOrId: p!.awb,
      to: "Delivered",
      lat: input.lat,
      lng: input.lng,
      notes: `POD ${method}, received by ${input.receivedByName.trim()}${
        collected > 0 ? `, COD ${formatLkr(collected)} collected` : ""
      }.`,
      clientId: input.clientId,
    },
    actor,
    { podId },
  );

  if (item) {
    await db
      .update(runsheetItem)
      .set({ state: "delivered", attemptNo, settledAt: new Date() })
      .where(eq(runsheetItem.id, item.id));
    const sheet = await getRunsheet(item.runsheetId);
    if (sheet) {
      await db
        .update(runsheet)
        .set({
          deliveredCount: sheet.deliveredCount + 1,
          codCollectedCents: sheet.codCollectedCents + collected,
        })
        .where(eq(runsheet.id, sheet.id));
    }
  }

  // §8 checkpoint 1 — the cash is now the rider's liability. Written after the
  // transition (a refused transition must not leave money on the rider) and
  // after the runsheet tally, so a reader that sees the parcel Delivered sees
  // the run's cash with it. If this post fails, the parcel and run are already
  // settled and the deduped replay below repairs the missing COLLECT.
  const ledger = collected > 0 ? await postCollection(p!, collected, actor.userId, input.clientId, actor) : null;

  // A delivered parcel has no outstanding question for the merchant.
  await resolveNdrForParcel(p!.id, actor, "Delivered on a later attempt");

  await enqueue("notify.dispatch", {
    templateKey: "parcel.delivered",
    parcelId: p!.id,
    awb: p!.awb,
    merchantId: p!.merchantId,
    toPhone: p!.consigneePhone,
    vars: {
      awb: p!.awb,
      consigneeName: p!.consigneeName,
      receivedBy: input.receivedByName.trim(),
      date: formatLkDate(colomboToday()),
      codAmount: collected > 0 ? formatLkr(collected) : "",
    },
  });

  return {
    parcel: moved.parcel,
    attempt: attempt!,
    podId,
    deduped: false,
    codCollectedCents: collected,
    codEntryId: ledger?.entry.id ?? null,
    cashCeiling: ledger?.ceiling ?? null,
  };
}

/**
 * The delivery → ledger hand-off. Through the cod module's own checkpoint
 * function (§4: delivery never touches `cod_entry`). The branch is the one
 * accountable for the parcel at the doorstep — the delivering hub.
 */
async function postCollection(
  p: ParcelRow,
  amountCents: number,
  riderId: string,
  clientId: string | null | undefined,
  actor: Principal,
) {
  return recordCollection({
    parcelId: p.id,
    awb: p.awb,
    merchantId: p.merchantId,
    riderId,
    branchId: p.branchId,
    amountCents,
    expectedCents: p.codAmountCents,
    mode: "cash",
    clientId: clientId ? `dlv:${clientId}` : null,
    actor,
  });
}

export interface RecordFailureInput {
  awb: string;
  reasonCode: string;
  notes?: string | null;
  lat?: number | null;
  lng?: number | null;
  clientId?: string | null;
  clientTs?: Date | null;
}

export interface RecordFailureResult {
  parcel: ParcelRow;
  attempt: AttemptRow;
  reason: ReasonCodeRow;
  attemptsUsed: number;
  attemptsAllowed: number;
  /** True when this failure burned one of the three attempts. */
  countedAsAttempt: boolean;
  ndrId: string | null;
  /** Set when the parcel was turned back — automatically or by the reason code. */
  rtoId: string | null;
  deduped: boolean;
}

/**
 * Record a failed doorstep attempt and decide what happens next.
 *
 * The decision tree, straight from §6 and the reason code's flags:
 *
 *   reason.countsAsAttempt  → the parcel's attempt counter moves (a flood does
 *                             not cost the consignee an attempt)
 *   reason.triggersRto      → straight back, no NDR wait (a refusal is final)
 *   attempts >= 3           → automatic RTOInitiated, commanded by the system
 *                             principal because a rider may not raise an RTO
 *   otherwise               → the NDR queue, with a 24h SLA clock, and the
 *                             merchant is asked what to do
 */
export async function recordFailure(
  input: RecordFailureInput,
  actor: Principal,
): Promise<RecordFailureResult> {
  const p = await getParcelByAwb(input.awb);
  if (!p) errors.notFound(`Parcel ${input.awb}`);

  if (input.clientId) {
    const [seen] = await db
      .select()
      .from(deliveryAttempt)
      .where(
        and(eq(deliveryAttempt.clientId, input.clientId), eq(deliveryAttempt.parcelId, p!.id)),
      )
      .limit(1);
    if (seen) {
      const reason = await requireReasonCode(seen.reasonCode ?? input.reasonCode);
      const live = await liveNdrForParcel(p!.id);
      return {
        parcel: p!,
        attempt: seen,
        reason,
        attemptsUsed: p!.deliveryAttempts,
        attemptsAllowed: MAX_DELIVERY_ATTEMPTS,
        countedAsAttempt: reason.countsAsAttempt,
        ndrId: live?.id ?? null,
        rtoId: null,
        deduped: true,
      };
    }
  }

  if (p!.status !== "OutForDelivery") {
    errors.conflict(`Parcel ${p!.awb} is ${p!.status}, not out for delivery.`, {
      awb: p!.awb,
      currentStatus: p!.status,
    });
  }

  const reason = await requireReasonCode(input.reasonCode);

  const [item] = await db
    .select()
    .from(runsheetItem)
    .where(and(eq(runsheetItem.parcelId, p!.id), eq(runsheetItem.state, "pending")))
    .orderBy(desc(runsheetItem.createdAt))
    .limit(1);

  // A non-counting failure records the attempt ordinal it happened *at*, so the
  // append-only log reads in order without implying an attempt was consumed.
  const attemptNo = reason.countsAsAttempt ? p!.deliveryAttempts + 1 : p!.deliveryAttempts;

  const [attempt] = await db
    .insert(deliveryAttempt)
    .values({
      id: prefixedId("att"),
      parcelId: p!.id,
      awb: p!.awb,
      runsheetId: item?.runsheetId ?? null,
      runsheetItemId: item?.id ?? null,
      attemptNo,
      outcome: "failed",
      reasonCode: reason.code,
      reasonLabel: reason.label,
      notes: input.notes ?? null,
      riderId: actor.userId,
      riderName: actor.name,
      deviceId: actor.deviceId ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      clientId: input.clientId ?? null,
      clientTs: input.clientTs ?? null,
      ts: new Date(),
    })
    .returning();

  const attemptsUsed = reason.countsAsAttempt
    ? await incrementDeliveryAttempts(p!.id)
    : p!.deliveryAttempts;

  const moved = await transitionParcel(
    {
      awbOrId: p!.awb,
      to: "DeliveryAttempted",
      lat: input.lat,
      lng: input.lng,
      notes: `Attempt ${attemptNo}/${MAX_DELIVERY_ATTEMPTS} failed: ${reason.label}.${
        reason.countsAsAttempt ? "" : " Not counted — NatEx-side failure."
      } ${input.notes ?? ""}`.trim(),
      clientId: input.clientId,
    },
    actor,
  );

  if (item) {
    await db
      .update(runsheetItem)
      .set({ state: "failed", attemptNo, settledAt: new Date() })
      .where(eq(runsheetItem.id, item.id));
    const sheet = await getRunsheet(item.runsheetId);
    if (sheet) {
      await db
        .update(runsheet)
        .set({
          failedCount: sheet.failedCount + 1,
          // The rider is no longer carrying this parcel's cash.
          codExpectedCents: Math.max(0, sheet.codExpectedCents - item.codAmountCents),
        })
        .where(eq(runsheet.id, sheet.id));
    }
  }

  const { ndr: ndrRow, isNew } = await openOrUpdateNdr({
    parcel: moved.parcel,
    reason,
    attempts: attemptsUsed,
    actor,
  });

  let rtoId: string | null = null;
  // The parcel as the caller should see it. An RTO moves it on again past
  // DeliveryAttempted, so the post-RTO row replaces this snapshot below —
  // returning the pre-RTO one told a rider's screen the parcel was still
  // awaiting a decision when it had already been turned back.
  let parcelAfter = moved.parcel;
  const exhausted = shouldAutoRto(attemptsUsed);

  if (reason.triggersRto || exhausted) {
    const why = exhausted
      ? `All ${MAX_DELIVERY_ATTEMPTS} attempts used. Last failure: ${reason.label}.`
      : reason.label;
    const result = exhausted
      ? await autoRto(moved.parcel, why)
      : await reasonRto(moved.parcel, why, actor);
    rtoId = result.rto.id;
    parcelAfter = result.parcel;
  } else if (isNew && reason.notifyConsignee) {
    await enqueue("notify.dispatch", {
      templateKey: "parcel.delivery_failed",
      parcelId: p!.id,
      awb: p!.awb,
      merchantId: p!.merchantId,
      toPhone: p!.consigneePhone,
      vars: {
        awb: p!.awb,
        consigneeName: p!.consigneeName,
        attemptNo: attemptsUsed,
        reason: reason.label,
        trackUrl: `natex.lk/track/${p!.awb}`,
      },
    });
  }

  if (isNew) {
    const merchant = await getMerchant(p!.merchantId);
    await enqueue("notify.dispatch", {
      templateKey: "ndr.raised",
      parcelId: p!.id,
      awb: p!.awb,
      merchantId: p!.merchantId,
      toPhone: merchant?.contactPhone ?? null,
      vars: {
        awb: p!.awb,
        consigneeName: p!.consigneeName,
        reason: reason.label,
        attemptNo: attemptsUsed,
        slaDue: ndrRow.slaDueAt ? formatLkDate(colomboToday(ndrRow.slaDueAt)) : "tomorrow",
      },
    });
  }

  return {
    parcel: parcelAfter,
    attempt: attempt!,
    reason,
    attemptsUsed,
    attemptsAllowed: MAX_DELIVERY_ATTEMPTS,
    countedAsAttempt: reason.countsAsAttempt,
    ndrId: ndrRow.id,
    rtoId,
    deduped: false,
  };
}

// ---------------------------------------------------------- cancel a draft

/**
 * Abandon a run that never left the hub.
 *
 * A draft moves no parcel (dispatch is the only step that transitions stops to
 * OutForDelivery), so cancelling one is a bookkeeping act: every pending stop
 * is marked removed — never deleted, it is still part of the custody story —
 * and the run becomes `cancelled`, which frees the rider for a new run that
 * day (the one-live-run rule counts draft and dispatched only). Without this a
 * dispatch that failed halfway left the rider locked out until midnight.
 *
 * A dispatched run is refused: parcels are on the van, and the only way off it
 * is an outcome per stop or a forced close.
 */
export async function cancelRunsheet(
  input: { runsheetId: string; reason: string },
  actor: Principal,
): Promise<{ runsheet: RunsheetRow; released: string[] }> {
  const sheet = await getRunsheet(input.runsheetId);
  if (!sheet) errors.notFound(`Runsheet ${input.runsheetId}`);
  assertRunsheetVisible(sheet!, actor);
  if (sheet!.status !== "draft") {
    errors.conflict(
      `Runsheet ${sheet!.code} is ${sheet!.status}; only a draft can be cancelled.${
        sheet!.status === "dispatched" ? " Record an outcome for each stop, or close the run." : ""
      }`,
      { currentStatus: sheet!.status },
    );
  }

  const pending = await db
    .select({ id: runsheetItem.id, awb: runsheetItem.awb })
    .from(runsheetItem)
    .where(and(eq(runsheetItem.runsheetId, sheet!.id), eq(runsheetItem.state, "pending")));
  if (pending.length > 0) {
    await db
      .update(runsheetItem)
      .set({ state: "removed" })
      .where(and(eq(runsheetItem.runsheetId, sheet!.id), eq(runsheetItem.state, "pending")));
  }

  const [updated] = await db
    .update(runsheet)
    .set({ status: "cancelled", closedAt: new Date() })
    .where(and(eq(runsheet.id, sheet!.id), eq(runsheet.status, "draft")))
    .returning();
  if (!updated) {
    errors.conflict(`Runsheet ${sheet!.code} changed while it was being cancelled.`, {});
  }

  return { runsheet: updated!, released: pending.map((p) => p.awb) };
}

// ------------------------------------------------------------ close the run

export interface CloseRunsheetResult {
  runsheet: RunsheetRow;
  /** Stops that were still pending and were written off as TIME_EXHAUSTED. */
  unattempted: string[];
  cash: { expectedCents: number; collectedCents: number; varianceCents: number };
}

/**
 * Close the run at the end of the day.
 *
 * A run with pending stops cannot just be closed — that is exactly how a parcel
 * gets lost (§1). Either every stop is settled, or `force` records the
 * remainder as TIME_EXHAUSTED failures, which do NOT burn an attempt (it was
 * NatEx that ran out of day, not the consignee) and put each parcel into the
 * NDR queue where somebody has to see it.
 */
export async function closeRunsheet(
  input: { runsheetId: string; force?: boolean; notes?: string | null },
  actor: Principal,
): Promise<CloseRunsheetResult> {
  const sheet = await getRunsheet(input.runsheetId);
  if (!sheet) errors.notFound(`Runsheet ${input.runsheetId}`);
  assertRunsheetVisible(sheet!, actor);
  if (sheet!.status !== "dispatched") {
    errors.conflict(`Runsheet ${sheet!.code} is ${sheet!.status}, not dispatched.`, {
      currentStatus: sheet!.status,
    });
  }

  const pending = await db
    .select()
    .from(runsheetItem)
    .where(and(eq(runsheetItem.runsheetId, sheet!.id), eq(runsheetItem.state, "pending")));

  if (pending.length > 0 && !input.force) {
    errors.conflict(
      `Runsheet ${sheet!.code} still has ${pending.length} unattempted stop(s). Record an outcome for each, or close with force to write them off as "ran out of time".`,
      { pending: pending.map((i) => i.awb) },
    );
  }

  const unattempted: string[] = [];
  for (const item of pending) {
    await recordFailure(
      {
        awb: item.awb,
        reasonCode: "TIME_EXHAUSTED",
        notes: `Run ${sheet!.code} closed with this stop unattempted. ${input.notes ?? ""}`.trim(),
      },
      actor,
    );
    unattempted.push(item.awb);
  }

  const fresh = await getRunsheet(sheet!.id);
  const [updated] = await db
    .update(runsheet)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(runsheet.id, sheet!.id))
    .returning();

  return {
    runsheet: updated!,
    unattempted,
    cash: {
      expectedCents: fresh?.codExpectedCents ?? 0,
      collectedCents: fresh?.codCollectedCents ?? 0,
      varianceCents: (fresh?.codCollectedCents ?? 0) - (fresh?.codExpectedCents ?? 0),
    },
  };
}

// ------------------------------------------------- delta reads for §7 sync

/**
 * The rider's current assignment, small enough to send on every delta pull.
 *
 * §7's conflict policy for "runsheet reassigned while offline" is "client
 * discards stale runsheet, re-pulls on next sync" — which only works if the
 * client can tell staleness at a glance. So this returns the authoritative
 * runsheet id and a `revision` that changes whenever the work does: the client
 * compares both against what it holds and throws its copy away on a mismatch,
 * rather than trying to merge two versions of a day's work.
 *
 * Lives here rather than in modules/sync because §4 forbids another module
 * reading delivery_*.
 */
export async function runsheetAssignment(scope: Principal, runDate?: string) {
  const date = runDate ?? colomboToday();
  const [row] = await db
    .select()
    .from(runsheet)
    .where(
      and(
        eq(runsheet.riderId, scope.userId),
        eq(runsheet.runDate, date),
        inArray(runsheet.status, ["draft", "dispatched"]),
      ),
    )
    .orderBy(desc(runsheet.createdAt))
    .limit(1);
  if (!row) return null;

  const items = await db
    .select({
      awb: runsheetItem.awb,
      parcelId: runsheetItem.parcelId,
      seq: runsheetItem.seq,
      state: runsheetItem.state,
      codAmountCents: runsheetItem.codAmountCents,
    })
    .from(runsheetItem)
    .where(eq(runsheetItem.runsheetId, row.id))
    .orderBy(asc(runsheetItem.seq));

  return {
    runsheetId: row.id,
    code: row.code,
    status: row.status,
    runDate: row.runDate,
    // Any add, removal, delivery or failure moves one of these numbers, so a
    // client holding a different revision is holding stale work.
    revision: `${row.plannedCount}:${row.deliveredCount}:${row.failedCount}:${row.optimisedAt?.getTime() ?? 0}`,
    plannedCount: row.plannedCount,
    items,
  };
}

/**
 * Whether a parcel is still on this rider's active run — the check behind §7's
 * `stale_runsheet` conflict.
 *
 * Returns who the parcel now belongs to when it is not this rider's, so the
 * conflict record can say "reassigned to Kamal" instead of a bare refusal.
 */
export async function runsheetClaimFor(
  parcelId: string,
  riderId: string,
): Promise<{
  onThisRidersRun: boolean;
  runsheetId: string | null;
  assignedRiderId: string | null;
  assignedRiderName: string | null;
  itemState: string | null;
}> {
  const rows = await db
    .select({
      runsheetId: runsheet.id,
      riderId: runsheet.riderId,
      riderName: runsheet.riderName,
      status: runsheet.status,
      itemState: runsheetItem.state,
    })
    .from(runsheetItem)
    .innerJoin(runsheet, eq(runsheet.id, runsheetItem.runsheetId))
    .where(
      and(
        eq(runsheetItem.parcelId, parcelId),
        inArray(runsheet.status, ["draft", "dispatched", "closed"]),
      ),
    )
    .orderBy(desc(runsheet.createdAt))
    .limit(5);

  const mine = rows.find((r) => r.riderId === riderId);
  if (mine) {
    return {
      onThisRidersRun: true,
      runsheetId: mine.runsheetId,
      assignedRiderId: mine.riderId,
      assignedRiderName: mine.riderName,
      itemState: mine.itemState,
    };
  }
  const other = rows[0];
  return {
    onThisRidersRun: false,
    runsheetId: other?.runsheetId ?? null,
    assignedRiderId: other?.riderId ?? null,
    assignedRiderName: other?.riderName ?? null,
    itemState: other?.itemState ?? null,
  };
}

export async function runsheetCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(runsheet);
  return row?.value ?? 0;
}
