import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";

/**
 * MODULE: delivery — runsheets, delivery attempts, proof of delivery, the NDR
 * queue and the RTO flow (PROJECT.md §10 M3).
 *
 * PROJECT.md §4: only modules/delivery/service.ts reads these tables. Parcel
 * rows are reached through modules/parcels/service.ts, never selected here.
 *
 * NON-NEGOTIABLE (§1): "a parcel must never be lost" and "money must reconcile
 * to the cent". Every attempt is an append-only row; a delivery without a POD
 * row is impossible by construction (§6); a third failed attempt raises RTO
 * automatically rather than leaving the parcel to rot in a rider's bag.
 */

/**
 * A rider's delivery run for one day out of one hub (§10 M3 "delivery
 * runsheets, route-order optimisation").
 *
 * The runsheet is the unit a rider is accountable for: it is claimed by exactly
 * one rider, and §7's conflict policy ("two riders claim one parcel — server
 * rejects the later claim") is enforced against this row's rider_id.
 */
export const runsheet = sqliteTable(
  "delivery_runsheet",
  {
    id: text("id").primaryKey(),
    /** Human-readable, read out over the phone: RS260930-0001. */
    code: text("code").notNull().unique(),
    riderId: text("rider_id").notNull(),
    riderName: text("rider_name").notNull(),
    /** Branch accountable for the run — row-level scoping (§5). */
    branchId: text("branch_id").notNull(),
    hubId: text("hub_id").notNull(),
    /** Delivery date as YYYY-MM-DD in Asia/Colombo (§9) — never a UTC instant. */
    runDate: text("run_date").notNull(),
    /** draft | dispatched | closed | cancelled */
    status: text("status").notNull().default("draft"),

    plannedCount: integer("planned_count").notNull().default(0),
    deliveredCount: integer("delivered_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /** MONEY: integer cents, LKR (§9). COD the rider is expected to bring back. */
    codExpectedCents: integer("cod_expected_cents").notNull().default(0),
    codCollectedCents: integer("cod_collected_cents").notNull().default(0),

    /**
     * How the stop order was produced. KNOWN DEVIATION: §5 mandates PostGIS;
     * this is a JS nearest-neighbour sweep over stored microdegree points.
     */
    routeMethod: text("route_method"),
    routeDistanceMetres: integer("route_distance_metres"),
    optimisedAt: integer("optimised_at", { mode: "timestamp" }),

    dispatchedAt: integer("dispatched_at", { mode: "timestamp" }),
    closedAt: integer("closed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdByName: text("created_by_name"),
  },
  (t) => [
    index("delivery_runsheet_rider_idx").on(t.riderId, t.runDate),
    index("delivery_runsheet_branch_idx").on(t.branchId, t.runDate),
    index("delivery_runsheet_status_idx").on(t.status),
  ],
);

/**
 * One stop on a runsheet. `seq` is the optimised route order; the rider may
 * deliver out of order (traffic, a locked gate) and the attempt row records
 * what actually happened — the sequence is advice, not a constraint.
 *
 * The unique constraint on (runsheet_id, parcel_id) is what makes a re-pushed
 * offline build a no-op instead of a duplicated stop.
 */
export const runsheetItem = sqliteTable(
  "delivery_runsheet_item",
  {
    id: text("id").primaryKey(),
    runsheetId: text("runsheet_id").notNull(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    seq: integer("seq").notNull().default(0),
    /** pending | delivered | failed | removed */
    state: text("state").notNull().default("pending"),
    /** Attempts made on this parcel across all runsheets, copied for the rider's view. */
    attemptNo: integer("attempt_no").notNull().default(0),

    consigneeName: text("consignee_name").notNull(),
    consigneePhone: text("consignee_phone").notNull(),
    destAddress: text("dest_address").notNull(),
    destLat: integer("dest_lat_e6"),
    destLng: integer("dest_lng_e6"),
    /** Metres from the previous stop on the optimised order — rider ETA hint. */
    legMetres: integer("leg_metres"),
    /** MONEY: integer cents, LKR (§9). */
    codAmountCents: integer("cod_amount_cents").notNull().default(0),

    settledAt: integer("settled_at", { mode: "timestamp" }),
    /** Client-minted ULID for offline dedupe (§7). */
    clientId: text("client_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("delivery_rs_item_runsheet_idx").on(t.runsheetId, t.seq),
    index("delivery_rs_item_parcel_idx").on(t.parcelId),
    index("delivery_rs_item_state_idx").on(t.state),
    unique("delivery_rs_item_unique").on(t.runsheetId, t.parcelId),
  ],
);

/**
 * APPEND-ONLY. Every doorstep event, successful or not (§6: "Maximum 3 delivery
 * attempts, then automatic RTOInitiated" — this table is what counts them).
 *
 * Never updated, never deleted. A wrong attempt is corrected by a reversal
 * event recorded by ops, exactly as §6 requires for terminal states.
 */
export const deliveryAttempt = sqliteTable(
  "delivery_attempt",
  {
    id: text("id").primaryKey(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    runsheetId: text("runsheet_id"),
    runsheetItemId: text("runsheet_item_id"),
    /** 1-based, counted across every runsheet the parcel has ever been on. */
    attemptNo: integer("attempt_no").notNull(),
    /** delivered | failed */
    outcome: text("outcome").notNull(),
    /** Reference to delivery_reason_code.code — required when outcome = failed. */
    reasonCode: text("reason_code"),
    reasonLabel: text("reason_label"),
    notes: text("notes"),
    podId: text("pod_id"),

    riderId: text("rider_id"),
    riderName: text("rider_name"),
    deviceId: text("device_id"),
    lat: integer("lat_e6"),
    lng: integer("lng_e6"),
    /** Client-minted ULID for offline dedupe (§7). */
    clientId: text("client_id"),
    /** When the rider's device recorded it — may precede `ts` by hours offline. */
    clientTs: integer("client_ts", { mode: "timestamp" }),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("delivery_attempt_parcel_idx").on(t.parcelId),
    index("delivery_attempt_runsheet_idx").on(t.runsheetId),
    index("delivery_attempt_client_idx").on(t.clientId),
    index("delivery_attempt_reason_idx").on(t.reasonCode),
  ],
);

/**
 * Proof of delivery. §6: "Delivered requires POD: signature or OTP or photo,
 * configurable per merchant." A Delivered transition without a row here cannot
 * happen — modules/delivery/service.ts writes the POD first and refuses the
 * transition if the merchant's required method is missing.
 *
 * APPEND-ONLY.
 */
export const deliveryPod = sqliteTable(
  "delivery_pod",
  {
    id: text("id").primaryKey(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    /** otp | signature | photo */
    method: text("method").notNull(),
    /** Who physically took the parcel — may not be the consignee. */
    receivedByName: text("received_by_name").notNull(),
    /** self | family | neighbour | security | reception | other */
    receivedByRelation: text("received_by_relation"),
    /** True only when an OTP challenge was verified server-side. */
    otpVerified: integer("otp_verified", { mode: "boolean" }).notNull().default(false),
    otpChallengeId: text("otp_challenge_id"),
    /**
     * Signature as an SVG path / base64 PNG data URI captured on the device.
     * Stored inline: a signature is evidence, and evidence that lives in a
     * separate bucket that can 404 is not evidence.
     */
    signatureData: text("signature_data"),
    /** Uploaded doorstep photo reference. */
    photoUrl: text("photo_url"),
    photoNote: text("photo_note"),

    capturedById: text("captured_by_id"),
    capturedByName: text("captured_by_name"),
    deviceId: text("device_id"),
    lat: integer("lat_e6"),
    lng: integer("lng_e6"),
    clientId: text("client_id"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("delivery_pod_parcel_idx").on(t.parcelId),
    index("delivery_pod_client_idx").on(t.clientId),
  ],
);

/**
 * Delivery OTP challenge (§9: "OTP is SMS-only. No WhatsApp OTP, no voice
 * fallback. If no DLR arrives, fall back to resend-and-expire.").
 *
 * The code is stored hashed: an ops user reading the database must not be able
 * to complete a delivery on a rider's behalf.
 */
export const deliveryOtp = sqliteTable(
  "delivery_otp",
  {
    id: text("id").primaryKey(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    codeHash: text("code_hash").notNull(),
    sentToPhone: text("sent_to_phone").notNull(),
    smsLogId: text("sms_log_id"),
    /** Wrong-code attempts. Locked out after 5. */
    attempts: integer("attempts").notNull().default(0),
    /** How many times the rider asked for a resend — the no-DLR fallback (§9). */
    resendCount: integer("resend_count").notNull().default(0),
    requestedById: text("requested_by_id"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("delivery_otp_parcel_idx").on(t.parcelId)],
);

/**
 * The NDR (non-delivery report) queue — §10 M3. One live row per parcel that
 * has failed delivery, worked by ops and answered by the merchant.
 *
 * This is the queue that decides a failed parcel's fate: reattempt, change of
 * address, hold, or return to sender. Nothing silently expires out of it.
 */
export const ndr = sqliteTable(
  "delivery_ndr",
  {
    id: text("id").primaryKey(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    branchId: text("branch_id").notNull(),
    merchantId: text("merchant_id").notNull(),
    /** Attempts at the moment the report was raised or last updated. */
    attempts: integer("attempts").notNull().default(1),
    lastReasonCode: text("last_reason_code"),
    lastReasonLabel: text("last_reason_label"),
    /** open | instructed | reattempt_scheduled | rto | resolved | closed */
    state: text("state").notNull().default("open"),

    /** reattempt | rto | hold | address_change — the merchant's answer. */
    merchantInstruction: text("merchant_instruction"),
    instructionNotes: text("instruction_notes"),
    instructedByName: text("instructed_by_name"),
    instructedAt: integer("instructed_at", { mode: "timestamp" }),
    /** Corrected delivery details supplied with an address_change instruction. */
    newAddress: text("new_address"),
    newPhone: text("new_phone"),
    reattemptDate: text("reattempt_date"),

    /** SLA clock (§8 configurable per merchant; default 24h from raise). */
    slaDueAt: integer("sla_due_at", { mode: "timestamp" }),
    raisedAt: integer("raised_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    actionedAt: integer("actioned_at", { mode: "timestamp" }),
    actionedByName: text("actioned_by_name"),
    closedAt: integer("closed_at", { mode: "timestamp" }),
    closeReason: text("close_reason"),
  },
  (t) => [
    index("delivery_ndr_state_idx").on(t.state),
    index("delivery_ndr_branch_idx").on(t.branchId),
    index("delivery_ndr_merchant_idx").on(t.merchantId),
    index("delivery_ndr_parcel_idx").on(t.parcelId),
    index("delivery_ndr_sla_idx").on(t.slaDueAt),
  ],
);

/**
 * RTO (return to origin) — the parcel's journey back to the merchant. Raised
 * either by an ops/merchant instruction or automatically by §6's three-attempt
 * rule. Mirrors the outbound leg: initiated → in transit → delivered back.
 */
export const rto = sqliteTable(
  "delivery_rto",
  {
    id: text("id").primaryKey(),
    parcelId: text("parcel_id").notNull(),
    awb: text("awb").notNull(),
    branchId: text("branch_id").notNull(),
    merchantId: text("merchant_id").notNull(),
    /** auto_max_attempts | merchant_instruction | ops_decision | consignee_refused */
    trigger: text("trigger").notNull(),
    reason: text("reason").notNull(),
    /** initiated | in_transit | delivered | closed */
    state: text("state").notNull().default("initiated"),
    /** Attempts the parcel had when RTO was raised — the evidence for the charge. */
    attemptsAtInitiation: integer("attempts_at_initiation").notNull().default(0),

    initiatedAt: integer("initiated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    initiatedByName: text("initiated_by_name"),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
    /** Who at the merchant signed for the return. */
    receivedByName: text("received_by_name"),
    notes: text("notes"),
  },
  (t) => [
    index("delivery_rto_state_idx").on(t.state),
    index("delivery_rto_merchant_idx").on(t.merchantId),
    index("delivery_rto_parcel_idx").on(t.parcelId),
  ],
);

/**
 * Failure reason codes (§10 M3 "failure reason codes"). A reference table, not
 * an enum in code, because §10 M5 hands its editing to the admin portal and
 * because the flags below are business rules ops tunes without a deploy.
 *
 * `countsAsAttempt = false` is the important one: a flood, a breakdown or a
 * curfew is NatEx's failure, not the consignee's, and must not burn one of the
 * parcel's three attempts.
 */
export const reasonCode = sqliteTable(
  "delivery_reason_code",
  {
    code: text("code").primaryKey(),
    label: text("label").notNull(),
    /** consignee | address | payment | parcel | courier */
    category: text("category").notNull(),
    /** Does this failure consume one of the 3 attempts (§6)? */
    countsAsAttempt: integer("counts_as_attempt", { mode: "boolean" }).notNull().default(true),
    /** May the parcel go out again without a merchant instruction? */
    allowsReattempt: integer("allows_reattempt", { mode: "boolean" }).notNull().default(true),
    /** Does this failure send the parcel straight back, skipping the NDR wait? */
    triggersRto: integer("triggers_rto", { mode: "boolean" }).notNull().default(false),
    /** Is the consignee told about this failure? Some reasons are internal. */
    notifyConsignee: integer("notify_consignee", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("delivery_reason_category_idx").on(t.category, t.sortOrder)],
);
