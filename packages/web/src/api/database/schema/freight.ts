import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { branch } from "./identity";
import { parcel } from "./parcels";

/**
 * Customer freight is a separate accounting domain from COD and merchant
 * settlements. Walk-in customer snapshots are retained here; the parcel's
 * merchant_id stays NULL for counter customers.
 */
export const freightCharge = sqliteTable(
  "freight_charge",
  {
    id: text("id").primaryKey(),
    /** Collision-safe, human-readable freight charge/waybill reference. */
    code: text("code").notNull().unique(),
    parcelId: text("parcel_id").notNull().unique().references(() => parcel.id),
    awb: text("awb").notNull(),
    branchId: text("branch_id").notNull().references(() => branch.id),
    branchName: text("branch_name").notNull(),
    /** sender | recipient — locked at booking. */
    payer: text("payer").notNull(),
    /** Manual price snapshot in integer LKR cents. */
    amountCents: integer("amount_cents").notNull(),
    pricingBasis: text("pricing_basis").notNull().default("manual"),
    senderName: text("sender_name").notNull(),
    senderPhone: text("sender_phone").notNull(),
    senderAddress: text("sender_address"),
    recipientName: text("recipient_name").notNull(),
    recipientPhone: text("recipient_phone").notNull(),
    destinationAddress: text("destination_address").notNull(),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    /** HTTP idempotency key: allows a timed-out intake request to resume safely. */
    bookingRequestId: text("booking_request_id").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("freight_charge_branch_idx").on(t.branchId, t.createdAt)],
);

/**
 * APPEND-ONLY customer freight money ledger. Collections are positive cents;
 * refunds are negative; adjustments are signed and require a reason. No row is
 * edited or deleted. Each event has its own receipt/reference and actor.
 */
export const freightEntry = sqliteTable(
  "freight_entry",
  {
    id: text("id").primaryKey(),
    chargeId: text("charge_id").notNull().references(() => freightCharge.id),
    parcelId: text("parcel_id").notNull().references(() => parcel.id),
    awb: text("awb").notNull(),
    branchId: text("branch_id").notNull().references(() => branch.id),
    /** Snapshotted payer: sender | recipient. */
    payer: text("payer").notNull(),
    /** collection | refund | adjustment */
    entryType: text("entry_type").notNull(),
    /** Signed integer cents; collection > 0, refund < 0. */
    amountCents: integer("amount_cents").notNull(),
    /** cash | bank_transfer | qr | card | adjustment */
    paymentMethod: text("payment_method").notNull(),
    externalReference: text("external_reference"),
    /** A receipt number for every posted money event. */
    code: text("code").notNull().unique(),
    collectorId: text("collector_id").notNull(),
    collectorName: text("collector_name").notNull(),
    collectorRole: text("collector_role").notNull(),
    riderId: text("rider_id"),
    runsheetId: text("runsheet_id"),
    /** Device/client operation id for offline delivery dedupe. */
    clientId: text("client_id").unique(),
    reversalOfId: text("reversal_of_id"),
    reason: text("reason"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("freight_entry_branch_idx").on(t.branchId, t.ts),
    index("freight_entry_charge_idx").on(t.chargeId, t.ts),
    index("freight_entry_rider_idx").on(t.riderId, t.ts),
    index("freight_entry_awb_idx").on(t.awb),
    uniqueIndex("freight_entry_one_collection_per_charge")
      .on(t.chargeId)
      .where(sql`${t.entryType} = 'collection'`),
  ],
);

/** Immutable Finance/Admin confirmation that one ledger entry cleared at branch/bank. */
export const freightReconciliation = sqliteTable(
  "freight_reconciliation",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").notNull().unique().references(() => freightEntry.id),
    branchId: text("branch_id").notNull().references(() => branch.id),
    reference: text("reference").notNull(),
    note: text("note"),
    reconciledById: text("reconciled_by_id").notNull(),
    reconciledByName: text("reconciled_by_name").notNull(),
    reconciledAt: integer("reconciled_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("freight_recon_branch_idx").on(t.branchId, t.reconciledAt)],
);

export type FreightChargeRow = typeof freightCharge.$inferSelect;
export type FreightEntryRow = typeof freightEntry.$inferSelect;
export type FreightReconciliationRow = typeof freightReconciliation.$inferSelect;
