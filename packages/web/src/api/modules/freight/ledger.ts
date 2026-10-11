import { and, count, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../database";
import type { DbTransaction } from "../../database/transaction";
import {
  freightCharge,
  freightEntry,
  freightReconciliation,
  type FreightChargeRow,
  type FreightEntryRow,
} from "../../database/schema/freight";
import { errors } from "../../shared/errors";
import { isGlobalScope, type Principal } from "../../shared/auth";
import { insertWithFreshCode, mintDocumentCode } from "../../shared/codes";
import { colomboToday } from "../../shared/time";
import { prefixedId } from "../../shared/ulid";

/** Transaction type inferred from the configured libSQL Drizzle client. */
export type FreightTransaction = DbTransaction;

export interface CreateChargeInput {
  parcelId: string;
  awb: string;
  branchId: string;
  branchName: string;
  payer: "sender" | "recipient";
  amountCents: number;
  senderName: string;
  senderPhone: string;
  senderAddress?: string | null;
  recipientName: string;
  recipientPhone: string;
  destinationAddress: string;
  createdById: string;
  createdByName: string;
  createdByRole: string;
  requestId: string;
  paymentMethod?: "cash" | "bank_transfer" | "qr" | "card";
  externalReference?: string | null;
}

export interface DeliveryFreightInput {
  amountCents: number;
  paymentMethod?: "cash" | "bank_transfer" | "qr" | "card" | null;
  externalReference?: string | null;
  clientId?: string | null;
  runsheetId?: string | null;
}

function netPaid(entries: readonly FreightEntryRow[]): number {
  return entries.reduce((total, entry) => total + entry.amountCents, 0);
}

async function insertEntry(
  tx: FreightTransaction,
  input: Omit<FreightEntryRow, "id" | "code" | "ts"> & { codePrefix: string },
): Promise<FreightEntryRow> {
  const { codePrefix, ...values } = input;
  const { result: [row] } = await insertWithFreshCode(
    "freight_entry",
    () => mintDocumentCode(codePrefix, colomboToday()),
    (code) => tx
      .insert(freightEntry)
      .values({ id: prefixedId("fre"), code, ...values, ts: new Date() })
      .returning(),
  );
  return row!;
}

/**
 * Create the immutable retail freight charge and, when the sender pays now,
 * its collection/receipt in the SAME transaction as the parcel row.
 */
export async function createRetailChargeInTransaction(
  tx: FreightTransaction,
  input: CreateChargeInput,
): Promise<{ charge: FreightChargeRow; paidReceipt: FreightEntryRow | null }> {
  const { result: [charge] } = await insertWithFreshCode(
    "freight_charge",
    () => mintDocumentCode("FRT", colomboToday()),
    (code) => tx
      .insert(freightCharge)
      .values({
        id: prefixedId("frc"),
        code,
        parcelId: input.parcelId,
        awb: input.awb,
        branchId: input.branchId,
        branchName: input.branchName,
        payer: input.payer,
        amountCents: input.amountCents,
        pricingBasis: "manual",
        senderName: input.senderName.trim(),
        senderPhone: input.senderPhone.trim(),
        senderAddress: input.senderAddress?.trim() || null,
        recipientName: input.recipientName.trim(),
        recipientPhone: input.recipientPhone.trim(),
        destinationAddress: input.destinationAddress.trim(),
        createdById: input.createdById,
        createdByName: input.createdByName,
        bookingRequestId: input.requestId,
        createdAt: new Date(),
      })
      .returning(),
  );

  let paidReceipt: FreightEntryRow | null = null;
  if (input.payer === "sender") {
    paidReceipt = await insertEntry(tx, {
      chargeId: charge!.id,
      parcelId: input.parcelId,
      awb: input.awb,
      branchId: input.branchId,
      payer: input.payer,
      entryType: "collection",
      amountCents: input.amountCents,
      paymentMethod: input.paymentMethod ?? "cash",
      externalReference: input.externalReference?.trim() || null,
      collectorId: input.createdById,
      collectorName: input.createdByName,
      collectorRole: input.createdByRole,
      riderId: null,
      runsheetId: null,
      clientId: `${input.requestId}:counter-collection`,
      reversalOfId: null,
      reason: null,
      codePrefix: "RCP",
    });
  }
  return { charge: charge!, paidReceipt };
}

export async function chargeByParcel(parcelId: string): Promise<FreightChargeRow | null> {
  const [row] = await db.select().from(freightCharge).where(eq(freightCharge.parcelId, parcelId)).limit(1);
  return row ?? null;
}

export async function chargeByRequest(requestId: string): Promise<FreightChargeRow | null> {
  const [row] = await db
    .select()
    .from(freightCharge)
    .where(eq(freightCharge.bookingRequestId, requestId))
    .limit(1);
  return row ?? null;
}

export async function entryByClientId(clientId: string): Promise<FreightEntryRow | null> {
  const [row] = await db.select().from(freightEntry).where(eq(freightEntry.clientId, clientId)).limit(1);
  return row ?? null;
}

export async function entriesForCharge(chargeId: string): Promise<FreightEntryRow[]> {
  return db.select().from(freightEntry).where(eq(freightEntry.chargeId, chargeId)).orderBy(desc(freightEntry.ts));
}

/**
 * Called inside the delivery transaction. Receiver freight is validated and
 * appended before the parcel's Delivered transition commits; if either write
 * fails, both the POD/state change and the payment ledger entry roll back.
 */
export async function recordDeliveryFreightInTransaction(
  tx: FreightTransaction,
  charge: FreightChargeRow,
  input: DeliveryFreightInput,
  actor: Principal,
): Promise<FreightEntryRow | null> {
  const priorEntries = await tx.select().from(freightEntry).where(eq(freightEntry.chargeId, charge.id));
  const paid = netPaid(priorEntries);
  if (charge.payer === "sender") {
    if (input.amountCents !== 0) {
      errors.badRequest("Freight was prepaid by the sender; do not collect it again at delivery.");
    }
    if (paid !== charge.amountCents) {
      errors.conflict("Sender-paid freight is not fully settled. Finance must resolve the freight ledger before delivery.");
    }
    return null;
  }
  if (input.amountCents !== charge.amountCents) {
    errors.badRequest(
      `Freight due is ${charge.amountCents} cents; the delivery collection must match exactly.`,
      { owedCents: charge.amountCents, collectedCents: input.amountCents },
    );
  }
  if (paid !== 0 || priorEntries.some((entry) => entry.entryType === "collection")) {
    errors.conflict("Recipient freight for this parcel has already been collected or adjusted.");
  }
  return insertEntry(tx, {
    chargeId: charge.id,
    parcelId: charge.parcelId,
    awb: charge.awb,
    branchId: charge.branchId,
    payer: charge.payer,
    entryType: "collection",
    amountCents: charge.amountCents,
    paymentMethod: input.paymentMethod ?? "cash",
    externalReference: input.externalReference?.trim() || null,
    collectorId: actor.userId,
    collectorName: actor.name,
    collectorRole: actor.role,
    riderId: actor.role === "rider" ? actor.userId : null,
    runsheetId: input.runsheetId ?? null,
    clientId: input.clientId ? `delivery:${input.clientId}` : `delivery:${charge.parcelId}`,
    reversalOfId: null,
    reason: null,
    codePrefix: "RCP",
  });
}

export async function chargeLedger(chargeId: string) {
  const [charge] = await db.select().from(freightCharge).where(eq(freightCharge.id, chargeId)).limit(1);
  if (!charge) errors.notFound("Freight charge");
  const entries = await entriesForCharge(chargeId);
  return { charge: charge!, entries, paidCents: netPaid(entries), dueCents: charge!.amountCents - netPaid(entries) };
}

function filtersFor(
  scope: Principal,
  input: { branchId?: string; awbOrReceipt?: string; entryType?: "collection" | "refund" | "adjustment" },
): SQL[] {
  const filters: SQL[] = [];
  if (!isGlobalScope(scope.role)) filters.push(eq(freightEntry.branchId, scope.branchId));
  else if (input.branchId) filters.push(eq(freightEntry.branchId, input.branchId));
  if (input.entryType) filters.push(eq(freightEntry.entryType, input.entryType));
  const term = input.awbOrReceipt?.trim().replace(/[%_]/g, "");
  if (term) {
    filters.push(or(
      like(freightEntry.awb, `%${term}%`),
      like(freightEntry.code, `%${term}%`),
      like(freightCharge.senderName, `%${term}%`),
      like(freightCharge.recipientName, `%${term}%`),
      like(freightCharge.senderPhone, `%${term}%`),
    )!);
  }
  return filters;
}

export async function pageFreightEntries(
  scope: Principal,
  input: { branchId?: string; awbOrReceipt?: string; entryType?: "collection" | "refund" | "adjustment"; page: number; pageSize: number },
) {
  const filters = filtersFor(scope, input);
  const where = filters.length ? and(...filters) : undefined;
  const page = Math.max(1, input.page);
  const pageSize = Math.min(100, Math.max(1, input.pageSize));
  const [rows, [totalRow]] = await Promise.all([
    db.select({ entry: freightEntry, charge: freightCharge, reconciliation: freightReconciliation })
      .from(freightEntry)
      .innerJoin(freightCharge, eq(freightCharge.id, freightEntry.chargeId))
      .leftJoin(freightReconciliation, eq(freightReconciliation.entryId, freightEntry.id))
      .where(where)
      .orderBy(desc(freightEntry.ts), desc(freightEntry.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() })
      .from(freightEntry)
      .innerJoin(freightCharge, eq(freightCharge.id, freightEntry.chargeId))
      .where(where),
  ]);
  return { rows, total: totalRow?.value ?? 0, page, pageSize };
}

/** Finance/Admin charge register, including recipient freight not yet collected. */
export async function pageFreightCharges(
  scope: Principal,
  input: { branchId?: string; awbOrCode?: string; payer?: "sender" | "recipient"; page: number; pageSize: number },
) {
  const filters: SQL[] = [];
  if (!isGlobalScope(scope.role)) filters.push(eq(freightCharge.branchId, scope.branchId));
  else if (input.branchId) filters.push(eq(freightCharge.branchId, input.branchId));
  if (input.payer) filters.push(eq(freightCharge.payer, input.payer));
  const term = input.awbOrCode?.trim().replace(/[%_]/g, "");
  if (term) {
    filters.push(or(
      like(freightCharge.awb, `%${term}%`),
      like(freightCharge.code, `%${term}%`),
      like(freightCharge.senderName, `%${term}%`),
      like(freightCharge.recipientName, `%${term}%`),
      like(freightCharge.senderPhone, `%${term}%`),
      like(freightCharge.recipientPhone, `%${term}%`),
    )!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const page = Math.max(1, input.page);
  const pageSize = Math.min(100, Math.max(1, input.pageSize));
  const paid = sql<number>`coalesce(sum(${freightEntry.amountCents}), 0)`;
  const [rows, [totalRow]] = await Promise.all([
    db.select({ charge: freightCharge, paidCents: paid })
      .from(freightCharge)
      .leftJoin(freightEntry, eq(freightEntry.chargeId, freightCharge.id))
      .where(where)
      .groupBy(freightCharge.id)
      .orderBy(desc(freightCharge.createdAt), desc(freightCharge.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(freightCharge).where(where),
  ]);
  return {
    rows: rows.map(({ charge, paidCents }) => ({
      charge,
      paidCents: Number(paidCents),
      dueCents: charge.amountCents - Number(paidCents),
    })),
    total: totalRow?.value ?? 0,
    page,
    pageSize,
  };
}

/** Finance/Admin confirm receipt/clearing of an immutable collection event. */
export async function reconcileFreightEntry(
  input: { entryId: string; reference: string; note?: string | null },
  actor: Principal,
) {
  if (actor.role !== "finance" && actor.role !== "admin") errors.forbidden("Only Finance/Admin may reconcile customer freight.");
  return db.transaction(async (tx) => {
    const [entry] = await tx.select().from(freightEntry).where(eq(freightEntry.id, input.entryId)).limit(1);
    if (!entry) errors.notFound("Freight entry");
    if (entry!.entryType !== "collection" || entry!.amountCents <= 0) {
      errors.badRequest("Only positive freight collection entries can be reconciled.");
    }
    const [existing] = await tx.select().from(freightReconciliation).where(eq(freightReconciliation.entryId, entry!.id)).limit(1);
    if (existing) errors.conflict(`Receipt ${entry!.code} has already been reconciled.`);
    const [saved] = await tx.insert(freightReconciliation).values({
      id: prefixedId("frx"),
      entryId: entry!.id,
      branchId: entry!.branchId,
      reference: input.reference.trim(),
      note: input.note?.trim() || null,
      reconciledById: actor.userId,
      reconciledByName: actor.name,
      reconciledAt: new Date(),
    }).returning();
    return { entry: entry!, reconciliation: saved! };
  });
}

/** Finance/Admin may refund, but every refund is a signed, reasoned ledger row. */
export async function refundFreight(
  input: { chargeId: string; amountCents: number; paymentMethod: "cash" | "bank_transfer" | "qr" | "card"; externalReference?: string | null; reason: string },
  actor: Principal,
) {
  if (actor.role !== "finance" && actor.role !== "admin") errors.forbidden("Only Finance/Admin may refund customer freight.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) errors.badRequest("Refund must be a positive integer number of cents.");
  if (input.reason.trim().length < 8) errors.badRequest("A clear reason is required for a freight refund.");
  return db.transaction(async (tx) => {
    const [charge] = await tx.select().from(freightCharge).where(eq(freightCharge.id, input.chargeId)).limit(1);
    if (!charge) errors.notFound("Freight charge");
    const existing = await tx.select().from(freightEntry).where(eq(freightEntry.chargeId, charge!.id));
    const collected = existing.reduce((sum, entry) => sum + Math.max(0, entry.amountCents), 0);
    const refunded = existing.reduce((sum, entry) => sum + Math.max(0, -entry.amountCents), 0);
    if (input.amountCents > collected - refunded) {
      errors.badRequest("Refund exceeds the unrefunded freight collected.", { availableCents: collected - refunded });
    }
    const source = existing.find((entry) => entry.entryType === "collection");
    const entry = await insertEntry(tx, {
      chargeId: charge!.id,
      parcelId: charge!.parcelId,
      awb: charge!.awb,
      branchId: charge!.branchId,
      payer: charge!.payer,
      entryType: "refund",
      amountCents: -input.amountCents,
      paymentMethod: input.paymentMethod,
      externalReference: input.externalReference?.trim() || null,
      collectorId: actor.userId,
      collectorName: actor.name,
      collectorRole: actor.role,
      riderId: null,
      runsheetId: null,
      clientId: `refund:${prefixedId("op")}`,
      reversalOfId: source?.id ?? null,
      reason: input.reason.trim(),
      codePrefix: "RFD",
    });
    return { charge: charge!, entry, paidCents: collected - refunded - input.amountCents };
  });
}

export async function freightReceipt(code: string, scope: Principal) {
  const [row] = await db.select({ entry: freightEntry, charge: freightCharge, reconciliation: freightReconciliation })
    .from(freightEntry)
    .innerJoin(freightCharge, eq(freightCharge.id, freightEntry.chargeId))
    .leftJoin(freightReconciliation, eq(freightReconciliation.entryId, freightEntry.id))
    .where(eq(freightEntry.code, code)).limit(1);
  if (!row) errors.notFound("Freight receipt");
  if (!isGlobalScope(scope.role) && row!.entry.branchId !== scope.branchId) errors.forbidden("This receipt belongs to another branch.");
  return row!;
}

export async function isFreightChargePaid(charge: FreightChargeRow): Promise<boolean> {
  const entries = await entriesForCharge(charge.id);
  return netPaid(entries) === charge.amountCents;
}
