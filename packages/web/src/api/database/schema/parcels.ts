import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * MODULE: parcels — parcel lifecycle + append-only custody events.
 * PROJECT.md §4: only modules/parcels/service.ts reads these tables.
 *
 * NON-NEGOTIABLE (PROJECT.md §1, §6): parcel_event is append-only. There is no
 * UPDATE or DELETE path to it anywhere in this codebase — the only writer is
 * appendParcelEvent() in modules/parcels/service.ts.
 */

export const parcel = sqliteTable(
  "parcels_parcel",
  {
    id: text("id").primaryKey(),
    /** AWB is the public identity (PROJECT.md §5). */
    awb: text("awb").notNull().unique(),
    merchantId: text("merchant_id").notNull(),
    /** Branch currently accountable for the parcel — row-level scoping. */
    branchId: text("branch_id").notNull(),
    /** Enumerated state, advanced only through legal transitions (PROJECT.md §6). */
    status: text("status").notNull(),
    /** Grams — integer, never float. */
    weightGrams: integer("weight_grams").notNull(),
    lengthCm: integer("length_cm"),
    widthCm: integer("width_cm"),
    heightCm: integer("height_cm"),
    /** MONEY: integer cents, LKR (PROJECT.md §9). Never float/double. */
    declaredValueCents: integer("declared_value_cents").notNull().default(0),
    codAmountCents: integer("cod_amount_cents").notNull().default(0),
    /** Locked once Delivered; only Finance may adjust, with audit (PROJECT.md §6). */
    codLockedAt: integer("cod_locked_at", { mode: "timestamp" }),

    originAddress: text("origin_address").notNull(),
    originLat: integer("origin_lat_e6"),
    originLng: integer("origin_lng_e6"),

    consigneeName: text("consignee_name").notNull(),
    /** PDPA No. 9 of 2022 personal data — retention policy applies (PROJECT.md §9). */
    consigneePhone: text("consignee_phone").notNull(),
    destAddress: text("dest_address").notNull(),
    destLat: integer("dest_lat_e6"),
    destLng: integer("dest_lng_e6"),
    destZoneId: text("dest_zone_id"),

    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("parcels_parcel_status_idx").on(t.status),
    index("parcels_parcel_branch_idx").on(t.branchId),
    index("parcels_parcel_merchant_idx").on(t.merchantId),
  ],
);

/** A fixed range of physical AWB stickers with explicit planned/assigned ownership. */
export const awbBatch = sqliteTable(
  "parcels_awb_batch",
  {
    id: text("id").primaryKey(),
    batchCode: text("batch_code").notNull().unique(),
    merchantId: text("merchant_id").notNull(),
    /** Snapshot for batch history if the merchant is renamed later. */
    merchantName: text("merchant_name").notNull(),
    /** Null on legacy merchant-owned batches; planned | assigned on new rows. */
    assignmentStatus: text("assignment_status"),
    /** merchant | branch | hub; null until assigned. */
    assigneeType: text("assignee_type"),
    assigneeId: text("assignee_id"),
    assigneeName: text("assignee_name"),
    assignedAt: integer("assigned_at", { mode: "timestamp" }),
    assignedById: text("assigned_by_id"),
    assignedByName: text("assigned_by_name"),
    awbStart: text("awb_start").notNull(),
    awbEnd: text("awb_end").notNull(),
    labelCount: integer("label_count").notNull().default(1000),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("parcels_awb_batch_merchant_idx").on(t.merchantId, t.createdAt),
    index("parcels_awb_batch_assignee_idx").on(t.assignmentStatus, t.assigneeType, t.assigneeId),
    index("parcels_awb_batch_range_idx").on(t.awbStart, t.awbEnd),
  ],
);
/** Each AWB is reserved globally at issue time; a parcel row marks it as used. */
export const awbBatchLabel = sqliteTable(
  "parcels_awb_batch_label",
  {
    awb: text("awb").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => awbBatch.id),
  },
  (t) => [index("parcels_awb_batch_label_batch_idx").on(t.batchId, t.awb)],
);

/** APPEND-ONLY. Never updated, never deleted (§5). */
export const parcelEvent = sqliteTable(
  "parcels_parcel_event",
  {
    id: text("id").primaryKey(),
    parcelId: text("parcel_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    deviceId: text("device_id"),
    lat: integer("lat_e6"),
    lng: integer("lng_e6"),
    notes: text("notes"),
    /** Client-minted ULID for offline dedupe (PROJECT.md §7). */
    clientId: text("client_id"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("parcels_event_parcel_idx").on(t.parcelId),
    index("parcels_event_client_idx").on(t.clientId),
  ],
);
