import { and, asc, count, desc, eq, inArray, like, lt, type SQL } from "drizzle-orm";
import { db } from "../../database";
import { deliveryPod, ndr, rto } from "../../database/schema/delivery";
import { prefixedId } from "../../shared/ulid";
import { errors } from "../../shared/errors";
import { enqueue } from "../../shared/outbox";
import { isGlobalScope, type Principal } from "../../shared/auth";
import { colomboToday, formatLkDate, hoursFromNow } from "../../shared/time";
import {
  getParcelByAwb,
  getParcelById,
  transitionParcel,
  updateDeliveryDetails,
  type ParcelRow,
} from "../parcels/service";
import { MAX_DELIVERY_ATTEMPTS } from "../parcels/state-machine";
import { getMerchant } from "../merchants/service";
import { requireReasonCode, type ReasonCodeRow } from "./reasons";

/**
 * MODULE: delivery — the NDR queue and the RTO flow (PROJECT.md §10 M3).
 *
 * Part of the delivery module, so it may read `delivery_*` tables (§4). It
 * reaches parcels and merchants only through their services.
 *
 * The NDR queue is the answer to §1's "a parcel must never be lost": a failed
 * delivery does not sit in a rider's bag waiting to be noticed. It becomes a
 * row here, with an SLA clock, that someone has to answer — reattempt, correct
 * the address, hold, or send it back. Nothing expires silently out of it.
 */

export type NdrRow = typeof ndr.$inferSelect;
export type RtoRow = typeof rto.$inferSelect;

/** §8: configurable per merchant later; 24 hours is the default answer window. */
const NDR_SLA_HOURS = 24;

/** States in which an NDR row is still somebody's work. */
const LIVE_NDR_STATES = ["open", "instructed", "reattempt_scheduled"] as const;

/**
 * The actor recorded for transitions the *system* commands rather than a
 * person: §6's "maximum 3 delivery attempts, then automatic RTOInitiated".
 *
 * A rider's third failure must turn the parcel back, but RTOInitiated is an
 * ops/admin transition (§6 role table) and a rider principal would — correctly
 * — be refused. Rather than widen the role table and let riders raise RTOs by
 * hand, the automatic rule runs as this clearly-labelled synthetic principal.
 * Every parcel_event and audit row it writes says "NatEx system (automatic)",
 * so an auto-RTO is never mistaken for a human decision.
 */
function systemActor(branchId: string): Principal {
  return {
    userId: "system",
    name: "NatEx system (automatic)",
    role: "ops",
    branchId,
    merchantId: null,
  };
}

// ------------------------------------------------------------------- scoping

function assertNdrVisible(row: NdrRow, scope: Principal): void {
  if (isGlobalScope(scope.role)) return;
  if (scope.role === "merchant") {
    if (row.merchantId !== scope.merchantId) errors.notFound("NDR");
    return;
  }
  if (row.branchId !== scope.branchId) {
    errors.forbidden("This NDR belongs to another branch.");
  }
}

function assertRtoVisible(row: RtoRow, scope: Principal): void {
  if (isGlobalScope(scope.role)) return;
  if (scope.role === "merchant") {
    if (row.merchantId !== scope.merchantId) errors.notFound("RTO");
    return;
  }
  if (row.branchId !== scope.branchId) {
    errors.forbidden("This return belongs to another branch.");
  }
}

// ---------------------------------------------------------------- read paths

export async function getNdr(id: string): Promise<NdrRow | null> {
  const [row] = await db.select().from(ndr).where(eq(ndr.id, id));
  return row ?? null;
}

/** The live NDR for a parcel, if it has one. At most one is live at a time. */
export async function liveNdrForParcel(parcelId: string): Promise<NdrRow | null> {
  const [row] = await db
    .select()
    .from(ndr)
    .where(and(eq(ndr.parcelId, parcelId), inArray(ndr.state, [...LIVE_NDR_STATES])))
    .orderBy(desc(ndr.raisedAt))
    .limit(1);
  return row ?? null;
}

export interface ListNdrInput {
  state?: ("open" | "instructed" | "reattempt_scheduled" | "rto" | "resolved" | "closed")[];
  merchantId?: string;
  /** Only rows whose SLA clock has already run out. */
  overdueOnly?: boolean;
  limit?: number;
}

/**
 * The scope + filter predicate shared by the list, the paged queue and the
 * counts, so the three can never disagree about which rows a caller may see.
 *
 * §5: a merchant naming another merchant is refused (403), not silently handed
 * an empty list that looks like "you have no NDRs".
 */
function ndrFilters(
  scope: Principal,
  input: { state?: string[]; merchantId?: string; overdueOnly?: boolean; search?: string },
  now: Date,
): SQL[] {
  const filters: SQL[] = [];
  if (scope.role === "merchant") {
    if (input.merchantId && input.merchantId !== scope.merchantId) {
      errors.forbidden("A merchant may only read its own NDRs.");
    }
    filters.push(eq(ndr.merchantId, scope.merchantId ?? "__none__"));
  } else if (!isGlobalScope(scope.role)) {
    filters.push(eq(ndr.branchId, scope.branchId));
  }
  if (input.state && input.state.length > 0) filters.push(inArray(ndr.state, input.state));
  if (input.merchantId) filters.push(eq(ndr.merchantId, input.merchantId));
  // Overdue is decided in SQL, not after the LIMIT — otherwise page 2 of the
  // overdue filter would be whatever happened to survive page 1's cut.
  if (input.overdueOnly) {
    filters.push(inArray(ndr.state, [...LIVE_NDR_STATES]));
    filters.push(lt(ndr.slaDueAt, now));
  }
  const term = input.search?.trim().toUpperCase();
  if (term) filters.push(like(ndr.awb, `%${term.replace(/[%_]/g, "")}%`));
  return filters;
}

function withSla(r: NdrRow, now: number) {
  return {
    ...r,
    overdue: r.slaDueAt ? r.slaDueAt.getTime() < now && isLive(r.state) : false,
    hoursLeft: r.slaDueAt
      ? Math.round(((r.slaDueAt.getTime() - now) / 3_600_000) * 10) / 10
      : null,
  };
}

export async function listNdr(scope: Principal, input: ListNdrInput = {}) {
  const now = new Date();
  const filters = ndrFilters(scope, input, now);
  const rows = await db
    .select()
    .from(ndr)
    .where(filters.length > 0 ? and(...filters) : undefined)
    // Oldest first: the queue is worked front to back, and an SLA breach that
    // sorts to the bottom of the screen is an SLA breach nobody sees.
    .orderBy(asc(ndr.raisedAt))
    .limit(input.limit ?? 200);
  return rows.map((r) => withSla(r, now.getTime()));
}

export interface PageNdrInput extends Omit<ListNdrInput, "limit"> {
  /** AWB fragment. */
  search?: string;
  page: number;
  pageSize: number;
}

/**
 * The ops queue screen (§11: server-side pagination). Same scope and ordering as
 * listNdr, plus a total so the table can say "page 3 of 9" honestly, and the
 * merchant's display name (read through the merchants service, §4).
 */
export async function pageNdr(scope: Principal, input: PageNdrInput) {
  const now = new Date();
  const filters = ndrFilters(scope, input, now);
  const where = filters.length > 0 ? and(...filters) : undefined;
  const pageSize = Math.min(Math.max(input.pageSize, 1), 100);
  const page = Math.max(input.page, 1);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(ndr)
      .where(where)
      .orderBy(asc(ndr.raisedAt), asc(ndr.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(ndr).where(where),
  ]);

  const names = new Map<string, string | null>();
  for (const id of new Set(rows.map((r) => r.merchantId))) {
    names.set(id, (await getMerchant(id))?.name ?? null);
  }
  return {
    rows: rows.map((r) => ({ ...withSla(r, now.getTime()), merchantName: names.get(r.merchantId) ?? null })),
    total: totalRow?.value ?? 0,
    page,
    pageSize,
  };
}

function isLive(state: string): boolean {
  return (LIVE_NDR_STATES as readonly string[]).includes(state);
}

export interface NdrDetail {
  ndr: NdrRow;
  parcel: ParcelRow;
  merchantName: string | null;
  rto: RtoRow | null;
  overdue: boolean;
}

export async function getNdrDetail(id: string, scope: Principal): Promise<NdrDetail> {
  const row = await getNdr(id);
  if (!row) errors.notFound(`NDR ${id}`);
  assertNdrVisible(row!, scope);

  const parcelRow = await getParcelById(row!.parcelId);
  if (!parcelRow) errors.notFound(`Parcel ${row!.parcelId}`);
  const merchant = await getMerchant(row!.merchantId);
  const [rtoRow] = await db
    .select()
    .from(rto)
    .where(eq(rto.parcelId, row!.parcelId))
    .orderBy(desc(rto.initiatedAt))
    .limit(1);

  return {
    ndr: row!,
    parcel: parcelRow!,
    merchantName: merchant?.name ?? null,
    rto: rtoRow ?? null,
    overdue: row!.slaDueAt ? row!.slaDueAt.getTime() < Date.now() && isLive(row!.state) : false,
  };
}

/**
 * Queue tallies, counted in SQL over the caller's whole scope — never derived
 * from a capped list, which would undercount silently once the queue passed
 * the cap.
 */
export async function ndrCounts(scope: Principal) {
  const now = new Date();
  const base = ndrFilters(scope, {}, now);
  const byState = await db
    .select({ state: ndr.state, value: count() })
    .from(ndr)
    .where(base.length > 0 ? and(...base) : undefined)
    .groupBy(ndr.state);
  const overdueFilters = ndrFilters(scope, { overdueOnly: true }, now);
  const [overdue] = await db
    .select({ value: count() })
    .from(ndr)
    .where(and(...overdueFilters));
  const of = (state: string) => byState.find((r) => r.state === state)?.value ?? 0;
  return {
    open: of("open"),
    instructed: of("instructed"),
    reattemptScheduled: of("reattempt_scheduled"),
    rto: of("rto"),
    resolved: of("resolved"),
    closed: of("closed"),
    overdue: overdue?.value ?? 0,
    total: byState.reduce((n, r) => n + r.value, 0),
  };
}

// --------------------------------------------------------------------- raise

/**
 * Called by the delivery service on every failed attempt. One live row per
 * parcel: a second failure updates the existing report rather than opening a
 * duplicate, because ops works parcels, not rows.
 *
 * Returns the row and whether the merchant needs telling (a first raise does,
 * a bumped attempt count on an already-instructed report does not — the
 * merchant already answered).
 */
export async function openOrUpdateNdr(params: {
  parcel: ParcelRow;
  reason: ReasonCodeRow;
  attempts: number;
  actor: Principal;
}): Promise<{ ndr: NdrRow; isNew: boolean }> {
  const { parcel: p, reason, attempts, actor } = params;
  const existing = await liveNdrForParcel(p.id);

  if (existing) {
    const [updated] = await db
      .update(ndr)
      .set({
        attempts,
        lastReasonCode: reason.code,
        lastReasonLabel: reason.label,
        // A fresh failure reopens an answered report: the instruction that was
        // given did not work, so it needs answering again.
        state: "open",
        actionedAt: new Date(),
        actionedByName: actor.name,
        slaDueAt: hoursFromNow(NDR_SLA_HOURS),
      })
      .where(eq(ndr.id, existing.id))
      .returning();
    return { ndr: updated!, isNew: false };
  }

  const [row] = await db
    .insert(ndr)
    .values({
      id: prefixedId("ndr"),
      parcelId: p.id,
      awb: p.awb,
      branchId: p.branchId,
      merchantId: p.merchantId,
      attempts,
      lastReasonCode: reason.code,
      lastReasonLabel: reason.label,
      state: "open",
      slaDueAt: hoursFromNow(NDR_SLA_HOURS),
      raisedAt: new Date(),
    })
    .returning();

  return { ndr: row!, isNew: true };
}

/** Closed without an RTO — the parcel was delivered, or ops wrote it off. */
export async function resolveNdrForParcel(
  parcelId: string,
  actor: Principal,
  closeReason: string,
): Promise<NdrRow | null> {
  const live = await liveNdrForParcel(parcelId);
  if (!live) return null;
  const [row] = await db
    .update(ndr)
    .set({
      state: "resolved",
      closedAt: new Date(),
      closeReason,
      actionedByName: actor.name,
      actionedAt: new Date(),
    })
    .where(eq(ndr.id, live.id))
    .returning();
  return row ?? null;
}

// --------------------------------------------------------------- instruction

export type MerchantInstruction = "reattempt" | "rto" | "hold" | "address_change";

export interface InstructNdrInput {
  ndrId: string;
  instruction: MerchantInstruction;
  notes?: string | null;
  /** Required for address_change. */
  newAddress?: string | null;
  newPhone?: string | null;
  newLat?: number | null;
  newLng?: number | null;
  /** YYYY-MM-DD in Asia/Colombo. Required for reattempt and address_change. */
  reattemptDate?: string | null;
}

export interface InstructNdrResult {
  ndr: NdrRow;
  parcel: ParcelRow;
  rto: RtoRow | null;
}

/**
 * The merchant's (or ops') answer to a failed delivery. This is the only place
 * an NDR leaves the queue under its own power.
 *
 * The reason code's `allowsReattempt` flag is enforced here: a merchant cannot
 * instruct "try again" on an address that was never findable. They must correct
 * it or take the parcel back.
 */
export async function instructNdr(
  input: InstructNdrInput,
  actor: Principal,
): Promise<InstructNdrResult> {
  const row = await getNdr(input.ndrId);
  if (!row) errors.notFound(`NDR ${input.ndrId}`);
  assertNdrVisible(row!, actor);

  if (!isLive(row!.state)) {
    errors.conflict(`NDR ${row!.awb} is already ${row!.state} and cannot be instructed.`, {
      awb: row!.awb,
      state: row!.state,
    });
  }

  const parcelRow = await getParcelById(row!.parcelId);
  if (!parcelRow) errors.notFound(`Parcel ${row!.parcelId}`);

  // A merchant may change its mind while the parcel sits at the hub — an NDR
  // stays live through `reattempt_scheduled`, and re-answering it is legitimate.
  // Once the reattempt is actually on a van, it is not: "hold" would yank a
  // parcel to OnHold while a rider is standing at the door with it, and
  // "address_change" would rewrite the address under a printed runsheet. The
  // answer then is to let the attempt happen and instruct the NDR it raises.
  if (parcelRow!.status === "OutForDelivery") {
    errors.conflict(
      `Parcel ${row!.awb} is already out for delivery on this instruction. Wait for the attempt to be recorded before instructing again.`,
      { awb: row!.awb, currentStatus: parcelRow!.status, state: row!.state },
    );
  }

  const now = new Date();
  let rtoRow: RtoRow | null = null;
  let parcelAfter = parcelRow!;
  let nextState: string;

  switch (input.instruction) {
    case "address_change": {
      if (!input.newAddress && !input.newPhone) {
        errors.badRequest(
          "An address_change instruction needs a new address or a new phone number.",
        );
      }
      parcelAfter = await updateDeliveryDetails(
        parcelRow!.id,
        {
          destAddress: input.newAddress ?? null,
          consigneePhone: input.newPhone ?? null,
          destLat: input.newLat ?? null,
          destLng: input.newLng ?? null,
        },
        actor,
        `NDR ${row!.id}: merchant supplied corrected delivery details.`,
      );
      nextState = "reattempt_scheduled";
      break;
    }

    case "reattempt": {
      // §6's attempt ceiling is not negotiable by instruction: a parcel that
      // has burned three attempts goes back, whatever the merchant wants.
      if (parcelRow!.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
        errors.conflict(
          `Parcel ${row!.awb} has used all ${MAX_DELIVERY_ATTEMPTS} delivery attempts. It must be returned, not reattempted.`,
          { awb: row!.awb, attempts: parcelRow!.deliveryAttempts },
        );
      }
      // And a reason the flags say cannot be retried is not retried.
      if (row!.lastReasonCode) {
        const reason = await requireReasonCode(row!.lastReasonCode);
        if (!reason.allowsReattempt) {
          errors.conflict(
            `"${reason.label}" cannot be fixed by another attempt. Correct the address or return the parcel.`,
            { awb: row!.awb, reasonCode: reason.code },
          );
        }
      }
      nextState = "reattempt_scheduled";
      break;
    }

    case "hold": {
      // OnHold parks the parcel at the hub with a custody event — it does not
      // vanish from the board, it just stops being runsheet-eligible.
      //
      // §6's role table does not give the merchant role the OnHold transition,
      // and rightly so: a merchant does not touch NatEx custody. But §8 makes
      // "hold" one of the four answers a merchant may give its own NDR, so the
      // instruction is the merchant's and the custody move is the system's,
      // executing it. Same pattern as `reasonRto`: the synthetic principal is
      // labelled, and the merchant who asked is named in the event notes, so
      // the audit trail shows both without granting a role nobody should hold.
      const moved = await transitionParcel(
        {
          awbOrId: parcelRow!.awb,
          to: "OnHold",
          notes: `NDR ${row!.id}: held on merchant instruction by ${actor.name}${
            actor.role === "merchant" ? "" : ` (${actor.role})`
          }. ${input.notes ?? ""}`.trim(),
        },
        isGlobalScope(actor.role) || actor.role === "ops"
          ? actor
          : systemActor(parcelRow!.branchId),
      );
      parcelAfter = moved.parcel;
      nextState = "instructed";
      break;
    }

    case "rto": {
      const result = await initiateRto(
        {
          parcelId: parcelRow!.id,
          trigger: "merchant_instruction",
          reason: input.notes?.trim() || row!.lastReasonLabel || "Merchant asked for the return",
        },
        actor,
      );
      rtoRow = result.rto;
      parcelAfter = result.parcel;
      // initiateRto already closed the NDR as `rto`; re-read below.
      nextState = "rto";
      break;
    }
  }

  const [updated] = await db
    .update(ndr)
    .set({
      state: nextState,
      merchantInstruction: input.instruction,
      instructionNotes: input.notes ?? null,
      instructedByName: actor.name,
      instructedAt: now,
      newAddress: input.newAddress ?? null,
      newPhone: input.newPhone ?? null,
      reattemptDate:
        input.instruction === "reattempt" || input.instruction === "address_change"
          ? (input.reattemptDate ?? colomboToday())
          : null,
      actionedAt: now,
      actionedByName: actor.name,
      closedAt: nextState === "rto" ? now : null,
      closeReason: nextState === "rto" ? "Returned to sender on instruction" : null,
    })
    .where(eq(ndr.id, row!.id))
    .returning();

  return { ndr: updated!, parcel: parcelAfter, rto: rtoRow };
}

/** Ops closing a report without an instruction — a duplicate, or resolved off-system. */
export async function closeNdr(
  input: { ndrId: string; closeReason: string },
  actor: Principal,
): Promise<NdrRow> {
  const row = await getNdr(input.ndrId);
  if (!row) errors.notFound(`NDR ${input.ndrId}`);
  assertNdrVisible(row!, actor);
  if (!isLive(row!.state)) {
    errors.conflict(`NDR ${row!.awb} is already ${row!.state}.`, { state: row!.state });
  }
  const [updated] = await db
    .update(ndr)
    .set({
      state: "closed",
      closedAt: new Date(),
      closeReason: input.closeReason,
      actionedAt: new Date(),
      actionedByName: actor.name,
    })
    .where(eq(ndr.id, row!.id))
    .returning();
  return updated!;
}

// ----------------------------------------------------------------------- RTO

export type RtoTrigger =
  | "auto_max_attempts"
  | "merchant_instruction"
  | "ops_decision"
  | "consignee_refused";

export interface InitiateRtoInput {
  parcelId?: string;
  awb?: string;
  trigger: RtoTrigger;
  reason: string;
  notes?: string | null;
}

/**
 * Turn a parcel back. Raised by an instruction, by an ops decision, or
 * automatically by §6's three-attempt rule (`trigger: auto_max_attempts`,
 * commanded by the system principal above).
 *
 * Idempotent by design: a parcel that already has a live RTO returns it rather
 * than opening a second one, because the same third failure can arrive twice
 * from an offline device (§7).
 */
export async function initiateRto(
  input: InitiateRtoInput,
  actor: Principal,
): Promise<{ rto: RtoRow; parcel: ParcelRow; alreadyOpen: boolean }> {
  const parcelRow = input.parcelId
    ? await getParcelById(input.parcelId)
    : await getParcelByAwb(input.awb ?? "");
  if (!parcelRow) errors.notFound(`Parcel ${input.parcelId ?? input.awb}`);

  const [live] = await db
    .select()
    .from(rto)
    .where(and(eq(rto.parcelId, parcelRow!.id), inArray(rto.state, ["initiated", "in_transit"])))
    .limit(1);
  if (live) return { rto: live, parcel: parcelRow!, alreadyOpen: true };

  const moved = await transitionParcel(
    {
      awbOrId: parcelRow!.awb,
      to: "RTOInitiated",
      notes: `RTO (${input.trigger}): ${input.reason}`,
    },
    actor,
  );

  const [row] = await db
    .insert(rto)
    .values({
      id: prefixedId("rto"),
      parcelId: parcelRow!.id,
      awb: parcelRow!.awb,
      branchId: moved.parcel.branchId,
      merchantId: parcelRow!.merchantId,
      trigger: input.trigger,
      reason: input.reason,
      state: "initiated",
      attemptsAtInitiation: parcelRow!.deliveryAttempts,
      initiatedAt: new Date(),
      initiatedByName: actor.name,
      notes: input.notes ?? null,
    })
    .returning();

  // The NDR queue is done with this parcel — its fate is decided.
  const liveNdr = await liveNdrForParcel(parcelRow!.id);
  if (liveNdr) {
    await db
      .update(ndr)
      .set({
        state: "rto",
        closedAt: new Date(),
        closeReason: `Returned to sender: ${input.reason}`,
        actionedAt: new Date(),
        actionedByName: actor.name,
      })
      .where(eq(ndr.id, liveNdr.id));
  }

  await enqueue("notify.dispatch", {
    templateKey: "parcel.rto_initiated",
    parcelId: parcelRow!.id,
    awb: parcelRow!.awb,
    merchantId: parcelRow!.merchantId,
    toPhone: await merchantPhone(parcelRow!.merchantId),
    vars: {
      awb: parcelRow!.awb,
      consigneeName: parcelRow!.consigneeName,
      reason: input.reason,
    },
  });

  return { rto: row!, parcel: moved.parcel, alreadyOpen: false };
}

/** Convenience for the automatic three-attempt rule (§6). */
export async function autoRto(
  parcelRow: ParcelRow,
  reason: string,
): Promise<{ rto: RtoRow; parcel: ParcelRow; alreadyOpen: boolean }> {
  return initiateRto(
    { parcelId: parcelRow.id, trigger: "auto_max_attempts", reason },
    systemActor(parcelRow.branchId),
  );
}

/**
 * A reason code that carries `triggersRto` sends the parcel back by rule, not
 * by anyone's decision — "consignee refused the parcel" leaves nothing to
 * decide. Like `autoRto` it runs as the system principal, because the person
 * who recorded the failure is usually the rider and RTOInitiated is an ops
 * transition (§6 TRANSITION_ROLES). Coercing the rider's principal to `ops` to
 * get past that check would put a role they do not hold into the audit trail,
 * so instead the rider is named in the reason text and the event is honestly
 * attributed to the rule that fired it.
 */
export async function reasonRto(
  parcelRow: ParcelRow,
  reason: string,
  triggeredBy: Principal,
): Promise<{ rto: RtoRow; parcel: ParcelRow; alreadyOpen: boolean }> {
  return initiateRto(
    {
      parcelId: parcelRow.id,
      trigger: "consignee_refused",
      reason: `${reason} (recorded by ${triggeredBy.name}, ${triggeredBy.role})`,
    },
    systemActor(parcelRow.branchId),
  );
}

/** The return leg leaves the hub: RTOInitiated → RTOInTransit. */
export async function dispatchRto(
  input: { rtoId: string; notes?: string | null },
  actor: Principal,
): Promise<{ rto: RtoRow; parcel: ParcelRow }> {
  const row = await getRto(input.rtoId);
  if (!row) errors.notFound(`RTO ${input.rtoId}`);
  assertRtoVisible(row!, actor);
  if (row!.state !== "initiated") {
    errors.conflict(`Return ${row!.awb} is ${row!.state}, not initiated.`, { state: row!.state });
  }

  const moved = await transitionParcel(
    {
      awbOrId: row!.awb,
      to: "RTOInTransit",
      notes: `Return leg dispatched to merchant. ${input.notes ?? ""}`.trim(),
    },
    actor,
  );

  const [updated] = await db
    .update(rto)
    .set({ state: "in_transit", dispatchedAt: new Date() })
    .where(eq(rto.id, row!.id))
    .returning();

  return { rto: updated!, parcel: moved.parcel };
}

export interface DeliverRtoInput {
  rtoId: string;
  /** Who at the merchant signed for the return. */
  receivedByName: string;
  /** §6 requires a POD for RTODelivered too — the merchant signs it back in. */
  signatureData?: string | null;
  photoUrl?: string | null;
  notes?: string | null;
  lat?: number | null;
  lng?: number | null;
  clientId?: string | null;
}

/**
 * The parcel is back in the merchant's hands: RTOInTransit → RTODelivered.
 *
 * `requiresPod("RTODelivered")` is true in the state machine, so a POD row is
 * written before the transition. A return handed over with nobody's name on it
 * is the same unaccountable gap as a delivery with no signature.
 */
export async function deliverRto(
  input: DeliverRtoInput,
  actor: Principal,
): Promise<{ rto: RtoRow; parcel: ParcelRow; podId: string }> {
  const row = await getRto(input.rtoId);
  if (!row) errors.notFound(`RTO ${input.rtoId}`);
  assertRtoVisible(row!, actor);
  if (row!.state !== "in_transit") {
    errors.conflict(`Return ${row!.awb} is ${row!.state}, not in transit.`, {
      state: row!.state,
    });
  }
  if (!input.receivedByName.trim()) {
    errors.badRequest("A return needs the name of the person who took it back.");
  }

  const podId = prefixedId("pod");
  await db.insert(deliveryPod).values({
    id: podId,
    parcelId: row!.parcelId,
    awb: row!.awb,
    method: input.signatureData ? "signature" : input.photoUrl ? "photo" : "signature",
    receivedByName: input.receivedByName.trim(),
    receivedByRelation: "merchant",
    signatureData: input.signatureData ?? null,
    photoUrl: input.photoUrl ?? null,
    photoNote: input.notes ?? null,
    capturedById: actor.userId,
    capturedByName: actor.name,
    deviceId: actor.deviceId ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    clientId: input.clientId ?? null,
    ts: new Date(),
  });

  const moved = await transitionParcel(
    {
      awbOrId: row!.awb,
      to: "RTODelivered",
      lat: input.lat,
      lng: input.lng,
      notes: `Returned to merchant, received by ${input.receivedByName.trim()}.`,
      clientId: input.clientId,
    },
    actor,
    { podId },
  );

  const now = new Date();
  const [updated] = await db
    .update(rto)
    .set({
      state: "delivered",
      deliveredAt: now,
      receivedByName: input.receivedByName.trim(),
      notes: input.notes ?? row!.notes,
    })
    .where(eq(rto.id, row!.id))
    .returning();

  await enqueue("notify.dispatch", {
    templateKey: "parcel.rto_delivered",
    parcelId: row!.parcelId,
    awb: row!.awb,
    merchantId: row!.merchantId,
    toPhone: await merchantPhone(row!.merchantId),
    vars: {
      awb: row!.awb,
      receivedBy: input.receivedByName.trim(),
      date: formatLkDate(colomboToday(now)),
    },
  });

  return { rto: updated!, parcel: moved.parcel, podId };
}

export async function getRto(id: string): Promise<RtoRow | null> {
  const [row] = await db.select().from(rto).where(eq(rto.id, id));
  return row ?? null;
}

type RtoState = "initiated" | "in_transit" | "delivered" | "closed";

function rtoFilters(
  scope: Principal,
  input: { state?: RtoState[]; merchantId?: string; search?: string },
): SQL[] {
  const filters: SQL[] = [];
  if (scope.role === "merchant") {
    if (input.merchantId && input.merchantId !== scope.merchantId) {
      errors.forbidden("A merchant may only read its own returns.");
    }
    filters.push(eq(rto.merchantId, scope.merchantId ?? "__none__"));
  } else if (!isGlobalScope(scope.role)) {
    filters.push(eq(rto.branchId, scope.branchId));
  }
  if (input.state && input.state.length > 0) filters.push(inArray(rto.state, input.state));
  if (input.merchantId) filters.push(eq(rto.merchantId, input.merchantId));
  const term = input.search?.trim().toUpperCase();
  if (term) filters.push(like(rto.awb, `%${term.replace(/[%_]/g, "")}%`));
  return filters;
}

export async function listRto(
  scope: Principal,
  input: { state?: RtoState[]; limit?: number } = {},
) {
  const filters = rtoFilters(scope, input);
  return db
    .select()
    .from(rto)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(rto.initiatedAt))
    .limit(input.limit ?? 200);
}

/** The RTO tab (§11: server-side pagination), oldest first like the NDR queue. */
export async function pageRto(
  scope: Principal,
  input: { state?: RtoState[]; merchantId?: string; search?: string; page: number; pageSize: number },
) {
  const filters = rtoFilters(scope, input);
  const where = filters.length > 0 ? and(...filters) : undefined;
  const pageSize = Math.min(Math.max(input.pageSize, 1), 100);
  const page = Math.max(input.page, 1);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(rto)
      .where(where)
      .orderBy(asc(rto.initiatedAt), asc(rto.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(rto).where(where),
  ]);
  const names = new Map<string, string | null>();
  for (const id of new Set(rows.map((r) => r.merchantId))) {
    names.set(id, (await getMerchant(id))?.name ?? null);
  }
  return {
    rows: rows.map((r) => ({ ...r, merchantName: names.get(r.merchantId) ?? null })),
    total: totalRow?.value ?? 0,
    page,
    pageSize,
  };
}

/**
 * One return, scoped (§5). The route used to hand any signed-in caller any RTO
 * by id — a merchant could read another merchant's return. Now it is refused
 * exactly as an NDR is: 404 for another merchant's row, 403 for another branch.
 */
export async function getRtoDetail(id: string, scope: Principal) {
  const row = await getRto(id);
  if (!row) errors.notFound(`RTO ${id}`);
  assertRtoVisible(row!, scope);
  const parcelRow = await getParcelById(row!.parcelId);
  const merchant = await getMerchant(row!.merchantId);
  const [pod] = await db
    .select()
    .from(deliveryPod)
    .where(eq(deliveryPod.parcelId, row!.parcelId))
    .orderBy(desc(deliveryPod.ts))
    .limit(1);
  return {
    rto: row!,
    parcel: parcelRow,
    merchantName: merchant?.name ?? null,
    pod: row!.state === "delivered" ? (pod ?? null) : null,
  };
}

export async function rtoCounts(scope: Principal) {
  const base = rtoFilters(scope, {});
  const byState = await db
    .select({ state: rto.state, value: count() })
    .from(rto)
    .where(base.length > 0 ? and(...base) : undefined)
    .groupBy(rto.state);
  const of = (state: string) => byState.find((r) => r.state === state)?.value ?? 0;
  return {
    initiated: of("initiated"),
    inTransit: of("in_transit"),
    delivered: of("delivered"),
    closed: of("closed"),
    total: byState.reduce((n, r) => n + r.value, 0),
  };
}

/**
 * The RTOs a merchant can be charged for in a period (§8's "RTO fee" deduction).
 *
 * Exists so that `modules/cod/settlement.ts` never selects from `delivery_rto`
 * itself (§4: "no module reading another module's tables"). The charge attaches
 * to the week the return was *initiated*, because that is when the work of
 * carrying the parcel back was incurred; a return still in transit at the
 * cut-off is therefore billed in the period it started, not the one it lands in.
 *
 * `from`/`to` are inclusive Asia/Colombo calendar dates (§9).
 */
export async function rtosForBilling(input: {
  merchantId: string;
  from: string;
  to: string;
}): Promise<{ id: string; parcelId: string; awb: string; reason: string; initiatedAt: Date }[]> {
  const rows = await db
    .select()
    .from(rto)
    .where(eq(rto.merchantId, input.merchantId))
    .orderBy(asc(rto.initiatedAt));

  return rows
    .filter((row) => {
      const day = colomboToday(row.initiatedAt);
      return day >= input.from && day <= input.to;
    })
    .map((row) => ({
      id: row.id,
      parcelId: row.parcelId,
      awb: row.awb,
      reason: row.reason,
      initiatedAt: row.initiatedAt,
    }));
}

/** Merchant contact for the notification ladder — via the merchants service (§4). */
async function merchantPhone(merchantId: string): Promise<string | null> {
  const m = await getMerchant(merchantId);
  return m?.contactPhone ?? null;
}

export async function ndrCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(ndr);
  return row?.value ?? 0;
}
