import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { db } from "../../database";
import {
  bag,
  bagItem,
  custodyException,
  hubScan,
  trip,
} from "../../database/schema/transport";
import { prefixedId } from "../../shared/ulid";
import { isTransientDbError } from "../../shared/request-scope";
import { errors } from "../../shared/errors";
import { normaliseLkPhone } from "../../shared/sms";
import { enqueue } from "../../shared/outbox";
import { isGlobalScope, type Principal } from "../../shared/auth";
import * as parcels from "../parcels/service";
import * as identity from "../identity/service";
import type { ParcelStatus } from "../parcels/state-machine";

/**
 * MODULE: transport (PROJECT.md §4). The ONLY file that reads transport_* tables.
 *
 * It reaches parcels exclusively through modules/parcels/service.ts and branches
 * through modules/identity/service.ts — never their tables. That boundary is the
 * seam §4 calls "the seam that makes later service extraction possible".
 *
 * NON-NEGOTIABLE (§1): a parcel must never be lost. Three rules follow from it
 * and are enforced below rather than assumed:
 *   1. Every scan is logged — accepted, duplicate AND rejected (transport_hub_scan).
 *   2. Every count that fails to match raises a transport_exception; nothing is
 *      silently corrected and nothing is silently dropped.
 *   3. A bag cannot leave without a seal and a trip (§6), and cannot be received
 *      without a two-party record of who released it and who took it.
 */

export type BagRow = typeof bag.$inferSelect;
export type BagItemRow = typeof bagItem.$inferSelect;
export type TripRow = typeof trip.$inferSelect;
export type HubScanRow = typeof hubScan.$inferSelect;
export type ExceptionRow = typeof custodyException.$inferSelect;

/** Statuses a parcel may hold and still be legally scanned into a bag (§6). */
const BAGGABLE_FROM: readonly ParcelStatus[] = ["AtOriginHub", "AtDestHub"];

// ------------------------------------------------------------------- scoping

function bagScope(scope: Principal) {
  if (isGlobalScope(scope.role)) return undefined;
  return or(eq(bag.branchId, scope.branchId), eq(bag.destHubId, scope.branchId));
}

function tripScope(scope: Principal) {
  if (isGlobalScope(scope.role)) return undefined;
  return or(eq(trip.branchId, scope.branchId), eq(trip.destHubId, scope.branchId));
}

/**
 * A bag is visible to the branch that holds it AND to its destination hub —
 * the receiving hub must be able to see an inbound bag before it arrives,
 * otherwise it cannot detect one that never does.
 */
function assertBagVisible(row: BagRow, scope: Principal): void {
  if (isGlobalScope(scope.role)) return;
  if (row.branchId === scope.branchId || row.destHubId === scope.branchId) return;
  errors.forbidden("This bag belongs to another branch.", { bagBranchId: row.branchId });
}

// ------------------------------------------------------------- scan logging

interface ScanLogInput {
  kind: string;
  outcome: "accepted" | "duplicate" | "rejected";
  branchId: string;
  awb?: string | null;
  parcelId?: string | null;
  bagId?: string | null;
  tripId?: string | null;
  hubId?: string | null;
  reason?: string | null;
  actor: Principal;
  lat?: number | null;
  lng?: number | null;
  clientId?: string | null;
}

/**
 * The only writer of transport_hub_scan. Append-only: rejected scans are
 * recorded here precisely because the parcel timeline cannot hold them — a
 * label scanned at the wrong hub leaves no parcel event, but it is still
 * evidence of where a parcel physically was.
 */
async function logScan(input: ScanLogInput): Promise<HubScanRow> {
  const [row] = await db
    .insert(hubScan)
    .values({
      id: prefixedId("scn"),
      kind: input.kind,
      awb: input.awb ?? null,
      parcelId: input.parcelId ?? null,
      bagId: input.bagId ?? null,
      tripId: input.tripId ?? null,
      branchId: input.branchId,
      hubId: input.hubId ?? null,
      outcome: input.outcome,
      reason: input.reason ?? null,
      actorId: input.actor.userId,
      actorName: input.actor.name,
      actorRole: input.actor.role,
      deviceId: input.actor.deviceId ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      clientId: input.clientId ?? null,
      ts: new Date(),
    })
    .returning();
  return row!;
}

// ------------------------------------------------------------ exception queue

export interface RaiseExceptionInput {
  kind:
    | "missing_at_destination"
    | "unexpected_at_destination"
    | "seal_mismatch"
    | "illegal_scan"
    | "duplicate_claim"
    | "count_variance"
    | "stale_custody";
  severity?: "low" | "medium" | "high";
  branchId: string;
  awb?: string | null;
  parcelId?: string | null;
  bagId?: string | null;
  tripId?: string | null;
  detail: string;
  evidence?: unknown;
  actor?: Principal | null;
}

/**
 * §7: "Every unresolved conflict appears in the Ops exception queue. Silent
 * data loss is unacceptable in a logistics system." Every variance detector in
 * this module ends here.
 */
export async function raiseException(input: RaiseExceptionInput): Promise<ExceptionRow> {
  const [row] = await db
    .insert(custodyException)
    .values({
      id: prefixedId("exc"),
      kind: input.kind,
      severity: input.severity ?? "medium",
      branchId: input.branchId,
      awb: input.awb ?? null,
      parcelId: input.parcelId ?? null,
      bagId: input.bagId ?? null,
      tripId: input.tripId ?? null,
      detail: input.detail,
      evidenceJson: input.evidence === undefined ? null : JSON.stringify(input.evidence),
      status: "open",
      raisedById: input.actor?.userId ?? null,
      raisedByName: input.actor?.name ?? "system",
    })
    .returning();
  await enqueue("custody.exception_raised", {
    exceptionId: row!.id,
    kind: row!.kind,
    awb: row!.awb,
    branchId: row!.branchId,
  });
  return row!;
}

export async function listExceptions(
  scope: Principal,
  filter: { status?: string[]; kind?: string; search?: string } = {},
) {
  const filters = [
    isGlobalScope(scope.role) ? undefined : eq(custodyException.branchId, scope.branchId),
  ];
  if (filter.status?.length) filters.push(inArray(custodyException.status, filter.status));
  if (filter.kind) filters.push(eq(custodyException.kind, filter.kind));
  if (filter.search?.trim()) {
    const term = `%${filter.search.trim().toUpperCase()}%`;
    filters.push(or(like(custodyException.awb, term), like(custodyException.detail, term)));
  }
  const rows = await db
    .select()
    .from(custodyException)
    .where(and(...filters.filter((f) => f !== undefined)))
    .orderBy(desc(custodyException.createdAt))
    .limit(300);

  const openCount = rows.filter((r) => r.status === "open").length;
  return { rows, openCount, total: rows.length };
}

export async function resolveException(
  input: {
    exceptionId: string;
    status: "investigating" | "resolved" | "written_off";
    resolution: string;
  },
  actor: Principal,
): Promise<ExceptionRow> {
  const [row] = await db
    .select()
    .from(custodyException)
    .where(eq(custodyException.id, input.exceptionId));
  if (!row) errors.notFound("Exception");
  if (!isGlobalScope(actor.role) && row!.branchId !== actor.branchId) {
    errors.forbidden("This exception belongs to another branch.");
  }
  if (row!.status === "resolved" || row!.status === "written_off") {
    errors.conflict(`Exception is already ${row!.status}.`, { exceptionId: row!.id });
  }

  const terminal = input.status === "resolved" || input.status === "written_off";
  const [updated] = await db
    .update(custodyException)
    .set({
      status: input.status,
      resolution: input.resolution,
      resolvedAt: terminal ? new Date() : null,
      resolvedByName: terminal ? actor.name : null,
    })
    .where(eq(custodyException.id, row!.id))
    .returning();
  return updated!;
}

// ------------------------------------------------------------------- bags

function mintCode(prefix: string): string {
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.floor(Math.random() * 46_656)
    .toString(36)
    .toUpperCase()
    .padStart(3, "0");
  return `${prefix}${stamp}${rand}`;
}

export interface CreateBagInput {
  destHubId: string;
  originHubId?: string;
}

export async function createBag(input: CreateBagInput, actor: Principal): Promise<BagRow> {
  const originHubId = input.originHubId ?? actor.branchId;
  if (!isGlobalScope(actor.role) && originHubId !== actor.branchId) {
    errors.forbidden("A bag can only be opened at your own branch.");
  }
  if (originHubId === input.destHubId) {
    errors.badRequest("A bag's origin and destination hub must differ.");
  }
  const [origin, dest] = await Promise.all([
    identity.getBranch(originHubId),
    identity.getBranch(input.destHubId),
  ]);
  if (!origin) errors.notFound("Origin hub");
  if (!dest) errors.notFound("Destination hub");

  const [row] = await db
    .insert(bag)
    .values({
      id: prefixedId("bag"),
      code: mintCode("BG"),
      originHubId,
      destHubId: input.destHubId,
      branchId: originHubId,
      status: "open",
      createdByName: actor.name,
    })
    .returning();
  return row!;
}

export interface BagDetail {
  bag: BagRow;
  items: BagItemRow[];
  trip: TripRow | null;
  originHubName: string;
  destHubName: string;
  /** What this caller may legally do next — the UI never infers this itself. */
  canScan: boolean;
  canSeal: boolean;
  canReceive: boolean;
}

export async function getBagDetail(bagId: string, scope: Principal): Promise<BagDetail> {
  const [row] = await db.select().from(bag).where(eq(bag.id, bagId));
  if (!row) errors.notFound("Bag");
  assertBagVisible(row!, scope);

  const [items, tripRow, origin, dest] = await Promise.all([
    db
      .select()
      .from(bagItem)
      .where(eq(bagItem.bagId, row!.id))
      .orderBy(asc(bagItem.scannedAt)),
    row!.tripId
      ? db
          .select()
          .from(trip)
          .where(eq(trip.id, row!.tripId))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    identity.getBranch(row!.originHubId),
    identity.getBranch(row!.destHubId),
  ]);

  return {
    bag: row!,
    items,
    trip: tripRow,
    originHubName: origin?.name ?? row!.originHubId,
    destHubName: dest?.name ?? row!.destHubId,
    canScan: row!.status === "open",
    canSeal: row!.status === "open" && items.some((i) => !i.removedAt),
    canReceive:
      row!.status === "in_transit" &&
      (isGlobalScope(scope.role) || row!.destHubId === scope.branchId),
  };
}

export async function listBags(
  scope: Principal,
  filter: { status?: string[]; destHubId?: string; tripId?: string } = {},
) {
  const filters = [bagScope(scope)];
  if (filter.status?.length) filters.push(inArray(bag.status, filter.status));
  if (filter.destHubId) filters.push(eq(bag.destHubId, filter.destHubId));
  if (filter.tripId) filters.push(eq(bag.tripId, filter.tripId));

  const rows = await db
    .select()
    .from(bag)
    .where(and(...filters.filter((f) => f !== undefined)))
    .orderBy(desc(bag.createdAt))
    .limit(200);

  const branches = await identity.listBranches();
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? id;
  return rows.map((r) => ({
    ...r,
    originHubName: nameOf(r.originHubId),
    destHubName: nameOf(r.destHubId),
  }));
}

export interface ScanLine {
  awb: string;
  outcome: "accepted" | "duplicate" | "rejected";
  reason?: string;
  status?: ParcelStatus;
}

export interface BulkScanResult {
  bag: BagRow;
  accepted: ScanLine[];
  duplicates: ScanLine[];
  rejected: ScanLine[];
  itemCount: number;
}

/**
 * Bulk scan into a bag (§10 M2 "Transport app: bulk scan"). A hub scans a
 * hundred labels in a burst, with duplicates and strays mixed in, and needs a
 * per-label verdict rather than one all-or-nothing error.
 *
 * Per label:
 *   unknown AWB                 → rejected + scan log + illegal_scan exception
 *   already in this bag         → duplicate + scan log (no second item, no error)
 *   in another open bag         → rejected + duplicate_claim exception
 *   wrong status for bagging    → rejected + scan log (the status is the reason)
 *   otherwise                   → parcel transitions to Bagged, item inserted
 *
 * The parcel status change goes through parcels.transitionParcel, so the state
 * machine and the append-only parcel_event are never bypassed.
 */
export async function bulkScanIntoBag(
  input: { bagId: string; awbs: string[]; clientId?: string | null; lat?: number; lng?: number },
  actor: Principal,
): Promise<BulkScanResult> {
  const [row] = await db.select().from(bag).where(eq(bag.id, input.bagId));
  if (!row) errors.notFound("Bag");
  assertBagVisible(row!, actor);
  if (row!.status !== "open") {
    errors.conflict(`Bag ${row!.code} is ${row!.status} and no longer accepts scans.`, {
      bagCode: row!.code,
      bagStatus: row!.status,
    });
  }

  const accepted: ScanLine[] = [];
  const duplicates: ScanLine[] = [];
  const rejected: ScanLine[] = [];

  const { found, unknown } = await parcels.resolveAwbs(input.awbs);

  for (const awb of unknown) {
    await logScan({
      kind: "bag_in",
      outcome: "rejected",
      branchId: row!.branchId,
      bagId: row!.id,
      awb,
      reason: "Unknown AWB",
      actor,
      lat: input.lat,
      lng: input.lng,
      clientId: input.clientId,
    });
    await raiseException({
      kind: "illegal_scan",
      severity: "high",
      branchId: row!.branchId,
      awb,
      bagId: row!.id,
      detail: `Unknown label ${awb} scanned into bag ${row!.code}. A physical parcel exists with no record.`,
      evidence: { bagCode: row!.code, scannedBy: actor.name },
      actor,
    });
    rejected.push({ awb, outcome: "rejected", reason: "Unknown AWB" });
  }

  const existing = await db.select().from(bagItem).where(eq(bagItem.bagId, row!.id));
  const alreadyIn = new Set(existing.filter((i) => !i.removedAt).map((i) => i.parcelId));

  for (const p of found) {
    // Duplicate scan of a label already in this bag: a no-op, logged, not an error.
    if (alreadyIn.has(p.id)) {
      await logScan({
        kind: "bag_in",
        outcome: "duplicate",
        branchId: row!.branchId,
        bagId: row!.id,
        awb: p.awb,
        parcelId: p.id,
        reason: "Already in this bag",
        actor,
        lat: input.lat,
        lng: input.lng,
        clientId: input.clientId,
      });
      duplicates.push({ awb: p.awb, outcome: "duplicate", reason: "Already in this bag" });
      continue;
    }

    // In another bag that is still live: two bags claiming one parcel is exactly
    // the "two riders claim one parcel" class of conflict in §7.
    const [otherClaim] = await db
      .select({ bagId: bagItem.bagId, bagStatus: bag.status, bagCode: bag.code })
      .from(bagItem)
      .innerJoin(bag, eq(bag.id, bagItem.bagId))
      .where(
        and(
          eq(bagItem.parcelId, p.id),
          isNull(bagItem.removedAt),
          inArray(bag.status, ["open", "sealed", "in_transit"]),
        ),
      );
    if (otherClaim) {
      await logScan({
        kind: "bag_in",
        outcome: "rejected",
        branchId: row!.branchId,
        bagId: row!.id,
        awb: p.awb,
        parcelId: p.id,
        reason: `Already in bag ${otherClaim.bagCode}`,
        actor,
        clientId: input.clientId,
      });
      await raiseException({
        kind: "duplicate_claim",
        severity: "high",
        branchId: row!.branchId,
        awb: p.awb,
        parcelId: p.id,
        bagId: row!.id,
        detail: `${p.awb} scanned into ${row!.code} while still held by bag ${otherClaim.bagCode}.`,
        evidence: { otherBag: otherClaim.bagCode, otherBagStatus: otherClaim.bagStatus },
        actor,
      });
      rejected.push({
        awb: p.awb,
        outcome: "rejected",
        reason: `Already in bag ${otherClaim.bagCode}`,
      });
      continue;
    }

    if (!BAGGABLE_FROM.includes(p.status as ParcelStatus)) {
      await logScan({
        kind: "bag_in",
        outcome: "rejected",
        branchId: row!.branchId,
        bagId: row!.id,
        awb: p.awb,
        parcelId: p.id,
        reason: `Parcel is ${p.status}`,
        actor,
        clientId: input.clientId,
      });
      rejected.push({
        awb: p.awb,
        outcome: "rejected",
        reason: `Parcel is ${p.status}, not at a hub`,
        status: p.status as ParcelStatus,
      });
      continue;
    }

    // Status change through the owning module — never a direct parcel write.
    try {
      await parcels.transitionParcel(
        {
          awbOrId: p.id,
          to: "Bagged",
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          notes: `Bagged into ${row!.code} for ${row!.destHubId}.`,
          clientId: input.clientId ? `${input.clientId}:${p.awb}` : null,
        },
        actor,
      );
    } catch (err) {
      // A dropped database socket is not a refusal: say so plainly (the raw
      // driver message is a SQL statement) and keep the detail in the log.
      const transient = isTransientDbError(err);
      if (transient) console.warn(`[transport] bag scan ${p.awb}: transient database error`, err);
      const reason = transient
        ? "Connection to the database dropped — scan this parcel again."
        : err instanceof Error ? err.message : "Transition refused";
      await logScan({
        kind: "bag_in",
        outcome: "rejected",
        branchId: row!.branchId,
        bagId: row!.id,
        awb: p.awb,
        parcelId: p.id,
        reason,
        actor,
        clientId: input.clientId,
      });
      rejected.push({ awb: p.awb, outcome: "rejected", reason });
      continue;
    }

    await db.insert(bagItem).values({
      id: prefixedId("bgi"),
      bagId: row!.id,
      parcelId: p.id,
      awb: p.awb,
      scannedById: actor.userId,
      scannedByName: actor.name,
      deviceId: actor.deviceId ?? null,
    });
    await logScan({
      kind: "bag_in",
      outcome: "accepted",
      branchId: row!.branchId,
      bagId: row!.id,
      awb: p.awb,
      parcelId: p.id,
      actor,
      lat: input.lat,
      lng: input.lng,
      clientId: input.clientId,
    });
    accepted.push({ awb: p.awb, outcome: "accepted", status: "Bagged" });
    alreadyIn.add(p.id);
  }

  const live = await db
    .select({ value: count() })
    .from(bagItem)
    .where(and(eq(bagItem.bagId, row!.id), isNull(bagItem.removedAt)));
  const itemCount = live[0]?.value ?? 0;
  const weight = await bagWeight(row!.id);

  const [updated] = await db
    .update(bag)
    .set({ itemCount, weightGrams: weight })
    .where(eq(bag.id, row!.id))
    .returning();

  return { bag: updated!, accepted, duplicates, rejected, itemCount };
}

/** Sum of the weights of the parcels currently in a bag, in grams. */
async function bagWeight(bagId: string): Promise<number> {
  const items = await db
    .select({ parcelId: bagItem.parcelId })
    .from(bagItem)
    .where(and(eq(bagItem.bagId, bagId), isNull(bagItem.removedAt)));
  if (items.length === 0) return 0;
  const rows = await parcels.parcelsByIds(items.map((i) => i.parcelId));
  return rows.reduce((sum, r) => sum + r.weightGrams, 0);
}

/**
 * Take a parcel back out of an open bag. The item row is marked removed, never
 * deleted — a parcel that went into a bag and came out again is custody
 * history. The parcel returns to AtOriginHub through the state machine.
 */
export async function removeFromBag(
  input: { bagId: string; awb: string },
  actor: Principal,
): Promise<BulkScanResult> {
  const [row] = await db.select().from(bag).where(eq(bag.id, input.bagId));
  if (!row) errors.notFound("Bag");
  assertBagVisible(row!, actor);
  if (row!.status !== "open") {
    errors.conflict(`Bag ${row!.code} is ${row!.status}; break the seal first.`, {
      bagStatus: row!.status,
    });
  }

  const awb = input.awb.trim().toUpperCase();
  const [item] = await db
    .select()
    .from(bagItem)
    .where(and(eq(bagItem.bagId, row!.id), eq(bagItem.awb, awb), isNull(bagItem.removedAt)));
  if (!item) errors.notFound(`${awb} in bag ${row!.code}`);

  await parcels.transitionParcel(
    {
      awbOrId: item!.parcelId,
      to: "AtOriginHub",
      notes: `Removed from bag ${row!.code}.`,
    },
    actor,
  );

  await db
    .update(bagItem)
    .set({ removedAt: new Date(), removedByName: actor.name })
    .where(eq(bagItem.id, item!.id));
  await logScan({
    kind: "bag_out",
    outcome: "accepted",
    branchId: row!.branchId,
    bagId: row!.id,
    awb,
    parcelId: item!.parcelId,
    reason: "Removed before sealing",
    actor,
  });

  const live = await db
    .select({ value: count() })
    .from(bagItem)
    .where(and(eq(bagItem.bagId, row!.id), isNull(bagItem.removedAt)));
  const [updated] = await db
    .update(bag)
    .set({ itemCount: live[0]?.value ?? 0, weightGrams: await bagWeight(row!.id) })
    .where(eq(bag.id, row!.id))
    .returning();

  return {
    bag: updated!,
    accepted: [],
    duplicates: [],
    rejected: [],
    itemCount: updated!.itemCount,
  };
}

/**
 * Seal a bag. §6: "Bagged → InTransit requires the bag to be sealed and
 * assigned to a trip" — this is the first half of that precondition. The seal
 * number is the physical tamper evidence the receiving hub checks against.
 */
export async function sealBag(
  input: { bagId: string; sealNumber: string },
  actor: Principal,
): Promise<BagRow> {
  const [row] = await db.select().from(bag).where(eq(bag.id, input.bagId));
  if (!row) errors.notFound("Bag");
  assertBagVisible(row!, actor);
  if (row!.status !== "open") {
    errors.conflict(`Bag ${row!.code} is already ${row!.status}.`, { bagStatus: row!.status });
  }
  if (row!.itemCount < 1) {
    errors.badRequest("An empty bag cannot be sealed.", { bagCode: row!.code });
  }

  const seal = input.sealNumber.trim().toUpperCase();
  const [clash] = await db
    .select({ code: bag.code })
    .from(bag)
    .where(and(eq(bag.sealNumber, seal), inArray(bag.status, ["sealed", "in_transit"])));
  if (clash) {
    errors.conflict(`Seal ${seal} is already on live bag ${clash.code}.`, { seal });
  }

  const [updated] = await db
    .update(bag)
    .set({
      sealNumber: seal,
      status: "sealed",
      sealedAt: new Date(),
      sealedByName: actor.name,
      weightGrams: await bagWeight(row!.id),
    })
    .where(and(eq(bag.id, row!.id), eq(bag.status, "open")))
    .returning();
  if (!updated) errors.conflict("Bag changed state concurrently. Re-read and retry.");
  return updated!;
}

/** Re-open a sealed bag that has not departed. The broken seal is audited. */
export async function breakSeal(
  input: { bagId: string; reason: string },
  actor: Principal,
): Promise<BagRow> {
  const [row] = await db.select().from(bag).where(eq(bag.id, input.bagId));
  if (!row) errors.notFound("Bag");
  assertBagVisible(row!, actor);
  if (row!.status !== "sealed") {
    errors.conflict(`Only a sealed bag can have its seal broken; this one is ${row!.status}.`);
  }

  await logScan({
    kind: "bag_out",
    outcome: "accepted",
    branchId: row!.branchId,
    bagId: row!.id,
    reason: `Seal ${row!.sealNumber} broken: ${input.reason}`,
    actor,
  });
  await raiseException({
    kind: "seal_mismatch",
    severity: "low",
    branchId: row!.branchId,
    bagId: row!.id,
    detail: `Seal ${row!.sealNumber} on bag ${row!.code} was broken before departure: ${input.reason}`,
    evidence: { previousSeal: row!.sealNumber, brokenBy: actor.name },
    actor,
  });

  const [updated] = await db
    .update(bag)
    .set({ status: "open", sealNumber: null, sealedAt: null, sealedByName: null, tripId: null })
    .where(eq(bag.id, row!.id))
    .returning();
  return updated!;
}

// ------------------------------------------------------------------- trips

/** Vehicle types a linehaul trip may run on (Round 6). */
export const TRIP_VEHICLE_TYPES = ["bus", "van", "lorry", "car"] as const;
export type TripVehicleType = (typeof TRIP_VEHICLE_TYPES)[number];
/** Who runs the bus — asked every time the vehicle is a bus. */
export const BUS_OPERATORS = ["ctb", "private", "ac_bus"] as const;
export type BusOperator = (typeof BUS_OPERATORS)[number];

export interface CreateTripInput {
  vehicleRegistration: string;
  destHubId: string;
  driverId?: string | null;
  route?: string | null;
  originHubId?: string;
  vehicleType?: TripVehicleType | null;
  busOperator?: BusOperator | null;
  contactName?: string | null;
  contactPhone?: string | null;
  expectedArrivalAt?: Date | null;
  arrivalStation?: string | null;
}

const LK_PHONE = /^\+94\d{9}$/;

/**
 * The Round 6 vehicle fields, checked together. A bus always carries an
 * operator; nothing else may. A contact phone must be a Sri Lankan number. An
 * expected arrival cannot already be in the past.
 */
function vehicleFields(input: CreateTripInput, now = new Date()) {
  const vehicleType = input.vehicleType ?? null;
  const busOperator = input.busOperator ?? null;
  if (vehicleType === "bus" && !busOperator) {
    errors.badRequest("A bus trip needs the bus operator: CTB, Private or AC bus.", {
      field: "busOperator",
    });
  }
  if (vehicleType !== "bus" && busOperator) {
    errors.badRequest("A bus operator only applies when the vehicle is a bus.", {
      field: "busOperator",
    });
  }
  let contactPhone: string | null = null;
  if (input.contactPhone?.trim()) {
    contactPhone = normaliseLkPhone(input.contactPhone.trim());
    if (!LK_PHONE.test(contactPhone)) {
      errors.badRequest("The contact phone must be a Sri Lankan number, e.g. 0771234567.", {
        field: "contactPhone",
      });
    }
  }
  const expectedArrivalAt = input.expectedArrivalAt ?? null;
  // Five minutes of grace for a clock that is slightly behind the server.
  if (expectedArrivalAt && expectedArrivalAt.getTime() < now.getTime() - 5 * 60_000) {
    errors.badRequest("The expected arrival time is already in the past.", {
      field: "expectedArrivalAt",
    });
  }
  return {
    vehicleType,
    busOperator,
    contactName: input.contactName?.trim() || null,
    contactPhone,
    expectedArrivalAt,
    arrivalStation: input.arrivalStation?.trim() || null,
  };
}

export async function createTrip(input: CreateTripInput, actor: Principal): Promise<TripRow> {
  const originHubId = input.originHubId ?? actor.branchId;
  if (!isGlobalScope(actor.role) && originHubId !== actor.branchId) {
    errors.forbidden("A trip can only be created at your own branch.");
  }
  if (originHubId === input.destHubId) {
    errors.badRequest("A trip's origin and destination hub must differ.");
  }
  const [origin, dest] = await Promise.all([
    identity.getBranch(originHubId),
    identity.getBranch(input.destHubId),
  ]);
  if (!origin) errors.notFound("Origin hub");
  if (!dest) errors.notFound("Destination hub");
  const vehicle = vehicleFields(input);

  let driverName: string | null = null;
  if (input.driverId) {
    const driver = await identity.getUserById(input.driverId);
    if (!driver) errors.notFound("Driver");
    if (driver!.role !== "transport" && driver!.role !== "rider") {
      errors.badRequest("A trip driver must be a transport or rider user.");
    }
    driverName = driver!.name;
  }

  const [row] = await db
    .insert(trip)
    .values({
      id: prefixedId("trp"),
      code: mintCode("TR"),
      vehicleRegistration: input.vehicleRegistration.trim().toUpperCase(),
      driverId: input.driverId ?? null,
      driverName,
      originHubId,
      destHubId: input.destHubId,
      branchId: originHubId,
      route: input.route ?? `${origin!.code} → ${dest!.code}`,
      status: "planned",
      createdByName: actor.name,
      ...vehicle,
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------- bag photo

/** Object-key prefix a bag's photo must live under. */
export function bagPhotoPrefix(bagCode: string): string {
  return `bag/${bagCode.toUpperCase()}/`;
}

/** The bag a photo slot is being asked for — scoped exactly like any bag read. */
export async function bagForPhoto(bagId: string, actor: Principal): Promise<BagRow> {
  const [row] = await db.select().from(bag).where(eq(bag.id, bagId));
  if (!row) errors.notFound("Bag");
  assertBagVisible(row!, actor);
  if (row!.status === "cancelled") errors.conflict(`Bag ${row!.code} is cancelled.`);
  return row!;
}

/**
 * Attach (or replace) the optional photo of a bag. The ref must be one minted
 * for THIS bag by transport.bagPhotoUpload — a pasted URL or another bag's
 * upload is refused, the same rule photo POD follows.
 */
export async function attachBagPhoto(
  input: { bagId: string; storageRef: string },
  actor: Principal,
): Promise<BagRow> {
  const row = await bagForPhoto(input.bagId, actor);
  const ref = input.storageRef.trim();
  if (!ref.startsWith(`s3:${bagPhotoPrefix(row.code)}`)) {
    errors.badRequest("That photo was not uploaded for this bag.", { field: "storageRef" });
  }
  const [updated] = await db
    .update(bag)
    .set({ photoRef: ref, photoAt: new Date(), photoByName: actor.name })
    .where(eq(bag.id, row.id))
    .returning();
  return updated!;
}

/** Load a sealed bag onto a planned trip — the second half of the §6 precondition. */
export async function loadBagOntoTrip(
  input: { tripId: string; bagId: string },
  actor: Principal,
): Promise<{ trip: TripRow; bag: BagRow }> {
  const [tripRow] = await db.select().from(trip).where(eq(trip.id, input.tripId));
  if (!tripRow) errors.notFound("Trip");
  if (!isGlobalScope(actor.role) && tripRow!.branchId !== actor.branchId) {
    errors.forbidden("This trip belongs to another branch.");
  }
  if (tripRow!.status !== "planned" && tripRow!.status !== "loading") {
    errors.conflict(`Trip ${tripRow!.code} is ${tripRow!.status} and cannot take more bags.`);
  }

  const [bagRow] = await db.select().from(bag).where(eq(bag.id, input.bagId));
  if (!bagRow) errors.notFound("Bag");
  assertBagVisible(bagRow!, actor);
  if (bagRow!.status !== "sealed") {
    errors.conflict(`Bag ${bagRow!.code} must be sealed before loading; it is ${bagRow!.status}.`, {
      bagStatus: bagRow!.status,
    });
  }
  if (bagRow!.destHubId !== tripRow!.destHubId) {
    errors.badRequest(
      `Bag ${bagRow!.code} is routed to a different hub than trip ${tripRow!.code}.`,
      { bagDestHubId: bagRow!.destHubId, tripDestHubId: tripRow!.destHubId },
    );
  }

  const [updatedBag] = await db
    .update(bag)
    .set({ tripId: tripRow!.id })
    .where(and(eq(bag.id, bagRow!.id), eq(bag.status, "sealed")))
    .returning();
  if (!updatedBag) errors.conflict("Bag changed state concurrently. Re-read and retry.");

  const [updatedTrip] = await db
    .update(trip)
    .set({ status: "loading" })
    .where(eq(trip.id, tripRow!.id))
    .returning();

  await logScan({
    kind: "trip_load",
    outcome: "accepted",
    branchId: tripRow!.branchId,
    bagId: bagRow!.id,
    tripId: tripRow!.id,
    actor,
  });

  return { trip: updatedTrip!, bag: updatedBag! };
}

/**
 * Depart a trip. This is where Bagged → InTransit happens for every parcel on
 * board, and it is refused unless §6's precondition holds for every bag: a
 * seal AND this trip. A bag with no seal cannot depart, full stop.
 */
export async function departTrip(
  input: { tripId: string; seal: string; lat?: number; lng?: number },
  actor: Principal,
): Promise<{
  trip: TripRow;
  bags: number;
  parcelsMoved: number;
  rejected: { awb: string; reason: string }[];
}> {
  const [tripRow] = await db.select().from(trip).where(eq(trip.id, input.tripId));
  if (!tripRow) errors.notFound("Trip");
  if (!isGlobalScope(actor.role) && tripRow!.branchId !== actor.branchId) {
    errors.forbidden("This trip belongs to another branch.");
  }
  if (tripRow!.status === "departed" || tripRow!.status === "arrived") {
    errors.conflict(`Trip ${tripRow!.code} has already ${tripRow!.status}.`);
  }
  if (tripRow!.status !== "loading" && tripRow!.status !== "planned") {
    errors.conflict(`Trip ${tripRow!.code} is ${tripRow!.status} and cannot depart.`);
  }

  const bags = await db.select().from(bag).where(eq(bag.tripId, tripRow!.id));
  if (bags.length === 0) {
    errors.badRequest(`Trip ${tripRow!.code} has no bags loaded.`);
  }
  const unsealed = bags.filter((b) => !b.sealNumber || b.status !== "sealed");
  if (unsealed.length > 0) {
    // §6, verbatim: a bag must be sealed and assigned to a trip to move.
    errors.badRequest(
      `Trip ${tripRow!.code} cannot depart: ${unsealed.length} bag(s) are not sealed.`,
      { unsealedBags: unsealed.map((b) => b.code) },
    );
  }

  const items = await db
    .select()
    .from(bagItem)
    .where(
      and(
        inArray(
          bagItem.bagId,
          bags.map((b) => b.id),
        ),
        isNull(bagItem.removedAt),
      ),
    );

  const result = await parcels.transitionMany(
    items.map((i) => i.parcelId),
    "InTransit",
    actor,
    {
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      notes: `Departed on trip ${tripRow!.code} (${tripRow!.vehicleRegistration}).`,
    },
    // Every bag on this trip was checked sealed above — that is the §6 guard.
    { tripId: tripRow!.id },
  );

  const now = new Date();
  const [updatedTrip] = await db
    .update(trip)
    .set({
      status: "departed",
      seal: input.seal.trim().toUpperCase(),
      departedAt: now,
    })
    .where(and(eq(trip.id, tripRow!.id), inArray(trip.status, ["planned", "loading"])))
    .returning();
  if (!updatedTrip) errors.conflict("Trip changed state concurrently. Re-read and retry.");

  await db
    .update(bag)
    .set({ status: "in_transit" })
    .where(
      and(
        eq(bag.tripId, tripRow!.id),
        eq(bag.status, "sealed"),
      ),
    );

  for (const b of bags) {
    await logScan({
      kind: "bag_out",
      outcome: "accepted",
      branchId: tripRow!.branchId,
      bagId: b.id,
      tripId: tripRow!.id,
      hubId: tripRow!.originHubId,
      reason: "Departed",
      actor,
      lat: input.lat,
      lng: input.lng,
    });
  }

  // Any parcel that refused the transition is a variance, not a rounding error.
  for (const r of result.rejected) {
    await raiseException({
      kind: "count_variance",
      severity: "high",
      branchId: tripRow!.branchId,
      awb: r.awb,
      tripId: tripRow!.id,
      detail: `Parcel ${r.awb} was in a bag on departed trip ${tripRow!.code} but could not move to InTransit: ${r.reason}`,
      evidence: r,
      actor,
    });
  }

  await enqueue("trip.departed", {
    tripId: updatedTrip!.id,
    code: updatedTrip!.code,
    bags: bags.length,
    parcels: result.moved.length,
  });

  return {
    trip: updatedTrip!,
    bags: bags.length,
    parcelsMoved: result.moved.length,
    rejected: result.rejected,
  };
}

/**
 * Mark a trip arrived. Arrival does NOT move parcels — the bags still have to
 * be physically received and scanned at the hub (receiveBag below). Conflating
 * the two would mean a parcel that never came off the vehicle would still be
 * recorded as at the destination.
 */
export async function arriveTrip(
  input: { tripId: string; lat?: number; lng?: number },
  actor: Principal,
): Promise<TripRow> {
  const [tripRow] = await db.select().from(trip).where(eq(trip.id, input.tripId));
  if (!tripRow) errors.notFound("Trip");
  if (
    !isGlobalScope(actor.role) &&
    tripRow!.branchId !== actor.branchId &&
    tripRow!.destHubId !== actor.branchId
  ) {
    errors.forbidden("This trip is neither from nor to your branch.");
  }
  if (tripRow!.status !== "departed") {
    errors.conflict(`Trip ${tripRow!.code} is ${tripRow!.status}, not in transit.`);
  }

  const [updated] = await db
    .update(trip)
    .set({ status: "arrived", arrivedAt: new Date() })
    .where(and(eq(trip.id, tripRow!.id), eq(trip.status, "departed")))
    .returning();
  if (!updated) errors.conflict("Trip changed state concurrently. Re-read and retry.");

  await logScan({
    kind: "bag_receive",
    outcome: "accepted",
    branchId: tripRow!.destHubId,
    tripId: tripRow!.id,
    hubId: tripRow!.destHubId,
    reason: "Vehicle arrived; bags not yet received",
    actor,
    lat: input.lat,
    lng: input.lng,
  });
  return updated!;
}

export interface TripDetail {
  trip: TripRow;
  bags: (BagRow & { originHubName: string; destHubName: string })[];
  parcelCount: number;
  originHubName: string;
  destHubName: string;
}

export async function getTripDetail(tripId: string, scope: Principal): Promise<TripDetail> {
  const [tripRow] = await db.select().from(trip).where(eq(trip.id, tripId));
  if (!tripRow) errors.notFound("Trip");
  if (
    !isGlobalScope(scope.role) &&
    tripRow!.branchId !== scope.branchId &&
    tripRow!.destHubId !== scope.branchId
  ) {
    errors.forbidden("This trip is neither from nor to your branch.");
  }

  const bagRows = await db.select().from(bag).where(eq(bag.tripId, tripRow!.id));
  const branches = await identity.listBranches();
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? id;

  return {
    trip: tripRow!,
    bags: bagRows.map((b) => ({
      ...b,
      originHubName: nameOf(b.originHubId),
      destHubName: nameOf(b.destHubId),
    })),
    parcelCount: bagRows.reduce((sum, b) => sum + b.itemCount, 0),
    originHubName: nameOf(tripRow!.originHubId),
    destHubName: nameOf(tripRow!.destHubId),
  };
}

/** The linehaul board (§10 M2): every trip in flight, with its load. */
export async function linehaulBoard(scope: Principal) {
  const rows = await db
    .select()
    .from(trip)
    .where(and(...[tripScope(scope)].filter((f) => f !== undefined)))
    .orderBy(desc(trip.createdAt))
    .limit(100);

  const branches = await identity.listBranches();
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? id;

  const bagRows =
    rows.length === 0
      ? []
      : await db
          .select({
            tripId: bag.tripId,
            bagId: bag.id,
            code: bag.code,
            itemCount: bag.itemCount,
            status: bag.status,
          })
          .from(bag)
          .where(
            inArray(
              bag.tripId,
              rows.map((r) => r.id),
            ),
          );

  const trips = rows.map((r) => {
    const load = bagRows.filter((b) => b.tripId === r.id);
    return {
      ...r,
      originHubName: nameOf(r.originHubId),
      destHubName: nameOf(r.destHubId),
      bagCount: load.length,
      parcelCount: load.reduce((s, b) => s + b.itemCount, 0),
      bagsReceived: load.filter((b) => b.status === "received" || b.status === "reconciled")
        .length,
    };
  });

  return {
    trips,
    counts: {
      planned: trips.filter((t) => t.status === "planned" || t.status === "loading").length,
      inFlight: trips.filter((t) => t.status === "departed").length,
      arrived: trips.filter((t) => t.status === "arrived").length,
    },
  };
}

// ------------------------------------------------- hub receipt & variance

export interface ReceiveBagResult {
  bag: BagRow;
  received: ScanLine[];
  duplicates: ScanLine[];
  /** Expected in the bag, never scanned at the destination. */
  missing: { awb: string; reason: string }[];
  /** Scanned at the destination, not on the bag's manifest. */
  unexpected: { awb: string; reason: string }[];
  sealMatched: boolean;
  exceptionsRaised: number;
}

/**
 * Two-party hub receipt with variance detection (§10 M2).
 *
 * Party one is the seal and manifest the origin hub committed to when it sealed
 * the bag; party two is the receiving hub's physical scan, plus the named person
 * releasing and the named person receiving. Where the two disagree, the
 * disagreement is recorded as an exception — never reconciled away.
 *
 * Variance classes detected here:
 *   seal mismatch            → seal_mismatch, high
 *   expected but not scanned → missing_at_destination, high   (a possible loss)
 *   scanned but not expected → unexpected_at_destination, medium
 */
export async function receiveBag(
  input: {
    bagId: string;
    scannedAwbs: string[];
    sealNumber?: string | null;
    releasedByName: string;
    receivedByName?: string | null;
    clientId?: string | null;
    lat?: number;
    lng?: number;
  },
  actor: Principal,
): Promise<ReceiveBagResult> {
  const [row] = await db.select().from(bag).where(eq(bag.id, input.bagId));
  if (!row) errors.notFound("Bag");
  if (!isGlobalScope(actor.role) && row!.destHubId !== actor.branchId) {
    errors.forbidden("Only the destination hub may receive this bag.", {
      destHubId: row!.destHubId,
    });
  }
  if (row!.status === "received" || row!.status === "reconciled") {
    errors.conflict(`Bag ${row!.code} was already received at ${row!.receivedAt?.toISOString()}.`, {
      bagStatus: row!.status,
    });
  }
  if (row!.status !== "in_transit") {
    errors.conflict(`Bag ${row!.code} is ${row!.status} and is not in transit to you.`, {
      bagStatus: row!.status,
    });
  }

  let exceptionsRaised = 0;

  // ── Party-one evidence: the seal the origin hub applied.
  const presented = input.sealNumber?.trim().toUpperCase() ?? null;
  const sealMatched = presented !== null && presented === row!.sealNumber;
  if (presented !== null && !sealMatched) {
    await raiseException({
      kind: "seal_mismatch",
      severity: "high",
      branchId: row!.destHubId,
      bagId: row!.id,
      tripId: row!.tripId,
      detail: `Bag ${row!.code} arrived with seal ${presented}; it was sealed as ${row!.sealNumber}.`,
      evidence: { expectedSeal: row!.sealNumber, presentedSeal: presented },
      actor,
    });
    exceptionsRaised += 1;
  }

  // ── Party-two evidence: what the receiving hub actually scanned.
  const manifestItems = await db
    .select()
    .from(bagItem)
    .where(and(eq(bagItem.bagId, row!.id), isNull(bagItem.removedAt)));
  const expectedByAwb = new Map(manifestItems.map((i) => [i.awb, i]));

  const scanned = [...new Set(input.scannedAwbs.map((a) => a.trim().toUpperCase()).filter(Boolean))];
  const received: ScanLine[] = [];
  const duplicates: ScanLine[] = [];
  const unexpected: { awb: string; reason: string }[] = [];

  for (const awb of scanned) {
    const item = expectedByAwb.get(awb);
    if (!item) {
      // A label in the bag that the manifest never had.
      const { found } = await parcels.resolveAwbs([awb]);
      const reason = found[0]
        ? `Not on bag ${row!.code}'s manifest (parcel is ${found[0].status})`
        : `Unknown label, not on bag ${row!.code}'s manifest`;
      await logScan({
        kind: "parcel_in",
        outcome: "rejected",
        branchId: row!.destHubId,
        bagId: row!.id,
        hubId: row!.destHubId,
        awb,
        parcelId: found[0]?.id ?? null,
        reason,
        actor,
        lat: input.lat,
        lng: input.lng,
        clientId: input.clientId,
      });
      await raiseException({
        kind: "unexpected_at_destination",
        severity: "medium",
        branchId: row!.destHubId,
        awb,
        parcelId: found[0]?.id ?? null,
        bagId: row!.id,
        tripId: row!.tripId,
        detail: `${awb} was scanned out of bag ${row!.code} at the destination hub but is not on its manifest.`,
        evidence: { bagCode: row!.code, seal: row!.sealNumber },
        actor,
      });
      exceptionsRaised += 1;
      unexpected.push({ awb, reason });
      continue;
    }

    try {
      // Accountability moves *before* the status does, and deliberately so:
      // until it moves, the parcel still belongs to the origin hub and the
      // receiving hub's principal is refused by the §5 branch-scope check on
      // transitionParcel — the receiving hub would be unable to receive its own
      // inbound bag. The physical scan is the moment custody transfers, so the
      // branch move is what the scan records first. If the transition then
      // fails, accountability stays here (the parcel is physically here) and
      // the refusal is raised as an exception below.
      await parcels.reassignBranch(
        [item.parcelId],
        row!.destHubId,
        actor,
        `Scanned in at the destination hub out of bag ${row!.code}.`,
      );
      const outcome = await parcels.transitionParcel(
        {
          awbOrId: item.parcelId,
          to: "AtDestHub",
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          notes: `Received at destination hub out of bag ${row!.code}.`,
          clientId: input.clientId ? `${input.clientId}:${awb}` : null,
        },
        actor,
      );
      if (outcome.deduped) {
        duplicates.push({ awb, outcome: "duplicate", reason: "Scan already applied" });
        await logScan({
          kind: "parcel_in",
          outcome: "duplicate",
          branchId: row!.destHubId,
          bagId: row!.id,
          hubId: row!.destHubId,
          awb,
          parcelId: item.parcelId,
          reason: "Scan already applied",
          actor,
          clientId: input.clientId,
        });
        continue;
      }
      received.push({ awb, outcome: "accepted", status: "AtDestHub" });
      await logScan({
        kind: "parcel_in",
        outcome: "accepted",
        branchId: row!.destHubId,
        bagId: row!.id,
        hubId: row!.destHubId,
        awb,
        parcelId: item.parcelId,
        actor,
        lat: input.lat,
        lng: input.lng,
        clientId: input.clientId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Transition refused";
      await logScan({
        kind: "parcel_in",
        outcome: "rejected",
        branchId: row!.destHubId,
        bagId: row!.id,
        hubId: row!.destHubId,
        awb,
        parcelId: item.parcelId,
        reason,
        actor,
        clientId: input.clientId,
      });
      await raiseException({
        kind: "illegal_scan",
        severity: "high",
        branchId: row!.destHubId,
        awb,
        parcelId: item.parcelId,
        bagId: row!.id,
        detail: `${awb} was physically in bag ${row!.code} but the system refused AtDestHub: ${reason}`,
        evidence: { reason },
        actor,
      });
      exceptionsRaised += 1;
      unexpected.push({ awb, reason });
    }
  }

  // ── The variance that matters most: on the manifest, never scanned.
  const scannedSet = new Set(scanned);
  const missing: { awb: string; reason: string }[] = [];
  for (const item of manifestItems) {
    if (scannedSet.has(item.awb)) continue;
    const reason = `On bag ${row!.code}'s manifest, not scanned at the destination hub`;
    missing.push({ awb: item.awb, reason });
    await raiseException({
      kind: "missing_at_destination",
      severity: "high",
      branchId: row!.destHubId,
      awb: item.awb,
      parcelId: item.parcelId,
      bagId: row!.id,
      tripId: row!.tripId,
      detail: `${item.awb} left ${row!.originHubId} in sealed bag ${row!.code} and was not scanned on arrival. Possible loss — investigate before the bag is reconciled.`,
      evidence: {
        bagCode: row!.code,
        seal: row!.sealNumber,
        scannedInto: item.scannedByName,
        scannedAt: item.scannedAt,
      },
      actor,
    });
    exceptionsRaised += 1;
  }

  // Accountability already moved per-parcel in the scan loop above — a parcel
  // that never arrived keeps the origin hub's name against it, which is the
  // whole point of the missing_at_destination exception.
  const clean = missing.length === 0 && unexpected.length === 0 && sealMatched;
  const [updated] = await db
    .update(bag)
    .set({
      // A bag with an open variance is "received", not "reconciled" — the
      // distinction is what stops a variance disappearing on arrival.
      status: clean ? "reconciled" : "received",
      branchId: row!.destHubId,
      receivedAt: new Date(),
      receivedByName: input.receivedByName?.trim() || actor.name,
    })
    .where(and(eq(bag.id, row!.id), eq(bag.status, "in_transit")))
    .returning();
  if (!updated) errors.conflict("Bag changed state concurrently. Re-read and retry.");

  await logScan({
    kind: "bag_receive",
    outcome: missing.length > 0 || unexpected.length > 0 ? "rejected" : "accepted",
    branchId: row!.destHubId,
    bagId: row!.id,
    tripId: row!.tripId,
    hubId: row!.destHubId,
    reason: `Two-party handover: released by ${input.releasedByName}, received by ${
      input.receivedByName?.trim() || actor.name
    }. Expected ${manifestItems.length}, scanned ${scanned.length}, variance ${
      missing.length + unexpected.length
    }.`,
    actor,
    lat: input.lat,
    lng: input.lng,
    clientId: input.clientId,
  });

  await enqueue("bag.received", {
    bagId: updated!.id,
    code: updated!.code,
    expected: manifestItems.length,
    received: received.length,
    missing: missing.length,
    unexpected: unexpected.length,
  });

  return {
    bag: updated!,
    received,
    duplicates,
    missing,
    unexpected,
    sealMatched,
    exceptionsRaised,
  };
}

/** Inbound bags a hub should expect — the receiving screen's work queue. */
export async function inboundBags(scope: Principal) {
  const rows = await db
    .select()
    .from(bag)
    .where(
      and(
        inArray(bag.status, ["in_transit"]),
        isGlobalScope(scope.role) ? undefined : eq(bag.destHubId, scope.branchId),
      ),
    )
    .orderBy(asc(bag.sealedAt))
    .limit(100);

  const branches = await identity.listBranches();
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? id;
  const tripIds = [...new Set(rows.map((r) => r.tripId).filter((t): t is string => !!t))];
  const trips =
    tripIds.length === 0 ? [] : await db.select().from(trip).where(inArray(trip.id, tripIds));

  return rows.map((r) => ({
    ...r,
    originHubName: nameOf(r.originHubId),
    destHubName: nameOf(r.destHubId),
    tripCode: trips.find((t) => t.id === r.tripId)?.code ?? null,
    tripStatus: trips.find((t) => t.id === r.tripId)?.status ?? null,
  }));
}

/** The hub scan log (§10 M2) — raw evidence, accepted and rejected alike. */
export async function scanLog(
  scope: Principal,
  filter: { kind?: string; outcome?: string; search?: string; limit?: number } = {},
) {
  const filters = [isGlobalScope(scope.role) ? undefined : eq(hubScan.branchId, scope.branchId)];
  if (filter.kind) filters.push(eq(hubScan.kind, filter.kind));
  if (filter.outcome) filters.push(eq(hubScan.outcome, filter.outcome));
  if (filter.search?.trim()) {
    filters.push(like(hubScan.awb, `%${filter.search.trim().toUpperCase()}%`));
  }
  return db
    .select()
    .from(hubScan)
    .where(and(...filters.filter((f) => f !== undefined)))
    .orderBy(desc(hubScan.ts))
    .limit(Math.min(filter.limit ?? 150, 500));
}

/**
 * Every custody record touching one parcel, for the chain-of-custody timeline
 * (§10 M2). The parcel's own event chain is owned by the parcels module; this
 * adds the transport-side legs — which bag, which seal, which trip, which scans
 * (including rejected ones) — so the timeline shows physical custody, not just
 * status changes.
 */
export async function custodyChain(awb: string, scope: Principal) {
  const detail = await parcels.getParcelDetail(awb, scope);

  const bagLegs = await db
    .select({
      item: bagItem,
      bagCode: bag.code,
      bagId: bag.id,
      seal: bag.sealNumber,
      bagStatus: bag.status,
      originHubId: bag.originHubId,
      destHubId: bag.destHubId,
      tripId: bag.tripId,
    })
    .from(bagItem)
    .innerJoin(bag, eq(bag.id, bagItem.bagId))
    .where(eq(bagItem.parcelId, detail.parcel.id))
    .orderBy(asc(bagItem.scannedAt));

  const tripIds = [...new Set(bagLegs.map((l) => l.tripId).filter((t): t is string => !!t))];
  const trips =
    tripIds.length === 0 ? [] : await db.select().from(trip).where(inArray(trip.id, tripIds));

  const scans = await db
    .select()
    .from(hubScan)
    .where(eq(hubScan.parcelId, detail.parcel.id))
    .orderBy(asc(hubScan.ts));

  const exceptions = await db
    .select()
    .from(custodyException)
    .where(eq(custodyException.parcelId, detail.parcel.id))
    .orderBy(asc(custodyException.createdAt));

  const branches = await identity.listBranches();
  const nameOf = (id: string) => branches.find((b) => b.id === id)?.name ?? id;

  return {
    ...detail,
    bags: bagLegs.map((l) => ({
      bagId: l.bagId,
      bagCode: l.bagCode,
      seal: l.seal,
      bagStatus: l.bagStatus,
      originHubName: nameOf(l.originHubId),
      destHubName: nameOf(l.destHubId),
      scannedAt: l.item.scannedAt,
      scannedByName: l.item.scannedByName,
      removedAt: l.item.removedAt,
      tripCode: trips.find((t) => t.id === l.tripId)?.code ?? null,
      tripVehicle: trips.find((t) => t.id === l.tripId)?.vehicleRegistration ?? null,
      tripSeal: trips.find((t) => t.id === l.tripId)?.seal ?? null,
      departedAt: trips.find((t) => t.id === l.tripId)?.departedAt ?? null,
      arrivedAt: trips.find((t) => t.id === l.tripId)?.arrivedAt ?? null,
    })),
    scans,
    exceptions,
  };
}

/** Parcels sitting at this branch's hub, ready to be bagged. */
export async function baggableParcels(scope: Principal) {
  const rows = await parcels.parcelsAwaiting(["AtOriginHub", "AtDestHub"], scope, 200);
  const inLiveBag = await db
    .select({ parcelId: bagItem.parcelId })
    .from(bagItem)
    .innerJoin(bag, eq(bag.id, bagItem.bagId))
    .where(and(isNull(bagItem.removedAt), inArray(bag.status, ["open", "sealed", "in_transit"])));
  const held = new Set(inLiveBag.map((r) => r.parcelId));
  return rows
    .filter((r) => !held.has(r.id))
    .map((r) => ({
      id: r.id,
      awb: r.awb,
      status: r.status,
      weightGrams: r.weightGrams,
      destAddress: r.destAddress,
      consigneeName: r.consigneeName,
      updatedAt: r.updatedAt,
    }));
}

/** Counts for the transport dashboard header. */
export async function transportCounts(scope: Principal) {
  const [bagRows, tripRows, exceptions] = await Promise.all([
    db
      .select({ status: bag.status, value: count() })
      .from(bag)
      .where(and(...[bagScope(scope)].filter((f) => f !== undefined)))
      .groupBy(bag.status),
    db
      .select({ status: trip.status, value: count() })
      .from(trip)
      .where(and(...[tripScope(scope)].filter((f) => f !== undefined)))
      .groupBy(trip.status),
    db
      .select({ value: count() })
      .from(custodyException)
      .where(
        and(
          eq(custodyException.status, "open"),
          isGlobalScope(scope.role) ? undefined : eq(custodyException.branchId, scope.branchId),
        ),
      ),
  ]);
  const bagBy = (s: string) => bagRows.find((r) => r.status === s)?.value ?? 0;
  const tripBy = (s: string) => tripRows.find((r) => r.status === s)?.value ?? 0;
  return {
    bagsOpen: bagBy("open"),
    bagsSealed: bagBy("sealed"),
    bagsInTransit: bagBy("in_transit"),
    bagsAwaitingReconciliation: bagBy("received"),
    tripsPlanned: tripBy("planned") + tripBy("loading"),
    tripsInFlight: tripBy("departed"),
    openExceptions: exceptions[0]?.value ?? 0,
  };
}

/** Total bag rows — used by the seed script to stay idempotent. */
export async function bagCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(bag);
  return row?.value ?? 0;
}

export { sql };
