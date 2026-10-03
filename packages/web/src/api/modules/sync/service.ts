import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../database";
import { syncConflict, syncDeviceCursor, syncOperation } from "../../database/schema/sync";
import { prefixedId } from "../../shared/ulid";
import { errors } from "../../shared/errors";
import { isGlobalScope, type Principal } from "../../shared/auth";
import {
  eventsChangedSince,
  getParcelByAwb,
  parcelsChangedSince,
  transitionParcel,
  type TransitionInput,
} from "../parcels/service";
import type { ParcelStatus } from "../parcels/state-machine";
import {
  recordDelivery,
  recordFailure,
  runsheetAssignment,
  runsheetClaimFor,
  type RecordDeliveryInput,
  type RecordFailureInput,
} from "../delivery/service";
import { scanItem, scanIntoHub } from "../collection/service";
// §4: the device row carries a userId, not a branchId. Branch comes from the
// owning module's own service call — not a cross-module table join.
import { getUserById } from "../identity/service";
import { listReasonCodes } from "../delivery/reasons";
import { SETTING_KEYS, settingValue } from "../settings/service";

/**
 * MODULE: sync — the server half of PROJECT.md §7, "the hardest problem here".
 *
 * The ONLY file that reads sync_* tables (§4). Everything it applies, it
 * applies by calling the owning module's exported service — it never writes a
 * parcel, an attempt or a ledger row itself. That is what keeps the offline
 * path and the online path provably identical: a pushed operation runs the
 * same `recordDelivery()` an online tap does, with the same state machine, the
 * same POD rules and the same COD posting.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * The five §7 guarantees and where each one lives in this file
 *
 * 1. "Local write first / outbox queue" — the client's half. The server's
 *    obligation is to accept a BATCH pushed later, which `pushBatch()` does.
 *
 * 2. "Drain pushes queued operations IN ORDER" — `pushBatch()` sorts by the
 *    device's own `seq`, never by timestamp. A rider's phone clock can be off
 *    by half an hour; its counter cannot. Order matters because a fail-then-
 *    deliver and a deliver-then-fail on one parcel are different outcomes.
 *
 * 3. "ULID client IDs, idempotent by construction" — `clientOpId` is UNIQUE in
 *    sync_operation. A replay returns the STORED verdict (state `duplicate`)
 *    without touching the owning module again. This is the guarantee that
 *    stops the double-counted COD §4 warns about, and it holds even when the
 *    HTTP idempotency middleware is bypassed, because it is in the data model
 *    rather than in a header.
 *
 * 4. "Server authority" — every operation returns the server's own row, which
 *    the client overwrites its local copy with. The client never argues.
 *
 * 5. "Delta pull, never the whole dataset" — `pullDelta()`, on a server-issued
 *    watermark. The client stores the cursor opaquely; it never computes one,
 *    so clock skew cannot make it skip a record.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY NOTHING IS EVER DROPPED
 *
 * §7 closes with "Silent data loss is unacceptable in a logistics system."
 * Accordingly there is no code path here that discards an operation. Every
 * push lands in sync_operation with its full payload — applied, duplicate,
 * rejected or conflict — and every conflict additionally lands in
 * sync_conflict with both sides recorded: what the device claimed, and what
 * the server held at the time. A rejected delivery is a row an ops user can
 * read a week later, not a log line.
 */

// ───────────────────────────────────────────────────────────── the vocabulary

/**
 * The operations a field device may push. Deliberately a closed list: an
 * unknown kind is a rejected operation with a conflict row, not a 500 and not
 * a silent no-op, because an old app version in the field is a normal event.
 */
export const OPERATION_KINDS = [
  "delivery.deliver",
  "delivery.fail",
  "parcel.transition",
  "collection.scan",
  "collection.hubScan",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const CONFLICT_POLICIES = [
  "duplicate_operation",
  "duplicate_claim",
  "offline_delivery_vs_fail",
  "double_cod",
  "stale_runsheet",
  "illegal_state",
  "unknown_kind",
] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export type OperationState = "applied" | "duplicate" | "rejected" | "conflict";

export interface PushOperation {
  clientOpId: string;
  kind: string;
  /** The operation's own arguments, exactly as the owning service expects. */
  payload: Record<string, unknown>;
  seq: number;
  clientTs?: number | null;
}

export interface OperationVerdict {
  clientOpId: string;
  state: OperationState;
  kind: string;
  result: unknown;
  error: string | null;
  conflictId: string | null;
  policy: ConflictPolicy | null;
}

export type SyncOperationRow = typeof syncOperation.$inferSelect;
export type SyncConflictRow = typeof syncConflict.$inferSelect;

// ─────────────────────────────────────────────────────────── error reading

interface ProblemShape {
  status?: number;
  type?: string;
  detail?: string;
  title?: string;
  /**
   * The owning module's own domain status, carried as an RFC 7807 extension
   * (§11 names it `currentStatus` precisely so it cannot collide with the
   * document's HTTP `status`). Classifying a conflict off this structured
   * field rather than off the prose in `detail` is the difference between a
   * mapping that survives a copy-edit and one that silently stops firing.
   */
  currentStatus?: string;
}

/**
 * Reads the problem+json an owning service threw (§11) without depending on
 * the transport layer. We need the STATUS to decide whether a failure is a
 * conflict worth an ops review or a plain refusal.
 */
function problemOf(err: unknown): ProblemShape {
  const e = err as { data?: ProblemShape; cause?: { data?: ProblemShape }; message?: string };
  const data = e?.data ?? e?.cause?.data ?? {};
  return { ...data, detail: data.detail ?? e?.message };
}

function messageOf(err: unknown): string {
  const p = problemOf(err);
  return p.detail ?? p.title ?? (err instanceof Error ? err.message : String(err));
}

/**
 * Which §7 conflict policy a thrown error represents.
 *
 * The mapping is deliberately conservative: anything a module refused for a
 * STATE reason (409/422) is a conflict an ops user must see, because in a
 * logistics system those are the cases where the device and the server
 * genuinely disagree about what happened at the doorstep. A 404 or a 403 is
 * not a conflict — it is a bad or unauthorised operation, recorded as
 * `rejected` without cluttering the exception queue.
 */
/**
 * The parcel states that mean the doorstep attempt already FAILED and the
 * parcel was turned back or held (§6). A delivery arriving from an offline
 * device for a parcel in one of these is §7's "delivery confirmed offline,
 * parcel already failed" — the one row on the conflict table that explicitly
 * forbids resolving itself.
 */
const FAILED_STATES: readonly string[] = [
  // A failed attempt recorded by someone else (ops at the hub, or the same
  // rider from another phone) while this device was offline — the plainest
  // case of all.
  "DeliveryAttempted",
  "OnHold",
  "RTOInitiated",
  "RTOInTransit",
  "RTODelivered",
  "Cancelled",
  "Lost",
  "Damaged",
];

function policyFor(kind: string, err: unknown): ConflictPolicy | null {
  const { status, type, detail, currentStatus } = problemOf(err);
  if (status !== 409 && status !== 422) return null;

  const slug = (type ?? "").split("/").pop() ?? "";

  // §7: "COD collected twice for one parcel → second entry rejected; both
  // shown in reconciliation." The cod module raises this under its own slug,
  // which is a stable contract — matched on the slug, not on the prose.
  if (slug === "cod-already-collected" || slug === "cod-entry-already-posted") {
    return "double_cod";
  }

  // §7: "Same parcel transitioned twice → first wins." transitionParcel()
  // refuses a no-op move with `Parcel X is already <state>.`
  if ((detail ?? "").toLowerCase().includes("is already ")) return "duplicate_operation";

  if (kind === "delivery.deliver" && currentStatus) {
    // §7: "Delivery confirmed offline, parcel already failed → flag for ops
    // manual review — never silently overwrite."
    if (FAILED_STATES.includes(currentStatus)) return "offline_delivery_vs_fail";
    // §7: "Two riders claim one parcel → server rejects the later claim."
    // Someone else's POD already landed; this device's claim arrives second.
    if (currentStatus === "Delivered") return "duplicate_claim";
  }

  if (kind === "delivery.fail" && currentStatus === "Delivered") {
    // The mirror image: a failure pushed for a parcel the server has already
    // signed for. Ops must decide which happened; the server will not guess.
    return "offline_delivery_vs_fail";
  }

  // 422 illegal-transition, and anything else a module refused on state.
  return "illegal_state";
}

// ───────────────────────────────────────────────────────────── the dispatcher

/**
 * Applies ONE operation by calling the module that owns it.
 *
 * Every payload carries the client's own id through to the owning service as
 * `clientId`, which is what makes the modules' existing row-level dedupe
 * (delivery_attempt.client_id) the second line of defence behind
 * sync_operation's unique index. Belt and braces, deliberately: this is the
 * path where a duplicate costs the company money.
 */
async function apply(op: PushOperation, actor: Principal): Promise<unknown> {
  // The payload arrives as unknown JSON off the wire and is cast to the owning
  // service's own input type per case. The cast is safe because every one of
  // these procedures re-validates against its zod contract at the route layer
  // and then re-checks its own invariants inside the service — the cast buys
  // a readable dispatcher, not a bypass.
  const p = op.payload;
  // The device's own clock reading for when the rider tapped "delivered". It
  // travels on the operation, not in the payload (JSON has no Date), and is
  // recorded as evidence only — ordering is by `seq`, never by this.
  const clientTs = op.clientTs ? new Date(op.clientTs) : null;
  switch (op.kind as OperationKind) {
    case "delivery.deliver":
      return recordDelivery(
        { ...(p as unknown as RecordDeliveryInput), clientId: op.clientOpId, clientTs },
        actor,
      );
    case "delivery.fail":
      return recordFailure(
        { ...(p as unknown as RecordFailureInput), clientId: op.clientOpId, clientTs },
        actor,
      );
    case "parcel.transition":
      return transitionParcel(
        { ...(p as unknown as TransitionInput), clientId: op.clientOpId },
        actor,
      );
    case "collection.scan":
      return scanItem(p as unknown as { manifestId: string; awb: string }, actor);
    case "collection.hubScan":
      return scanIntoHub(
        p as unknown as { awbs: string[]; lat?: number | null; lng?: number | null },
        actor,
      );
    default:
      // An app version we do not know about. Refused, recorded, visible.
      errors.badRequest(`Unknown sync operation kind "${op.kind}".`, {
        kind: op.kind,
        supported: OPERATION_KINDS,
      });
      return null;
  }
}

/**
 * Pre-flight for the two policies that must be caught BEFORE the owning
 * service runs, because the service itself has no way to know them.
 *
 * `stale_runsheet` is the case §7 names: the run was reassigned while the
 * device was offline. The owning service would happily record a delivery by a
 * rider who is no longer carrying the parcel — correct in isolation, wrong for
 * custody. So the claim is checked here, against the delivery module's own
 * exported reader.
 */
async function preflight(
  op: PushOperation,
  actor: Principal,
): Promise<{ policy: ConflictPolicy; detail: string; serverState: unknown } | null> {
  // An operation kind this build does not know: an app version still in the
  // field pushing something the server has retired or not yet shipped. It is
  // raised here as a CONFLICT rather than left to `apply()`'s 400, because
  // "device 7 is on an old build and its queue cannot drain" is ops work — a
  // rider whose outbox silently fills up is exactly the silent data loss §7
  // forbids. The payload is kept verbatim so the operation can be replayed
  // once the fleet is upgraded.
  if (!(OPERATION_KINDS as readonly string[]).includes(op.kind)) {
    return {
      policy: "unknown_kind",
      detail:
        `This server does not recognise the operation kind "${op.kind}". The device is ` +
        `probably on an older build. The payload is held verbatim so it can be replayed ` +
        `after the app is updated; nothing has been discarded (§7).`,
      serverState: { supportedKinds: OPERATION_KINDS },
    };
  }

  if (op.kind !== "delivery.deliver" && op.kind !== "delivery.fail") return null;
  const awb = (op.payload as { awb?: string }).awb;
  if (!awb) return null;

  const parcel = await getParcelByAwb(awb);
  if (!parcel) return null;

  const claim = await runsheetClaimFor(parcel.id, actor.userId);
  // No runsheet at all means this is an ad-hoc delivery, which ops does
  // legitimately; only an ACTIVE claim by someone else is a conflict.
  if (!claim.onThisRidersRun && claim.assignedRiderId && claim.assignedRiderId !== actor.userId) {
    return {
      policy: "stale_runsheet",
      detail:
        `${awb} is on ${claim.assignedRiderName ?? "another rider"}'s runsheet now, not ` +
        `${actor.name}'s. The device was holding a runsheet that has since been reassigned; ` +
        `its copy must be discarded and re-pulled (§7).`,
      serverState: claim,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────── the push

async function recordConflict(params: {
  operationId: string;
  clientOpId: string;
  policy: ConflictPolicy;
  kind: string;
  actor: Principal;
  detail: string;
  clientClaim: unknown;
  serverState: unknown;
  awb?: string | null;
}): Promise<string> {
  const awb = params.awb ?? (params.clientClaim as { awb?: string })?.awb ?? null;
  let parcelId: string | null = null;
  if (awb) {
    const parcel = await getParcelByAwb(awb);
    parcelId = parcel?.id ?? null;
  }

  const id = prefixedId("syncconf");
  await db.insert(syncConflict).values({
    id,
    operationId: params.operationId,
    clientOpId: params.clientOpId,
    policy: params.policy,
    kind: params.kind,
    deviceId: params.actor.deviceId ?? null,
    userId: params.actor.userId,
    userName: params.actor.name,
    branchId: params.actor.branchId,
    parcelId,
    awb,
    detail: params.detail,
    clientClaimJson: JSON.stringify(params.clientClaim ?? null),
    serverStateJson: JSON.stringify(params.serverState ?? null),
    state: "open",
  });
  return id;
}

export interface PushInput {
  deviceId: string;
  operations: PushOperation[];
  /** How many operations the device still has queued locally, for fleet health. */
  pendingCount?: number;
  appVersion?: string | null;
  /** The device's clock at push time, used only to measure skew. */
  clientNow?: number | null;
}

export interface PushResult {
  accepted: number;
  applied: number;
  duplicates: number;
  rejected: number;
  conflicts: number;
  verdicts: OperationVerdict[];
  /** Fresh cursor, so a drain can push and pull in one round trip. */
  cursor: number;
  clockSkewSeconds: number;
}

/**
 * Drains a device's outbox (§7).
 *
 * Operations are applied ONE AT A TIME, in the device's own order, and a
 * failure does not abort the batch: operation 5 failing must not strand
 * operations 6-100, or a single bad record would wedge a rider's phone for the
 * rest of the day. Each gets its own verdict; the client keeps the ones that
 * applied and surfaces the ones that did not.
 */
export async function pushBatch(input: PushInput, actor: Principal): Promise<PushResult> {
  const serverNow = Date.now();
  const clockSkewSeconds = input.clientNow
    ? Math.round((input.clientNow - serverNow) / 1000)
    : 0;

  // §7: in the device's order, by its own counter. Never by clock.
  const ordered = [...input.operations].sort((a, b) => a.seq - b.seq);
  const verdicts: OperationVerdict[] = [];

  for (const op of ordered) {
    // ── 1. Dedupe in the data model, not in a header.
    const [seen] = await db
      .select()
      .from(syncOperation)
      .where(eq(syncOperation.clientOpId, op.clientOpId))
      .limit(1);
    if (seen) {
      verdicts.push({
        clientOpId: op.clientOpId,
        state: "duplicate",
        kind: seen.kind,
        result: seen.resultJson ? JSON.parse(seen.resultJson) : null,
        error: seen.error,
        conflictId: null,
        policy: null,
      });
      continue;
    }

    const operationId = prefixedId("syncop");
    const base = {
      id: operationId,
      clientOpId: op.clientOpId,
      deviceId: input.deviceId,
      userId: actor.userId,
      userRole: actor.role,
      kind: op.kind,
      payloadJson: JSON.stringify(op.payload ?? {}),
      seq: op.seq,
      clientTs: op.clientTs ? new Date(op.clientTs) : null,
      clockSkewSeconds,
    };

    // ── 2. The conflicts the owning module cannot see.
    const pre = await preflight(op, actor);
    if (pre) {
      await db.insert(syncOperation).values({ ...base, state: "conflict", error: pre.detail });
      const conflictId = await recordConflict({
        operationId,
        clientOpId: op.clientOpId,
        policy: pre.policy,
        kind: op.kind,
        actor,
        detail: pre.detail,
        clientClaim: op.payload,
        serverState: pre.serverState,
      });
      verdicts.push({
        clientOpId: op.clientOpId,
        state: "conflict",
        kind: op.kind,
        result: null,
        error: pre.detail,
        conflictId,
        policy: pre.policy,
      });
      continue;
    }

    // ── 3. Apply through the owning module, same as an online tap.
    try {
      const result = await apply(op, actor);
      // A module's own row-level dedupe reporting `deduped` is still a first-
      // wins duplicate, and §7 wants it visible rather than reported as new.
      const deduped = Boolean((result as { deduped?: boolean })?.deduped);
      await db.insert(syncOperation).values({
        ...base,
        state: deduped ? "duplicate" : "applied",
        resultJson: JSON.stringify(result ?? null),
        appliedAt: new Date(),
      });
      verdicts.push({
        clientOpId: op.clientOpId,
        state: deduped ? "duplicate" : "applied",
        kind: op.kind,
        result,
        error: null,
        conflictId: null,
        policy: null,
      });
    } catch (err) {
      const detail = messageOf(err);
      const policy = policyFor(op.kind, err);
      const { status } = problemOf(err);
      const state: OperationState = policy ? "conflict" : "rejected";

      await db.insert(syncOperation).values({ ...base, state, error: detail });

      let conflictId: string | null = null;
      if (policy) {
        const awb = (op.payload as { awb?: string }).awb ?? null;
        const parcel = awb ? await getParcelByAwb(awb) : null;
        conflictId = await recordConflict({
          operationId,
          clientOpId: op.clientOpId,
          policy,
          kind: op.kind,
          actor,
          detail,
          clientClaim: op.payload,
          serverState: parcel
            ? { awb: parcel.awb, status: parcel.status, attempts: parcel.deliveryAttempts }
            : { status: status ?? null },
          awb,
        });
      }
      verdicts.push({
        clientOpId: op.clientOpId,
        state,
        kind: op.kind,
        result: null,
        error: detail,
        conflictId,
        policy,
      });
    }
  }

  const applied = verdicts.filter((v) => v.state === "applied").length;
  const duplicates = verdicts.filter((v) => v.state === "duplicate").length;
  const rejected = verdicts.filter((v) => v.state === "rejected").length;
  const conflicts = verdicts.filter((v) => v.state === "conflict").length;

  await touchDevice({
    deviceId: input.deviceId,
    userId: actor.userId,
    pushed: ordered.length,
    rejected: rejected + conflicts,
    pendingReported: input.pendingCount ?? 0,
    appVersion: input.appVersion ?? null,
    lastPushAt: new Date(),
  });

  const [cursorRow] = await db
    .select()
    .from(syncDeviceCursor)
    .where(eq(syncDeviceCursor.deviceId, input.deviceId))
    .limit(1);

  return {
    accepted: ordered.length,
    applied,
    duplicates,
    rejected,
    conflicts,
    verdicts,
    cursor: cursorRow?.cursor ?? 0,
    clockSkewSeconds,
  };
}

// ────────────────────────────────────────────────────────────────── the pull

export interface PullInput {
  deviceId: string;
  /** Opaque, server-issued. 0 on a fresh install. */
  cursor?: number;
  limit?: number;
  appVersion?: string | null;
  pendingCount?: number;
}

/**
 * §7's delta pull. Returns only what changed after the client's cursor, plus
 * the rider's authoritative assignment and the reason-code table the offline
 * failure screen needs in hand BEFORE it loses signal.
 *
 * The returned cursor is the watermark of the last row actually included —
 * never `Date.now()`. Using the wall clock here is the classic delta-sync bug:
 * a row written during the request, with a timestamp below the clock reading,
 * would be skipped forever.
 */
export async function pullDelta(input: PullInput, actor: Principal) {
  const since = Math.max(input.cursor ?? 0, 0);
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);

  const parcels = await parcelsChangedSince(actor, since, limit);
  const events = await eventsChangedSince(
    parcels.rows.map((p) => p.id),
    since,
  );
  // Only riders carry a runsheet; ops and transport devices pull parcels only.
  const assignment = actor.role === "rider" ? await runsheetAssignment(actor) : null;
  const reasons = since === 0 ? await listReasonCodes() : [];

  await touchDevice({
    deviceId: input.deviceId,
    userId: actor.userId,
    cursor: parcels.watermarkMs,
    pendingReported: input.pendingCount ?? 0,
    appVersion: input.appVersion ?? null,
    lastPullAt: new Date(),
  });

  return {
    cursor: parcels.watermarkMs,
    hasMore: parcels.hasMore,
    parcels: parcels.rows,
    events,
    assignment,
    // Sent once on a fresh install (cursor 0); a device that already has them
    // does not re-download a static table on every reconnect.
    reasonCodes: reasons,
    serverTime: Date.now(),
  };
}

// ──────────────────────────────────────────────────────────── device registry

async function touchDevice(params: {
  deviceId: string;
  userId: string;
  cursor?: number;
  pushed?: number;
  rejected?: number;
  pendingReported?: number;
  appVersion?: string | null;
  lastPullAt?: Date;
  lastPushAt?: Date;
}): Promise<void> {
  const [existing] = await db
    .select()
    .from(syncDeviceCursor)
    .where(eq(syncDeviceCursor.deviceId, params.deviceId))
    .limit(1);

  if (!existing) {
    await db.insert(syncDeviceCursor).values({
      deviceId: params.deviceId,
      userId: params.userId,
      cursor: params.cursor ?? 0,
      lastPullAt: params.lastPullAt ?? null,
      lastPushAt: params.lastPushAt ?? null,
      pendingReported: params.pendingReported ?? 0,
      appVersion: params.appVersion ?? null,
      opsPushed: params.pushed ?? 0,
      opsRejected: params.rejected ?? 0,
    });
    return;
  }

  await db
    .update(syncDeviceCursor)
    .set({
      userId: params.userId,
      // A cursor only ever moves forward. A device replaying an old cursor
      // (reinstall, restored backup) must not drag the watermark backwards for
      // everyone else reading this row.
      cursor: Math.max(existing.cursor, params.cursor ?? existing.cursor),
      lastPullAt: params.lastPullAt ?? existing.lastPullAt,
      lastPushAt: params.lastPushAt ?? existing.lastPushAt,
      pendingReported: params.pendingReported ?? existing.pendingReported,
      appVersion: params.appVersion ?? existing.appVersion,
      opsPushed: existing.opsPushed + (params.pushed ?? 0),
      opsRejected: existing.opsRejected + (params.rejected ?? 0),
    })
    .where(eq(syncDeviceCursor.deviceId, params.deviceId));
}

/**
 * How far a device's clock may be out before ops should be told. §7 states the
 * field condition plainly — "clock skewed ±30 minutes" — so 30 minutes is the
 * threshold, not a guess.
 */
// §10 M5: editable as settings.clock_skew_alert_minutes (default 30).

/**
 * Fleet health for the ops portal: who is behind, who is carrying a backlog,
 * and whose clock is wrong.
 *
 * The clock reading is NOT stored on the device row. It is read back from the
 * device's most recent operation, because that is where it was actually
 * measured, and a second copy on the cursor row would be one more thing that
 * can disagree with the journal. §7 treats a skewed clock as normal, so the
 * engine never orders by it — but ops still needs to SEE it: every `clientTs`
 * in a 40-minute-out device's audit trail is wrong by 40 minutes, and that is
 * the sort of thing a custody dispute turns on months later.
 */
export async function deviceFleet(scope: Principal, limit = 100) {
  if (!isGlobalScope(scope.role) && scope.role !== "ops") {
    errors.forbidden("Fleet sync health is an ops view.");
  }
  const CLOCK_SKEW_ALERT_SECONDS = (await settingValue(SETTING_KEYS.CLOCK_SKEW_ALERT_MINUTES)) * 60;
  const rows = await db
    .select()
    .from(syncDeviceCursor)
    .orderBy(desc(syncDeviceCursor.lastPushAt))
    .limit(Math.min(Math.max(limit, 1), 200));

  // §5: a Kandy ops user has no business reading Colombo's devices. The device
  // row carries a user, not a branch, so the branch comes from the owning
  // module's service rather than from a join into its table (§4).
  const owners = await Promise.all(rows.map((r) => getUserById(r.userId)));

  const visible = rows.filter((_, i) => {
    if (isGlobalScope(scope.role)) return true;
    return owners[i]?.branchId === scope.branchId;
  });

  return Promise.all(
    visible.map(async (row) => {
      const owner = owners[rows.indexOf(row)];
      const [latest] = await db
        .select({ skew: syncOperation.clockSkewSeconds, at: syncOperation.receivedAt })
        .from(syncOperation)
        .where(eq(syncOperation.deviceId, row.deviceId))
        .orderBy(desc(syncOperation.receivedAt))
        .limit(1);
      // The latest reading alone hides the problem: a phone that was 40
      // minutes out this morning and pushed a clean batch this afternoon still
      // wrote 40-minute-wrong timestamps into the audit trail. Ops needs the
      // WORST reading on the journal to know whether to trust this device's
      // clientTs at all, so both are reported.
      const [worst] = await db
        .select({ skew: syncOperation.clockSkewSeconds })
        .from(syncOperation)
        .where(eq(syncOperation.deviceId, row.deviceId))
        .orderBy(desc(sql`abs(${syncOperation.clockSkewSeconds})`))
        .limit(1);
      const skew = latest?.skew ?? 0;
      const worstSkew = worst?.skew ?? 0;
      return {
        ...row,
        userName: owner?.name ?? null,
        userRole: owner?.role ?? null,
        branchId: owner?.branchId ?? null,
        /** Seconds the device's clock was AHEAD of the server's on its last push. Negative = behind. */
        clockSkewSeconds: skew,
        /** The largest absolute skew anywhere in this device's journal. */
        worstClockSkewSeconds: worstSkew,
        /** Ops-visible flag, so the portal does not re-derive the §7 threshold. */
        clockSuspect: Math.abs(worstSkew) >= CLOCK_SKEW_ALERT_SECONDS,
        lastOperationAt: latest?.at ?? null,
      };
    }),
  );
}

// ─────────────────────────────────────────────────────── the exception queue

export interface ListConflictsInput {
  state?: ("open" | "reviewing" | "resolved" | "dismissed")[];
  policy?: ConflictPolicy;
  limit?: number;
}

/**
 * §7: "Every unresolved conflict appears in the Ops exception queue."
 *
 * Branch-scoped like every other operational read (§5), because a Kandy ops
 * user has no business reviewing Colombo's custody disputes.
 */
export async function listConflicts(scope: Principal, input: ListConflictsInput = {}) {
  const filters = [];
  if (input.state?.length) filters.push(inArray(syncConflict.state, input.state));
  if (input.policy) filters.push(eq(syncConflict.policy, input.policy));
  if (!isGlobalScope(scope.role)) filters.push(eq(syncConflict.branchId, scope.branchId));

  const rows = await db
    .select()
    .from(syncConflict)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(syncConflict.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 200));

  return rows.map((row) => ({
    ...row,
    clientClaim: row.clientClaimJson ? JSON.parse(row.clientClaimJson) : null,
    serverState: row.serverStateJson ? JSON.parse(row.serverStateJson) : null,
  }));
}

export async function conflictCounts(scope: Principal) {
  const filters = isGlobalScope(scope.role)
    ? undefined
    : eq(syncConflict.branchId, scope.branchId);
  const rows = await db
    .select({ state: syncConflict.state, policy: syncConflict.policy, value: count() })
    .from(syncConflict)
    .where(filters)
    .groupBy(syncConflict.state, syncConflict.policy);

  const byPolicy: Record<string, number> = {};
  let open = 0;
  let resolved = 0;
  for (const row of rows) {
    if (row.state === "open" || row.state === "reviewing") {
      open += row.value;
      byPolicy[row.policy] = (byPolicy[row.policy] ?? 0) + row.value;
    } else resolved += row.value;
  }
  return { open, resolved, byPolicy };
}

export async function getConflict(id: string, scope: Principal) {
  const [row] = await db.select().from(syncConflict).where(eq(syncConflict.id, id)).limit(1);
  if (!row) errors.notFound("Sync conflict");
  if (!isGlobalScope(scope.role) && row!.branchId !== scope.branchId) {
    errors.forbidden("That conflict belongs to another branch.");
  }
  const [operation] = await db
    .select()
    .from(syncOperation)
    .where(eq(syncOperation.id, row!.operationId))
    .limit(1);

  return {
    conflict: {
      ...row!,
      clientClaim: row!.clientClaimJson ? JSON.parse(row!.clientClaimJson) : null,
      serverState: row!.serverStateJson ? JSON.parse(row!.serverStateJson) : null,
    },
    operation: operation
      ? { ...operation, payload: JSON.parse(operation.payloadJson) }
      : null,
  };
}

/**
 * Ops takes a conflict off the pile.
 *
 * `accepted_client` deliberately does NOT re-apply the operation. The client's
 * claim may well be right, but re-driving a delivery from here would bypass
 * the state machine that refused it in the first place (§6: "corrections are
 * reversal events, never edits"). The resolution records the decision and the
 * ops user then performs the correction through the normal, audited endpoint.
 * A one-click "just force it" is exactly the door a logistics system should
 * not have.
 */
export async function resolveConflict(
  input: {
    conflictId: string;
    resolution: "accepted_client" | "kept_server" | "manual_correction" | "dismissed";
    notes: string;
  },
  actor: Principal,
) {
  const [row] = await db
    .select()
    .from(syncConflict)
    .where(eq(syncConflict.id, input.conflictId))
    .limit(1);
  if (!row) errors.notFound("Sync conflict");
  if (row!.state === "resolved" || row!.state === "dismissed") {
    errors.conflict(`That conflict was already ${row!.state} by ${row!.resolvedByName}.`, {
      state: row!.state,
      resolvedByName: row!.resolvedByName,
    });
  }
  if (!input.notes.trim()) {
    // A resolution with no account of WHY is not an audit trail.
    errors.badRequest("A resolution note is required — say what was decided and why.");
  }

  const [updated] = await db
    .update(syncConflict)
    .set({
      state: input.resolution === "dismissed" ? "dismissed" : "resolved",
      resolution: input.resolution,
      resolutionNotes: input.notes.trim(),
      resolvedByName: actor.name,
      resolvedAt: new Date(),
    })
    .where(eq(syncConflict.id, input.conflictId))
    .returning();

  return updated!;
}

export async function claimConflict(conflictId: string, actor: Principal) {
  const [updated] = await db
    .update(syncConflict)
    .set({ state: "reviewing", resolvedByName: actor.name })
    .where(and(eq(syncConflict.id, conflictId), eq(syncConflict.state, "open")))
    .returning();
  if (!updated) {
    errors.conflict("That conflict is no longer open — someone else has it.", { conflictId });
  }
  return updated!;
}

// ────────────────────────────────────────────────────────── the audit journal

export async function listOperations(
  input: { deviceId?: string; state?: OperationState[]; kind?: string; limit?: number } = {},
) {
  const filters = [];
  if (input.deviceId) filters.push(eq(syncOperation.deviceId, input.deviceId));
  if (input.state?.length) filters.push(inArray(syncOperation.state, input.state));
  if (input.kind) filters.push(eq(syncOperation.kind, input.kind));

  return db
    .select()
    .from(syncOperation)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(syncOperation.receivedAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
}

/**
 * The assertion §7's soak test is built on: every operation a device pushed
 * landed exactly once, and the journal agrees with the device's own count.
 *
 * Returned rather than thrown so the soak test and the ops portal can both
 * read it — a breach is an ops-visible fact, not an exception.
 */
export async function deviceJournal(deviceId: string) {
  const rows = await db
    .select({ state: syncOperation.state, value: count() })
    .from(syncOperation)
    .where(eq(syncOperation.deviceId, deviceId))
    .groupBy(syncOperation.state);

  const byState: Record<string, number> = {};
  for (const r of rows) byState[r.state] = r.value;

  const [dupes] = await db
    .select({ value: count() })
    .from(
      db
        .select({ clientOpId: syncOperation.clientOpId, n: count().as("n") })
        .from(syncOperation)
        .where(eq(syncOperation.deviceId, deviceId))
        .groupBy(syncOperation.clientOpId)
        .having(sql`count(*) > 1`)
        .as("d"),
    );

  const [seqGaps] = await db
    .select({ min: sql<number>`min(seq)`, max: sql<number>`max(seq)`, n: count() })
    .from(syncOperation)
    .where(eq(syncOperation.deviceId, deviceId));

  return {
    deviceId,
    byState,
    total: Object.values(byState).reduce((a, b) => a + b, 0),
    /** Must be 0 — the unique index makes it structurally impossible. */
    duplicateClientOpIds: dupes?.value ?? 0,
    seqRange: { min: seqGaps?.min ?? 0, max: seqGaps?.max ?? 0, count: seqGaps?.n ?? 0 },
  };
}

/** Operations in the device's own order — proves §7's "in order" guarantee. */
export async function operationOrder(deviceId: string, limit = 600) {
  return db
    .select({
      clientOpId: syncOperation.clientOpId,
      seq: syncOperation.seq,
      kind: syncOperation.kind,
      state: syncOperation.state,
      receivedAt: syncOperation.receivedAt,
    })
    .from(syncOperation)
    .where(eq(syncOperation.deviceId, deviceId))
    .orderBy(asc(syncOperation.seq))
    .limit(Math.min(Math.max(limit, 1), 1000));
}

export type { ParcelStatus };
