import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * MODULE: collection — pickups, manifests, two-party handover.
 * PROJECT.md §4: only modules/collection/service.ts reads these tables.
 */

/** A pickup batch: one merchant, one rider, one date. */
export const manifest = sqliteTable(
  "collection_manifest",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    merchantId: text("merchant_id").notNull(),
    branchId: text("branch_id").notNull(),
    riderId: text("rider_id"),
    /** manual | merchant_default — visible to ops and the Rider app. */
    assignmentSource: text("assignment_source").notNull().default("manual"),
    /** Set only while an automatically grouped manifest is open; cleared on handover. */
    autoKey: text("auto_key"),
    /** YYYY-MM-DD in Asia/Colombo. */
    pickupDate: text("pickup_date").notNull(),
    /** assigned | in_progress | handed_over | cancelled */
    status: text("status").notNull().default("assigned"),
    /** S3 key of the merchant's handover signature. */
    signatureUrl: text("signature_url"),
    handedOverAt: integer("handed_over_at", { mode: "timestamp" }),
    /** Two-party handover: who released, who received. */
    handoverByName: text("handover_by_name"),
    expectedCount: integer("expected_count").notNull().default(0),
    scannedCount: integer("scanned_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("collection_manifest_rider_idx").on(t.riderId),
    index("collection_manifest_branch_idx").on(t.branchId),
    uniqueIndex("collection_manifest_auto_key_uq").on(t.autoKey).where(sql`${t.autoKey} IS NOT NULL`),
  ],
);

/** Parcels expected on / scanned into a manifest. */
export const manifestItem = sqliteTable(
  "collection_manifest_item",
  {
    id: text("id").primaryKey(),
    manifestId: text("manifest_id").notNull(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    scannedAt: integer("scanned_at", { mode: "timestamp" }),
    scannedBy: text("scanned_by"),
  },
  (t) => [
    index("collection_item_manifest_idx").on(t.manifestId),
    index("collection_item_parcel_idx").on(t.parcelId),
  ],
);

/**
 * A merchant asking NatEx to come and collect (§10 M3 merchant portal:
 * "pickups"). The merchant names a date, a window and the Booked parcels that
 * will be waiting; ops answers by building a manifest from it, which links the
 * two and moves the request to `scheduled`. A request never moves custody —
 * that still happens exactly once, at the two-party handover.
 *
 * status: requested | scheduled | cancelled
 */
export const pickupRequest = sqliteTable(
  "collection_pickup_request",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    merchantId: text("merchant_id").notNull(),
    branchId: text("branch_id").notNull(),
    /** YYYY-MM-DD in Asia/Colombo. */
    pickupDate: text("pickup_date").notNull(),
    /** morning (09:00–12:00) | afternoon (13:00–17:00) */
    window: text("window").notNull(),
    /** JSON array of the AWBs the merchant declared for this pickup. */
    awbs: text("awbs").notNull(),
    parcelCount: integer("parcel_count").notNull(),
    notes: text("notes"),
    status: text("status").notNull().default("requested"),
    manifestId: text("manifest_id"),
    requestedBy: text("requested_by").notNull(),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    cancelReason: text("cancel_reason"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("collection_pickup_request_merchant_idx").on(t.merchantId),
    index("collection_pickup_request_branch_idx").on(t.branchId, t.status),
  ],
);
