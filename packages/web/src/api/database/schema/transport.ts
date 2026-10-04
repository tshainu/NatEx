import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";

/**
 * MODULE: transport — bags, linehaul trips, hub scans, custody exceptions.
 * PROJECT.md §4: only modules/transport/service.ts reads these tables. The
 * parcel rows themselves are reached through modules/parcels/service.ts.
 *
 * NON-NEGOTIABLE (§1): "a parcel must never be lost". Every physical movement
 * here — a scan into a bag, a seal, a departure, a hub arrival — leaves a row
 * that is never updated away, and any count that fails to match produces a
 * transport_exception row rather than a silent correction.
 */

/**
 * The physical custody unit (§5 `bag`). A bag is the thing a hub actually hands
 * to a driver: parcels move between hubs inside one, never loose.
 */
export const bag = sqliteTable(
  "transport_bag",
  {
    id: text("id").primaryKey(),
    /** Human-readable, printed on the bag label. */
    code: text("code").notNull().unique(),
    /**
     * Physical tamper-evident seal number, written on the bag when it is
     * closed. Null until sealed — §6 makes a seal the precondition for
     * Bagged → InTransit.
     */
    sealNumber: text("seal_number"),
    originHubId: text("origin_hub_id").notNull(),
    destHubId: text("dest_hub_id").notNull(),
    /** Branch accountable for the bag right now — row-level scoping (§5). */
    branchId: text("branch_id").notNull(),
    /** open | sealed | in_transit | received | reconciled | cancelled */
    status: text("status").notNull().default("open"),
    /** Trip the bag is loaded onto. Null until assigned. */
    tripId: text("trip_id"),
    /** Gross weight in grams — integer, never float. */
    weightGrams: integer("weight_grams").notNull().default(0),
    /** Parcels scanned in. Maintained alongside transport_bag_item, never instead of it. */
    itemCount: integer("item_count").notNull().default(0),
    sealedAt: integer("sealed_at", { mode: "timestamp" }),
    sealedByName: text("sealed_by_name"),
    receivedAt: integer("received_at", { mode: "timestamp" }),
    receivedByName: text("received_by_name"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByName: text("created_by_name"),
    /**
     * Optional photo of the bag as handed over (Round 6, 2026-10-03). Object
     * key `s3:bag/<code>/<id>.<ext>`, never a presigned URL — it must stay
     * resolvable for as long as a custody exception can be raised.
     */
    photoRef: text("photo_ref"),
    photoAt: integer("photo_at", { mode: "timestamp" }),
    photoByName: text("photo_by_name"),
  },
  (t) => [
    index("transport_bag_status_idx").on(t.status),
    index("transport_bag_branch_idx").on(t.branchId),
    index("transport_bag_trip_idx").on(t.tripId),
    index("transport_bag_dest_idx").on(t.destHubId),
  ],
);

/**
 * One parcel inside one bag (§5 `bag_item`). The unique constraint on
 * (bag_id, parcel_id) is what makes a duplicate bulk scan a no-op instead of a
 * double count — riders and hub staff scan the same label twice constantly.
 */
export const bagItem = sqliteTable(
  "transport_bag_item",
  {
    id: text("id").primaryKey(),
    bagId: text("bag_id").notNull(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    scannedAt: integer("scanned_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    scannedById: text("scanned_by_id"),
    scannedByName: text("scanned_by_name"),
    deviceId: text("device_id"),
    /** Removed from the bag before sealing — kept for the audit trail, not deleted. */
    removedAt: integer("removed_at", { mode: "timestamp" }),
    removedByName: text("removed_by_name"),
  },
  (t) => [
    index("transport_bag_item_bag_idx").on(t.bagId),
    index("transport_bag_item_parcel_idx").on(t.parcelId),
    unique("transport_bag_item_unique").on(t.bagId, t.parcelId),
  ],
);

/** A linehaul movement between two hubs (§5 `trip`). */
export const trip = sqliteTable(
  "transport_trip",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    vehicleRegistration: text("vehicle_registration").notNull(),
    driverId: text("driver_id"),
    driverName: text("driver_name"),
    originHubId: text("origin_hub_id").notNull(),
    destHubId: text("dest_hub_id").notNull(),
    branchId: text("branch_id").notNull(),
    /** Free-text route description, e.g. "CMB01 → KDY02 via A1". */
    route: text("route"),
    /** planned | loading | departed | arrived | closed | cancelled */
    status: text("status").notNull().default("planned"),
    /** Vehicle seal applied at departure. */
    seal: text("seal"),
    departedAt: integer("departed_at", { mode: "timestamp" }),
    arrivedAt: integer("arrived_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByName: text("created_by_name"),
    /*
     * Round 6 (2026-10-03) — what the hub records when it hands bags to a
     * vehicle. All nullable: trips created before this change have none of it,
     * and the API accepts a trip without them; the web form asks for them.
     */
    /** bus | van | lorry | car — see TRIP_VEHICLE_TYPES. */
    vehicleType: text("vehicle_type"),
    /** ctb | private | ac_bus — required when vehicle_type = bus, null otherwise. */
    busOperator: text("bus_operator"),
    /** Person on the vehicle to call (driver, conductor). */
    contactName: text("contact_name"),
    /** E.164, +94XXXXXXXXX. */
    contactPhone: text("contact_phone"),
    expectedArrivalAt: integer("expected_arrival_at", { mode: "timestamp" }),
    /** Where the bus drops the bags — station or stop name, typed in. */
    arrivalStation: text("arrival_station"),
  },
  (t) => [
    index("transport_trip_status_idx").on(t.status),
    index("transport_trip_branch_idx").on(t.branchId),
  ],
);

/**
 * Append-only log of every scan performed at a hub or on a vehicle. This is the
 * raw evidence layer beneath the parcel timeline: it records scans that were
 * *rejected* too, which the parcel timeline by definition cannot.
 * Never updated, never deleted.
 */
export const hubScan = sqliteTable(
  "transport_hub_scan",
  {
    id: text("id").primaryKey(),
    /** bag_in | bag_out | parcel_in | parcel_out | bag_receive | trip_load */
    kind: text("kind").notNull(),
    awb: text("awb"),
    parcelId: text("parcel_id"),
    bagId: text("bag_id"),
    tripId: text("trip_id"),
    branchId: text("branch_id").notNull(),
    hubId: text("hub_id"),
    /** accepted | duplicate | rejected */
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    deviceId: text("device_id"),
    lat: integer("lat_e6"),
    lng: integer("lng_e6"),
    /** Client-minted ULID for offline dedupe (§7). */
    clientId: text("client_id"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("transport_hub_scan_branch_idx").on(t.branchId),
    index("transport_hub_scan_bag_idx").on(t.bagId),
    index("transport_hub_scan_ts_idx").on(t.ts),
    index("transport_hub_scan_client_idx").on(t.clientId),
  ],
);

/**
 * The Ops exception queue (§7: "Every unresolved conflict appears in the Ops
 * exception queue. Silent data loss is unacceptable in a logistics system.").
 *
 * Variance detection writes here: a parcel expected in a bag that never
 * arrived, a parcel that arrived in a bag it was never scanned into, a seal
 * mismatch, a scan against a parcel in an impossible state. Resolution is
 * recorded, the row is never deleted.
 */
export const custodyException = sqliteTable(
  "transport_exception",
  {
    id: text("id").primaryKey(),
    /**
     * missing_at_destination | unexpected_at_destination | seal_mismatch |
     * illegal_scan | duplicate_claim | count_variance | stale_custody
     */
    kind: text("kind").notNull(),
    /** low | medium | high */
    severity: text("severity").notNull().default("medium"),
    branchId: text("branch_id").notNull(),
    awb: text("awb"),
    parcelId: text("parcel_id"),
    bagId: text("bag_id"),
    tripId: text("trip_id"),
    detail: text("detail").notNull(),
    /** JSON blob of whatever evidence the detector had. */
    evidenceJson: text("evidence_json"),
    /** open | investigating | resolved | written_off */
    status: text("status").notNull().default("open"),
    resolution: text("resolution"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    resolvedByName: text("resolved_by_name"),
    raisedById: text("raised_by_id"),
    raisedByName: text("raised_by_name"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("transport_exception_status_idx").on(t.status),
    index("transport_exception_branch_idx").on(t.branchId),
    index("transport_exception_kind_idx").on(t.kind),
  ],
);
