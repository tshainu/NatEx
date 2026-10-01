import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Cross-cutting infrastructure tables (PROJECT.md §4):
 * idempotency, transactional outbox, audit log, rate limiting, SMS log.
 * These are owned by src/api/shared/*, not by a business module.
 */

/**
 * Request dedupe. "A rider's phone will retry a delivery confirmation that
 * actually succeeded" (PROJECT.md §4) — the stored response is replayed
 * verbatim on a duplicate key.
 */
export const idempotencyKey = sqliteTable(
  "shared_idempotency_key",
  {
    key: text("key").primaryKey(),
    route: text("route").notNull(),
    userId: text("user_id"),
    /** Hash of the request body — a reused key with a different body is a conflict. */
    requestHash: text("request_hash").notNull(),
    /** in_progress | completed */
    state: text("state").notNull().default("in_progress"),
    responseJson: text("response_json"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("shared_idem_route_idx").on(t.route)],
);

/**
 * Transactional outbox. "Every background job runs off the outbox table —
 * never a direct write inside a request handler that also needs to enqueue
 * work" (PROJECT.md §4).
 *
 * KNOWN DEVIATION: PROJECT.md specifies Redis 7 + BullMQ 5. The managed stack
 * has no Redis, so jobs/worker.ts drains this table on an interval instead.
 * The outbox contract itself is unchanged.
 */
export const outbox = sqliteTable(
  "shared_outbox",
  {
    id: text("id").primaryKey(),
    topic: text("topic").notNull(),
    payloadJson: text("payload_json").notNull(),
    /** pending | processing | done | failed */
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    availableAt: integer("available_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    processedAt: integer("processed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("shared_outbox_state_idx").on(t.state)],
);

/** APPEND-ONLY, compliance-grade (PROJECT.md §5). No UPDATE/DELETE path exists. */
export const auditLog = sqliteTable(
  "shared_audit_log",
  {
    id: text("id").primaryKey(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    branchId: text("branch_id"),
    deviceId: text("device_id"),
    requestId: text("request_id"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    ts: integer("ts", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("shared_audit_entity_idx").on(t.entity, t.entityId)],
);

/** Token bucket counters (Redis substitute — PROJECT.md §4 rate limiting). */
export const rateLimit = sqliteTable("shared_rate_limit", {
  bucket: text("bucket").primaryKey(),
  tokens: integer("tokens").notNull(),
  refilledAt: integer("refilled_at", { mode: "timestamp" }).notNull(),
});

/**
 * Every SMS send and every delivery receipt. The gateway response is opaque and
 * logged raw (PROJECT.md §9).
 */
export const smsLog = sqliteTable(
  "shared_sms_log",
  {
    id: text("id").primaryKey(),
    toPhone: text("to_phone").notNull(),
    senderId: text("sender_id").notNull(),
    body: text("body").notNull(),
    purpose: text("purpose").notNull(),
    /** queued | sent | failed | delivered | undelivered */
    state: text("state").notNull().default("queued"),
    /** Whatever reference/transaction id the gateway returned, if any. */
    gatewayRef: text("gateway_ref"),
    /** Raw, untouched gateway response. */
    rawResponse: text("raw_response"),
    /** Raw DLR webhook payload, when the gateway sends one. */
    rawDlr: text("raw_dlr"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("shared_sms_ref_idx").on(t.gatewayRef)],
);
