import { z } from "zod";
import { mutate, opsProc, staffProc } from "../middleware/pipeline";
import * as syncService from "../modules/sync/service";

/**
 * sync routes — the device-facing half of PROJECT.md §7, plus the ops
 * exception queue §7 closes with ("every unresolved conflict appears in the
 * Ops exception queue").
 *
 * Two endpoints carry the whole offline contract:
 *   sync.push  — drain a device's outbox, one verdict per operation
 *   sync.pull  — delta since the device's server-issued cursor
 *
 * ROLE CHOICE, deliberate: push and pull are `staffProc`, not `riderProc`.
 * Riders are the main case but ops and transport devices also work in dead
 * zones (a hub scan in a basement loading bay), and §7's engine is not a
 * rider-only feature. What a given role may actually DO is not decided here —
 * every operation is applied by calling the owning module, which enforces §6's
 * transition role table itself. A transport device pushing a doorstep delivery
 * is refused by delivery/service.ts and recorded as `rejected` with the reason,
 * which is exactly the audit trail §7 asks for. Merchants are excluded
 * outright: they have a portal, not an outbox.
 *
 * The exception queue is `opsProc`. The service additionally branch-scopes
 * every read (§5), so a Kandy ops user cannot see Colombo's custody disputes
 * even though the role check passed.
 */

const deviceId = z.string().min(4).max(64);
/** §7: client-minted ULID. The dedupe key — see sync_operation.client_op_id. */
const clientOpId = z.string().min(8).max(64);

const CONFLICT_POLICY = z.enum([
  "duplicate_operation",
  "duplicate_claim",
  "offline_delivery_vs_fail",
  "double_cod",
  "stale_runsheet",
  "illegal_state",
  "unknown_kind",
]);

const OPERATION_STATE = z.enum(["applied", "duplicate", "rejected", "conflict"]);

/**
 * An outbox entry, as the device queued it.
 *
 * `payload` is passed through as an opaque object and validated by the owning
 * module's own route contract shape when it is applied — deliberately NOT
 * re-declared here. Restating five payload schemas in this file would mean a
 * field added to `recordDelivery` silently fails to sync until someone
 * remembers to widen a second schema, and a rider's queued delivery would be
 * rejected by the transport layer before the module that owns the rule ever
 * saw it. §7 is explicit that nothing may be dropped; the owning service is
 * the one place that decides what is valid.
 *
 * `kind` is NOT an enum either, for the same reason in reverse: an old app in
 * the field pushing a kind this server retired must land in the journal as a
 * recorded rejection, not bounce off zod as a 400 the device cannot interpret.
 */
const operation = z.object({
  clientOpId,
  kind: z.string().min(3).max(48),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** The device's own monotonic counter. Order comes from this, never a clock. */
  seq: z.number().int().min(0),
  /** The device's clock at capture, epoch ms. Kept, never trusted for order. */
  clientTs: z.number().int().nullish(),
});

// ------------------------------------------------------------------ the drain

/**
 * Drain a device's outbox.
 *
 * Batched at 200: large enough that a full day's queue (§7's soak test uses
 * 500) drains in three round trips on a weak connection, small enough that a
 * dropped request does not cost the device a long retry.
 *
 * The Idempotency-Key requirement stands (§4), but it is the outer of two
 * defences and the weaker one — a device that retries a push with a FRESH key
 * still cannot double-apply, because every operation carries its own ULID and
 * `sync_operation.client_op_id` is unique. That inner guarantee is the one that
 * matters at the doorstep: it is in the data model, not in a header a proxy
 * can strip.
 */
export const push = staffProc
  .input(
    z.object({
      deviceId,
      operations: z.array(operation).min(1).max(200),
      /** Still queued locally after this batch — fleet health, not control flow. */
      pendingCount: z.number().int().min(0).default(0),
      appVersion: z.string().max(32).nullish(),
      /** The device's clock at push time, epoch ms. Used only to measure skew. */
      clientNow: z.number().int().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "sync.push",
        entity: "sync_device",
        entityId: () => input.deviceId,
        action: "sync.pushed",
        // A reconnecting fleet arrives all at once after an outage; the
        // default 120/min would throttle exactly the recovery it should help.
        bucket: { capacity: 600, refillPerMinute: 600 },
      },
      () => syncService.pushBatch(input, context.principal),
    ),
  );

/**
 * Delta pull. A read, so no Idempotency-Key — but it does write the device's
 * cursor row, which is why it is not a plain query: `pullDelta` advances the
 * watermark only forward (see `touchDevice`).
 */
export const pull = staffProc
  .input(
    z.object({
      deviceId,
      /** Opaque, server-issued. 0 on a fresh install — that pull adds reason codes. */
      cursor: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(200),
      appVersion: z.string().max(32).nullish(),
      pendingCount: z.number().int().min(0).default(0),
    }),
  )
  .handler(({ input, context }) => syncService.pullDelta(input, context.principal));

// -------------------------------------------------------- the exception queue

/** §7's ops exception queue. Open conflicts first — they are the work. */
export const conflicts = opsProc
  .input(
    z.object({
      state: z.array(z.enum(["open", "reviewing", "resolved", "dismissed"])).optional(),
      policy: CONFLICT_POLICY.optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }),
  )
  .handler(({ input, context }) => syncService.listConflicts(context.principal, input));

export const conflictCounts = opsProc
  .input(z.object({}))
  .handler(({ context }) => syncService.conflictCounts(context.principal));

/** One conflict, with the device's claim and the server's state side by side. */
export const conflictGet = opsProc
  .input(z.object({ conflictId: z.string().min(1) }))
  .handler(({ input, context }) => syncService.getConflict(input.conflictId, context.principal));

/**
 * Take a conflict off the pile so two ops users do not work it at once. The
 * second claimant gets a 409, not a silent overwrite.
 */
export const conflictClaim = opsProc
  .input(z.object({ conflictId: z.string().min(1) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "sync.conflictClaim",
        entity: "sync_conflict",
        entityId: () => input.conflictId,
        action: "sync.conflict_claimed",
      },
      () => syncService.claimConflict(input.conflictId, context.principal),
    ),
  );

/**
 * Record how a conflict was decided.
 *
 * `notes` is required and non-empty by contract as well as in the service: a
 * resolution with no account of why is not an audit trail, and §7 calls silent
 * data loss unacceptable. Note that `accepted_client` records a DECISION — it
 * does not re-drive the operation. The correction is made through the normal
 * audited endpoint so it passes the state machine that refused it (§6:
 * corrections are reversal events, never edits).
 */
export const conflictResolve = opsProc
  .input(
    z.object({
      conflictId: z.string().min(1),
      resolution: z.enum(["accepted_client", "kept_server", "manual_correction", "dismissed"]),
      notes: z.string().min(1).max(1000),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "sync.conflictResolve",
        entity: "sync_conflict",
        entityId: () => input.conflictId,
        action: `sync.conflict_${input.resolution}`,
      },
      () => syncService.resolveConflict(input, context.principal),
    ),
  );

// --------------------------------------------------------- fleet and journal

/** Who is behind, who is carrying a backlog, who has a skewed clock. */
export const devices = opsProc
  .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
  .handler(({ input, context }) => syncService.deviceFleet(context.principal, input.limit));

/** The raw operation journal — the "complete audit trail" §7's soak test needs. */
export const operations = opsProc
  .input(
    z.object({
      deviceId: deviceId.optional(),
      state: z.array(OPERATION_STATE).optional(),
      kind: z.string().max(48).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  )
  .handler(({ input }) => syncService.listOperations(input));

/**
 * One device's journal, aggregated: landed-exactly-once and seq-range
 * assertions. `duplicateClientOpIds` must be 0 — the unique index makes it
 * structurally impossible, and a non-zero reading means the constraint is not
 * being enforced, which is a far bigger problem than the duplicate itself.
 */
export const deviceJournal = opsProc
  .input(z.object({ deviceId }))
  .handler(({ input }) => syncService.deviceJournal(input.deviceId));

/** Operations in the device's own `seq` order — proves §7's ordering guarantee. */
export const operationOrder = opsProc
  .input(z.object({ deviceId, limit: z.number().int().min(1).max(1000).default(600) }))
  .handler(({ input }) => syncService.operationOrder(input.deviceId, input.limit));

/** Router namespace — composed into the root router in api/index.ts. */
export const sync = {
  push,
  pull,
  conflicts,
  conflictCounts,
  conflictGet,
  conflictClaim,
  conflictResolve,
  devices,
  operations,
  deviceJournal,
  operationOrder,
};
