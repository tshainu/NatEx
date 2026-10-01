import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * MODULE: sync — the server half of the offline-first engine (PROJECT.md §7,
 * "the hardest problem here").
 *
 * §4: only modules/sync/service.ts reads these tables.
 *
 * What §7 demands and what these tables provide:
 * - "Idempotent by construction: the API dedupes on client ID + idempotency
 *   key"  → sync_operation.client_op_id is UNIQUE. A replayed push returns the
 *   stored result rather than applying twice.
 * - "Server authority: the server decides final status"  → result_json holds
 *   the server's verdict, which the client overwrites its local row with.
 * - "Delta pull: fetch changes since the client's cursor"  → sync_device_cursor.
 * - "Every unresolved conflict appears in the Ops exception queue. Silent data
 *   loss is unacceptable."  → sync_conflict, worked in the ops portal. Nothing
 *   is ever discarded: a rejected operation keeps its full payload.
 */

/**
 * The journal of every operation a device has pushed. APPEND-ONLY apart from
 * the state/result columns written once when the operation is decided.
 *
 * This is the audit trail §7's soak test requires ("every operation must land
 * exactly once, in order, with a complete audit trail"). It records operations
 * that were deduped and rejected too — the ones a naive implementation would
 * drop on the floor.
 */
export const syncOperation = sqliteTable(
  "sync_operation",
  {
    id: text("id").primaryKey(),
    /**
     * Client-minted ULID (§7: "records are minted client-side so IDs are
     * stable across retries"). UNIQUE — this column is the dedupe.
     */
    clientOpId: text("client_op_id").notNull().unique(),
    deviceId: text("device_id").notNull(),
    userId: text("user_id").notNull(),
    userRole: text("user_role").notNull(),
    /**
     * Operation kind, e.g. delivery.deliver | delivery.fail | parcel.transition
     * | collection.scan | transport.bagScan. Dispatched by modules/sync.
     */
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    /**
     * The device's own monotonic counter. §7 requires operations land "in
     * order"; the server sorts a pushed batch by this, not by clock time,
     * because the clock may be skewed by ±30 minutes.
     */
    seq: integer("seq").notNull().default(0),
    /** The device's clock at capture — kept verbatim, never trusted for order. */
    clientTs: integer("client_ts", { mode: "timestamp" }),
    /** Detected difference between device and server clock, in seconds. */
    clockSkewSeconds: integer("clock_skew_seconds"),

    /** applied | duplicate | rejected | conflict */
    state: text("state").notNull().default("applied"),
    resultJson: text("result_json"),
    error: text("error"),
    receivedAt: integer("received_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    appliedAt: integer("applied_at", { mode: "timestamp" }),
  },
  (t) => [
    index("sync_operation_device_idx").on(t.deviceId, t.seq),
    index("sync_operation_state_idx").on(t.state),
    index("sync_operation_kind_idx").on(t.kind),
    index("sync_operation_received_idx").on(t.receivedAt),
  ],
);

/**
 * The conflict register — §7's conflict policy table made durable.
 *
 * policy is one of:
 *   duplicate_operation      same parcel transitioned twice → first wins
 *   duplicate_claim          two riders claim one parcel → later claim rejected
 *   offline_delivery_vs_fail delivery confirmed offline, parcel already failed
 *                            → ops manual review, NEVER a silent overwrite
 *   double_cod               COD collected twice → second rejected, both shown
 *   stale_runsheet           runsheet reassigned while offline → client re-pulls
 *   illegal_state            the operation is not legal from the current state
 */
export const syncConflict = sqliteTable(
  "sync_conflict",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull(),
    clientOpId: text("client_op_id").notNull(),
    policy: text("policy").notNull(),
    kind: text("kind").notNull(),
    deviceId: text("device_id"),
    userId: text("user_id"),
    userName: text("user_name"),
    branchId: text("branch_id"),
    parcelId: text("parcel_id"),
    awb: text("awb"),
    /** Plain-English account of what the device claimed vs what the server holds. */
    detail: text("detail").notNull(),
    clientClaimJson: text("client_claim_json"),
    serverStateJson: text("server_state_json"),
    /** open | reviewing | resolved | dismissed */
    state: text("state").notNull().default("open"),
    /** accepted_client | kept_server | manual_correction | dismissed */
    resolution: text("resolution"),
    resolutionNotes: text("resolution_notes"),
    resolvedByName: text("resolved_by_name"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("sync_conflict_state_idx").on(t.state),
    index("sync_conflict_policy_idx").on(t.policy),
    index("sync_conflict_parcel_idx").on(t.parcelId),
  ],
);

/**
 * Per-device delta cursor (§7: "on reconnect, fetch changes since the client's
 * cursor — never the whole dataset").
 *
 * The cursor is a server-clock millisecond watermark, issued by the server on
 * every pull. The device stores it opaquely and never computes one itself —
 * that is what keeps a ±30 minute clock skew from silently skipping records.
 */
export const syncDeviceCursor = sqliteTable(
  "sync_device_cursor",
  {
    deviceId: text("device_id").primaryKey(),
    userId: text("user_id").notNull(),
    /** Server-issued watermark in epoch milliseconds. */
    cursor: integer("cursor").notNull().default(0),
    lastPullAt: integer("last_pull_at", { mode: "timestamp" }),
    lastPushAt: integer("last_push_at", { mode: "timestamp" }),
    /** Operations the device said were still queued locally at last contact. */
    pendingReported: integer("pending_reported").notNull().default(0),
    appVersion: text("app_version"),
    /** Running totals — the fleet-health view in the ops portal. */
    opsPushed: integer("ops_pushed").notNull().default(0),
    opsRejected: integer("ops_rejected").notNull().default(0),
  },
  (t) => [index("sync_cursor_user_idx").on(t.userId)],
);
