import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../database";
import { manifest, manifestItem, pickupRequest } from "../../database/schema/collection";
import { prefixedId } from "../../shared/ulid";
import { insertWithFreshCode, mintDocumentCode } from "../../shared/codes";
import { errors } from "../../shared/errors";
import { isGlobalScope, type Principal } from "../../shared/auth";
import { addDays, colomboToday } from "../../shared/time";
import { getMerchant } from "../merchants/service";
import { getParcelByAwb } from "../parcels/service";

/**
 * MODULE: collection — merchant pickup requests (§10 M3 merchant portal).
 *
 * Part of the collection module, so it reads collection_* tables directly; it
 * reaches parcels and merchants only through their services (§4).
 *
 * A request is the merchant's half of a pickup: "come on this date, in this
 * window, for these Booked parcels". Ops answers by building a manifest from
 * it (`createManifest({ pickupRequestId })`), which links the two and moves the
 * request to `scheduled`. A request never moves custody.
 */

export type PickupRequestRow = typeof pickupRequest.$inferSelect;
export type PickupWindow = "morning" | "afternoon";
export type PickupRequestStatus = "requested" | "scheduled" | "cancelled";

/** How far ahead a merchant may book a pickup slot. */
export const PICKUP_HORIZON_DAYS = 14;

function nextRequestCode(pickupDate: string): string {
  return mintDocumentCode("PR", pickupDate);
}

function parseAwbs(row: PickupRequestRow): string[] {
  try {
    const v = JSON.parse(row.awbs) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function assertRequestVisible(row: PickupRequestRow, scope: Principal): void {
  if (isGlobalScope(scope.role)) return;
  if (scope.role === "merchant") {
    // Another merchant's request is indistinguishable from no request (§5).
    if (row.merchantId !== scope.merchantId) errors.notFound("Pickup request");
    return;
  }
  if (row.branchId !== scope.branchId) {
    errors.forbidden("This pickup request belongs to another branch.");
  }
}

async function getRequest(id: string): Promise<PickupRequestRow | null> {
  const [row] = await db.select().from(pickupRequest).where(eq(pickupRequest.id, id));
  return row ?? null;
}

export interface PickupRequestView extends Omit<PickupRequestRow, "awbs"> {
  awbs: string[];
  merchantName: string;
  manifestCode: string | null;
}

async function toView(rows: PickupRequestRow[]): Promise<PickupRequestView[]> {
  const names = new Map<string, string>();
  for (const r of rows) {
    if (!names.has(r.merchantId)) names.set(r.merchantId, (await getMerchant(r.merchantId))?.name ?? "—");
  }
  const manifestIds = rows.map((r) => r.manifestId).filter((x): x is string => !!x);
  const codes = new Map<string, string>();
  if (manifestIds.length) {
    for (const m of await db
      .select({ id: manifest.id, code: manifest.code })
      .from(manifest)
      .where(inArray(manifest.id, manifestIds))) {
      codes.set(m.id, m.code);
    }
  }
  return rows.map((r) => ({
    ...r,
    awbs: parseAwbs(r),
    merchantName: names.get(r.merchantId) ?? "—",
    manifestCode: r.manifestId ? (codes.get(r.manifestId) ?? null) : null,
  }));
}

export async function getPickupRequest(id: string, scope: Principal): Promise<PickupRequestView> {
  const row = await getRequest(id);
  if (!row) errors.notFound("Pickup request");
  assertRequestVisible(row!, scope);
  return (await toView([row!]))[0]!;
}

function scopeFilters(
  input: { merchantId?: string },
  scope: Principal,
) {
  const filters = [];
  if (scope.role === "merchant") {
    // §5: naming another merchant is refused, never silently re-scoped.
    if (input.merchantId && input.merchantId !== scope.merchantId) {
      errors.forbidden("A merchant may only read its own pickup requests.", {
        merchantId: input.merchantId,
      });
    }
    filters.push(eq(pickupRequest.merchantId, scope.merchantId ?? "__none__"));
  } else {
    if (!isGlobalScope(scope.role)) filters.push(eq(pickupRequest.branchId, scope.branchId));
    if (input.merchantId) filters.push(eq(pickupRequest.merchantId, input.merchantId));
  }
  return filters;
}

export async function listPickupRequests(
  input: {
    page: number;
    pageSize: number;
    status?: PickupRequestStatus[];
    merchantId?: string;
    pickupDate?: string;
  },
  scope: Principal,
) {
  const filters = scopeFilters(input, scope);
  if (input.status?.length) filters.push(inArray(pickupRequest.status, input.status));
  if (input.pickupDate) filters.push(eq(pickupRequest.pickupDate, input.pickupDate));
  const where = filters.length ? and(...filters) : undefined;
  const pageSize = Math.min(Math.max(input.pageSize, 1), 100);
  const page = Math.max(input.page, 1);

  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(pickupRequest)
      .where(where)
      .orderBy(desc(pickupRequest.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(pickupRequest).where(where),
  ]);
  return { rows: await toView(rows), total: total?.value ?? 0, page, pageSize };
}

export async function pickupRequestCounts(input: { merchantId?: string }, scope: Principal) {
  const filters = scopeFilters(input, scope);
  const rows = await db
    .select({ status: pickupRequest.status, value: count() })
    .from(pickupRequest)
    .where(filters.length ? and(...filters) : undefined)
    .groupBy(pickupRequest.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.value])) as Record<string, number>;
  return {
    requested: by.requested ?? 0,
    scheduled: by.scheduled ?? 0,
    cancelled: by.cancelled ?? 0,
  };
}

/** AWBs already promised to a live request or a live manifest. */
async function awbsAlreadyCommitted(merchantId: string): Promise<Map<string, string>> {
  const taken = new Map<string, string>();
  const open = await db
    .select()
    .from(pickupRequest)
    .where(and(eq(pickupRequest.merchantId, merchantId), eq(pickupRequest.status, "requested")));
  for (const r of open) for (const a of parseAwbs(r)) taken.set(a, `pickup request ${r.code}`);
  const onManifests = await db
    .select({ awb: manifestItem.awb, code: manifest.code })
    .from(manifestItem)
    .innerJoin(manifest, eq(manifest.id, manifestItem.manifestId))
    .where(and(eq(manifest.merchantId, merchantId), ne(manifest.status, "cancelled")));
  for (const m of onManifests) taken.set(m.awb, `manifest ${m.code}`);
  return taken;
}

export interface RequestPickupInput {
  merchantId: string;
  pickupDate: string;
  window: PickupWindow;
  awbs: string[];
  notes?: string | null;
}

export async function requestPickup(input: RequestPickupInput, actor: Principal): Promise<PickupRequestView> {
  if (actor.role === "merchant" && input.merchantId !== actor.merchantId) {
    errors.forbidden("A merchant may only request pickups for its own account.", {
      merchantId: input.merchantId,
    });
  }
  const owner = await getMerchant(input.merchantId);
  if (!owner) errors.notFound(`Merchant ${input.merchantId}`);
  if (!isGlobalScope(actor.role) && actor.role !== "merchant" && owner!.branchId !== actor.branchId) {
    errors.forbidden("This merchant belongs to another branch.");
  }
  if (owner!.status !== "active") {
    errors.conflict(`Merchant ${owner!.name} is ${owner!.status} and cannot request pickups.`, {
      merchantStatus: owner!.status,
    });
  }

  const today = colomboToday();
  const latest = addDays(today, PICKUP_HORIZON_DAYS);
  if (input.pickupDate < today) {
    errors.badRequest(`Pickup date ${input.pickupDate} is in the past (today is ${today}).`, { today });
  }
  if (input.pickupDate > latest) {
    errors.badRequest(`Pickups can be booked at most ${PICKUP_HORIZON_DAYS} days ahead (latest ${latest}).`, {
      latest,
    });
  }

  const awbs = [...new Set(input.awbs.map((a) => a.trim().toUpperCase()).filter(Boolean))];
  if (awbs.length === 0) errors.badRequest("Name at least one parcel for the rider to collect.");

  const taken = await awbsAlreadyCommitted(input.merchantId);
  const problems: { awb: string; reason: string }[] = [];
  for (const awb of awbs) {
    const p = await getParcelByAwb(awb);
    // Another merchant's AWB reads exactly like a missing one (§5).
    if (!p || p.merchantId !== input.merchantId) problems.push({ awb, reason: "not found on this account" });
    else if (p.status !== "Booked") problems.push({ awb, reason: `already ${p.status}` });
    else if (taken.has(awb)) problems.push({ awb, reason: `already on ${taken.get(awb)}` });
  }
  if (problems.length) {
    errors.badRequest(
      `${problems.length} of ${awbs.length} parcel(s) cannot go on this pickup: ${problems
        .slice(0, 3)
        .map((p) => `${p.awb} ${p.reason}`)
        .join("; ")}${problems.length > 3 ? "; …" : ""}.`,
      { problems },
    );
  }

  const id = prefixedId("pkr");
  await insertWithFreshCode("collection_pickup_request", () => nextRequestCode(input.pickupDate), (code) => db.insert(pickupRequest).values({
    id,
    code,
    merchantId: input.merchantId,
    branchId: owner!.branchId,
    pickupDate: input.pickupDate,
    window: input.window,
    awbs: JSON.stringify(awbs),
    parcelCount: awbs.length,
    notes: input.notes?.trim() || null,
    status: "requested",
    requestedBy: actor.userId,
  }));
  return getPickupRequest(id, actor);
}

export async function cancelPickupRequest(
  input: { id: string; reason: string },
  actor: Principal,
): Promise<PickupRequestView> {
  const row = await getRequest(input.id);
  if (!row) errors.notFound("Pickup request");
  assertRequestVisible(row!, actor);
  if (row!.status !== "requested") {
    errors.conflict(
      `Pickup request ${row!.code} is ${row!.status}${
        row!.status === "scheduled" ? " — a rider is already assigned; ask NatEx operations to cancel the manifest" : ""
      }.`,
      { currentStatus: row!.status },
    );
  }
  await db
    .update(pickupRequest)
    .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: input.reason.trim() })
    .where(and(eq(pickupRequest.id, row!.id), eq(pickupRequest.status, "requested")));
  return getPickupRequest(row!.id, actor);
}

/**
 * Called by `createManifest` when ops builds a manifest from a request: checks
 * the request is still live and belongs to the same merchant, so a stale or
 * mismatched link is refused before the manifest exists.
 */
export async function assertRequestSchedulable(
  id: string,
  merchantId: string,
  actor: Principal,
): Promise<PickupRequestRow> {
  const row = await getRequest(id);
  if (!row) errors.notFound("Pickup request");
  assertRequestVisible(row!, actor);
  if (row!.status !== "requested") {
    errors.conflict(`Pickup request ${row!.code} is already ${row!.status}.`, { currentStatus: row!.status });
  }
  if (row!.merchantId !== merchantId) {
    errors.badRequest(`Pickup request ${row!.code} is for another merchant.`);
  }
  return row!;
}

export async function markRequestScheduled(id: string, manifestId: string): Promise<void> {
  await db
    .update(pickupRequest)
    .set({ status: "scheduled", manifestId })
    .where(and(eq(pickupRequest.id, id), eq(pickupRequest.status, "requested")));
}
