/**
 * Settlement holds — §8's controls table, made queryable.
 *
 *   "Amount mismatch  → POD amount ≠ COD entry → parcel held from settlement"
 *   "Settlement hold  → any open variance blocks that merchant's payout"
 *
 * Both controls need durable state, not a notification: a settlement run has to
 * be able to ask "is this parcel clean?" and "is this merchant clear?" before
 * it puts money on a line. `service.ts` raises holds as it finds problems,
 * `settlement.ts` reads them, and neither imports the other — which is why
 * this lives in its own file rather than inside either.
 *
 * Holds are workflow state and therefore mutable, unlike `cod_entry`. Clearing
 * one requires a named human and an explanation; there is deliberately no
 * function here that deletes a hold or clears one without a note.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../database";
import { codHold } from "../../database/schema/cod";
import { errors, fail, isUniqueViolationOn, problem } from "../../shared/errors";
import { prefixedId } from "../../shared/ulid";
import { writeAudit } from "../../shared/audit";
import type { Principal } from "../../shared/auth";

export type CodHoldRow = typeof codHold.$inferSelect;

/** parcel blocks one line of a run; merchant blocks the entire payout. */
export type HoldScope = "parcel" | "merchant";

/**
 * Why money is being held. Each maps to a row of §8's controls table except
 * `manual`, which is finance exercising judgement and must carry its own
 * explanation.
 */
export const HOLD_REASONS = [
  "amount_mismatch",
  "deposit_variance",
  "dispute",
  "manual",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export interface RaiseHoldInput {
  scope: HoldScope;
  reason: HoldReason;
  /** Always set: a hold nobody can attribute to a merchant blocks nothing. */
  merchantId: string;
  parcelId?: string | null;
  awb?: string | null;
  entryId?: string | null;
  depositId?: string | null;
  disputeId?: string | null;
  amountCents?: number | null;
  detail: string;
  /**
   * Dedupe key. Same key twice = the same hold, so an offline retry or a
   * re-verified deposit cannot pile up duplicates.
   */
  sourceKey: string;
  actor?: Principal | null;
}

/**
 * Open a hold, or return the existing one for the same `sourceKey`.
 *
 * Idempotent by database constraint rather than by a read-then-write check,
 * for the same reason `cod_entry` dedupes on `client_id`: two concurrent
 * writers would both pass the check.
 */
export async function raiseHold(input: RaiseHoldInput): Promise<{
  hold: CodHoldRow;
  created: boolean;
}> {
  if (!input.detail?.trim()) {
    fail(
      "BAD_REQUEST",
      problem("detail-required", "Detail required", 422, "A hold must say what is wrong."),
    );
  }

  const id = prefixedId("hold");
  try {
    await db.insert(codHold).values({
      id,
      scope: input.scope,
      reason: input.reason,
      status: "open",
      merchantId: input.merchantId,
      parcelId: input.parcelId ?? null,
      awb: input.awb ?? null,
      entryId: input.entryId ?? null,
      depositId: input.depositId ?? null,
      disputeId: input.disputeId ?? null,
      amountCents: input.amountCents ?? null,
      detail: input.detail,
      sourceKey: input.sourceKey,
      openedById: input.actor?.userId ?? null,
      openedByName: input.actor?.name ?? null,
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "cod_hold.source_key")) {
      const [existing] = await db
        .select()
        .from(codHold)
        .where(eq(codHold.sourceKey, input.sourceKey));
      // An already-cleared hold is not re-opened here: whoever cleared it did
      // so with a reason, and a replayed event is not new evidence. A genuinely
      // new problem carries a new sourceKey.
      return { hold: existing!, created: false };
    }
    throw error;
  }

  await writeAudit({
    entity: "cod_hold",
    entityId: id,
    action: "cod.hold_raised",
    actor: input.actor,
    after: {
      scope: input.scope,
      reason: input.reason,
      merchantId: input.merchantId,
      parcelId: input.parcelId ?? null,
      amountCents: input.amountCents ?? null,
      detail: input.detail,
    },
  });

  const [row] = await db.select().from(codHold).where(eq(codHold.id, id));
  return { hold: row!, created: true };
}

/** Release a hold. The note is mandatory: nothing is released silently. */
export async function clearHold(input: {
  holdId: string;
  note: string;
  actor?: Principal | null;
}): Promise<CodHoldRow> {
  const [hold] = await db.select().from(codHold).where(eq(codHold.id, input.holdId));
  if (!hold) errors.notFound("Hold");
  if (hold!.status === "cleared") {
    errors.conflict("That hold has already been cleared.", { clearedAt: hold!.clearedAt });
  }
  if (!input.note?.trim()) {
    fail(
      "BAD_REQUEST",
      problem(
        "note-required",
        "Note required",
        422,
        "Releasing a hold requires an explanation of why the money is now safe to pay.",
      ),
    );
  }

  await db
    .update(codHold)
    .set({
      status: "cleared",
      clearedAt: new Date(),
      clearedById: input.actor?.userId ?? null,
      clearedByName: input.actor?.name ?? null,
      clearedNote: input.note,
    })
    .where(eq(codHold.id, input.holdId));

  await writeAudit({
    entity: "cod_hold",
    entityId: input.holdId,
    action: "cod.hold_cleared",
    actor: input.actor,
    before: { status: "open", detail: hold!.detail },
    after: { status: "cleared", note: input.note },
  });

  const [row] = await db.select().from(codHold).where(eq(codHold.id, input.holdId));
  return row!;
}

export interface HoldFilter {
  merchantId?: string;
  parcelId?: string;
  status?: ("open" | "cleared")[];
  scope?: HoldScope;
  reason?: HoldReason[];
  limit?: number;
  offset?: number;
}

function holdWhere(filter?: HoldFilter) {
  const conditions = [];
  if (filter?.merchantId) conditions.push(eq(codHold.merchantId, filter.merchantId));
  if (filter?.parcelId) conditions.push(eq(codHold.parcelId, filter.parcelId));
  if (filter?.status?.length) conditions.push(inArray(codHold.status, filter.status));
  if (filter?.scope) conditions.push(eq(codHold.scope, filter.scope));
  if (filter?.reason?.length) conditions.push(inArray(codHold.reason, filter.reason));
  return conditions.length ? and(...conditions) : undefined;
}

export async function listHolds(filter?: HoldFilter): Promise<CodHoldRow[]> {
  return db
    .select()
    .from(codHold)
    .where(holdWhere(filter))
    .orderBy(desc(codHold.openedAt))
    .limit(Math.min(filter?.limit ?? 100, 500))
    .offset(filter?.offset ?? 0);
}

/** One page plus the filtered total (§11 server-side paging). */
export async function holdPage(filter: HoldFilter): Promise<{ rows: CodHoldRow[]; total: number }> {
  const [rows, [count]] = await Promise.all([
    listHolds(filter),
    db.select({ n: sql<number>`count(*)` }).from(codHold).where(holdWhere(filter)),
  ]);
  return { rows, total: Number(count?.n ?? 0) };
}

/**
 * Everything blocking one merchant's payout, in the shape a settlement run
 * needs: the parcel ids it must leave out, and the merchant-wide holds that
 * stop the run moving at all.
 */
export async function merchantHoldState(merchantId: string): Promise<{
  /** Parcel ids with an open hold — excluded from the run's lines. */
  heldParcelIds: Set<string>;
  /** Merchant-scoped holds — the whole payout is stopped while any is open. */
  blockingHolds: CodHoldRow[];
  open: CodHoldRow[];
}> {
  const open = await db
    .select()
    .from(codHold)
    .where(and(eq(codHold.merchantId, merchantId), eq(codHold.status, "open")));

  const heldParcelIds = new Set<string>();
  const blockingHolds: CodHoldRow[] = [];
  for (const hold of open) {
    if (hold.scope === "merchant") blockingHolds.push(hold);
    else if (hold.parcelId) heldParcelIds.add(hold.parcelId);
  }
  return { heldParcelIds, blockingHolds, open };
}
