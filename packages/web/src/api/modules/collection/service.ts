import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import { manifest, manifestItem } from "../../database/schema/collection";
import { prefixedId } from "../../shared/ulid";
import { errors } from "../../shared/errors";
import { enqueue } from "../../shared/outbox";
import { isGlobalScope, type Principal } from "../../shared/auth";
import { colomboToday } from "../../shared/time";
import { assertRequestSchedulable, markRequestScheduled } from "./pickups";
import { getMerchant } from "../merchants/service";
import {
  getParcelByAwb,
  parcelsByIds,
  transitionParcel,
  type ParcelRow,
} from "../parcels/service";

/**
 * MODULE: collection — pickup requests, manifests, two-party handover.
 * This module's files (this one and pickups.ts) are the ONLY readers of
 * collection_* tables (§4).
 *
 * Note the module boundary: this file never SELECTs from parcels_* or
 * merchants_*. It calls those modules' services (getParcelByAwb, parcelsByIds,
 * transitionParcel, getMerchant) exactly as §4 requires.
 */

export type ManifestRow = typeof manifest.$inferSelect;
export type ManifestItemRow = typeof manifestItem.$inferSelect;

/**
 * Asia/Colombo calendar date (§9: all dates are Asia/Colombo, never UTC).
 * The implementation moved to shared/time.ts when the delivery module needed
 * it too; re-exported here so existing callers keep working.
 */
export { colomboToday };

function nextManifestCode(pickupDate: string): string {
  const compact = pickupDate.replaceAll("-", "").slice(2);
  const suffix = Math.floor(Math.random() * 9000 + 1000).toString();
  return `MF${compact}-${suffix}`;
}

function assertManifestVisible(row: ManifestRow, scope: Principal): void {
  if (isGlobalScope(scope.role)) return;
  if (scope.role === "rider") {
    if (row.riderId !== scope.userId) {
      errors.forbidden("This manifest is assigned to another rider.");
    }
    return;
  }
  if (scope.role === "merchant") {
    if (row.merchantId !== scope.merchantId) errors.notFound("Manifest");
    return;
  }
  if (row.branchId !== scope.branchId) {
    errors.forbidden("This manifest belongs to another branch.");
  }
}

// ------------------------------------------------------------------ read paths

export async function getManifest(id: string): Promise<ManifestRow | null> {
  const [row] = await db.select().from(manifest).where(eq(manifest.id, id));
  return row ?? null;
}

export interface ManifestDetail {
  manifest: ManifestRow;
  merchantName: string;
  items: (ManifestItemRow & {
    status: string | null;
    consigneeName: string | null;
    codAmountCents: number | null;
  })[];
}

export async function getManifestDetail(
  id: string,
  scope: Principal,
): Promise<ManifestDetail> {
  const row = await getManifest(id);
  if (!row) errors.notFound("Manifest");
  assertManifestVisible(row!, scope);

  const items = await db
    .select()
    .from(manifestItem)
    .where(eq(manifestItem.manifestId, id));

  // Cross-module read goes through the parcels service, not its tables.
  const parcels = await parcelsByIds(items.map((i) => i.parcelId));
  const byId = new Map<string, ParcelRow>(parcels.map((p) => [p.id, p]));
  const merchant = await getMerchant(row!.merchantId);

  return {
    manifest: row!,
    merchantName: merchant?.name ?? "Unknown merchant",
    items: items.map((i) => ({
      ...i,
      status: byId.get(i.parcelId)?.status ?? null,
      consigneeName: byId.get(i.parcelId)?.consigneeName ?? null,
      codAmountCents: byId.get(i.parcelId)?.codAmountCents ?? null,
    })),
  };
}

export async function listManifests(
  input: { page: number; pageSize: number; pickupDate?: string; riderId?: string; merchantId?: string },
  scope: Principal,
) {
  const filters = [];
  if (scope.role === "merchant" && input.merchantId && input.merchantId !== scope.merchantId) {
    // §5: refused, never silently re-scoped.
    errors.forbidden("A merchant may only read its own pickup manifests.", { merchantId: input.merchantId });
  }
  if (!isGlobalScope(scope.role)) {
    if (scope.role === "rider") filters.push(eq(manifest.riderId, scope.userId));
    else if (scope.role === "merchant") {
      filters.push(eq(manifest.merchantId, scope.merchantId ?? "__none__"));
    } else filters.push(eq(manifest.branchId, scope.branchId));
  }
  if (input.merchantId) filters.push(eq(manifest.merchantId, input.merchantId));
  if (input.pickupDate) filters.push(eq(manifest.pickupDate, input.pickupDate));
  if (input.riderId) filters.push(eq(manifest.riderId, input.riderId));

  const where = filters.length ? and(...filters) : undefined;
  const pageSize = Math.min(Math.max(input.pageSize, 1), 100);
  const offset = (Math.max(input.page, 1) - 1) * pageSize;

  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(manifest)
      .where(where)
      .orderBy(desc(manifest.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ value: count() }).from(manifest).where(where),
  ]);

  const merchantNames = new Map<string, string>();
  for (const r of rows) {
    if (!merchantNames.has(r.merchantId)) {
      merchantNames.set(r.merchantId, (await getMerchant(r.merchantId))?.name ?? "—");
    }
  }

  return {
    rows: rows.map((r) => ({ ...r, merchantName: merchantNames.get(r.merchantId) ?? "—" })),
    total: total?.value ?? 0,
    page: Math.max(input.page, 1),
    pageSize,
  };
}

/** The rider app's home screen: today's assigned pickups. */
export async function riderToday(scope: Principal, pickupDate?: string) {
  const date = pickupDate ?? colomboToday();
  const rows = await db
    .select()
    .from(manifest)
    .where(and(eq(manifest.riderId, scope.userId), eq(manifest.pickupDate, date)))
    .orderBy(desc(manifest.createdAt));

  const out = [];
  for (const row of rows) {
    const merchant = await getMerchant(row.merchantId);
    out.push({
      ...row,
      merchantName: merchant?.name ?? "Unknown merchant",
      merchantAddress: merchant?.address ?? "",
      merchantPhone: merchant?.contactPhone ?? "",
      codEnabled: merchant?.codEnabled ?? false,
    });
  }

  return {
    pickupDate: date,
    manifests: out,
    totals: {
      manifests: out.length,
      expected: out.reduce((n, m) => n + m.expectedCount, 0),
      scanned: out.reduce((n, m) => n + m.scannedCount, 0),
      pending: out.filter((m) => m.status !== "handed_over").length,
    },
  };
}

// ----------------------------------------------------------------- write paths

export interface CreateManifestInput {
  merchantId: string;
  riderId: string;
  pickupDate: string;
  /** AWBs the merchant declared for this pickup. */
  awbs: string[];
  /** The merchant's pickup request this manifest answers, if any. */
  pickupRequestId?: string | null;
}

export async function createManifest(
  input: CreateManifestInput,
  actor: Principal,
): Promise<ManifestDetail> {
  const merchant = await getMerchant(input.merchantId);
  if (!merchant) errors.notFound("Merchant");
  if (!isGlobalScope(actor.role) && merchant!.branchId !== actor.branchId) {
    errors.forbidden("This merchant belongs to another branch.");
  }
  if (input.pickupRequestId) {
    await assertRequestSchedulable(input.pickupRequestId, input.merchantId, actor);
  }

  const resolved: { parcelId: string; awb: string }[] = [];
  for (const awb of input.awbs) {
    const p = await getParcelByAwb(awb);
    if (!p) errors.notFound(`Parcel ${awb}`);
    if (p!.merchantId !== input.merchantId) {
      errors.badRequest(`Parcel ${p!.awb} does not belong to this merchant.`, {
        awb: p!.awb,
      });
    }
    if (p!.status !== "Booked") {
      errors.badRequest(
        `Parcel ${p!.awb} is ${p!.status} and cannot be added to a pickup manifest.`,
        { awb: p!.awb, currentStatus: p!.status },
      );
    }
    resolved.push({ parcelId: p!.id, awb: p!.awb });
  }

  const id = prefixedId("mfs");
  await db.insert(manifest).values({
    id,
    code: nextManifestCode(input.pickupDate),
    merchantId: input.merchantId,
    branchId: merchant!.branchId,
    riderId: input.riderId,
    pickupDate: input.pickupDate,
    status: "assigned",
    expectedCount: resolved.length,
    scannedCount: 0,
  });

  if (resolved.length) {
    await db.insert(manifestItem).values(
      resolved.map((r) => ({
        id: prefixedId("mfi"),
        manifestId: id,
        parcelId: r.parcelId,
        awb: r.awb,
      })),
    );
  }
  if (input.pickupRequestId) await markRequestScheduled(input.pickupRequestId, id);

  return getManifestDetail(id, actor);
}

export interface ScanItemResult {
  manifest: ManifestRow;
  item: ManifestItemRow;
  /** True when this AWB was already scanned on this manifest. */
  alreadyScanned: boolean;
}

/**
 * Rider scans a parcel at the merchant's counter. The scan records presence on
 * the manifest; custody does not move until handover, which is the point of the
 * two-party handover rule (§5) — a scan is not a transfer.
 */
export async function scanItem(
  input: { manifestId: string; awb: string },
  actor: Principal,
): Promise<ScanItemResult> {
  const row = await getManifest(input.manifestId);
  if (!row) errors.notFound("Manifest");
  assertManifestVisible(row!, actor);
  if (row!.status === "handed_over") {
    errors.conflict(`Manifest ${row!.code} is already handed over.`, { code: row!.code });
  }
  if (row!.status === "cancelled") {
    errors.conflict(`Manifest ${row!.code} is cancelled.`, { code: row!.code });
  }

  const awb = input.awb.trim().toUpperCase();
  const [item] = await db
    .select()
    .from(manifestItem)
    .where(and(eq(manifestItem.manifestId, input.manifestId), eq(manifestItem.awb, awb)));

  if (!item) {
    errors.badRequest(`AWB ${awb} is not on manifest ${row!.code}.`, {
      awb,
      manifestCode: row!.code,
    });
  }
  if (item!.scannedAt) {
    return { manifest: row!, item: item!, alreadyScanned: true };
  }

  const [updatedItem] = await db
    .update(manifestItem)
    .set({ scannedAt: new Date(), scannedBy: actor.userId })
    .where(eq(manifestItem.id, item!.id))
    .returning();

  const allItems = await db
    .select()
    .from(manifestItem)
    .where(eq(manifestItem.manifestId, input.manifestId));
  const scannedCount = allItems.filter((i) => i.scannedAt !== null).length;

  const [updatedManifest] = await db
    .update(manifest)
    .set({ scannedCount, status: "in_progress" })
    .where(eq(manifest.id, input.manifestId))
    .returning();

  return { manifest: updatedManifest!, item: updatedItem!, alreadyScanned: false };
}

export interface HandoverResult {
  manifest: ManifestRow;
  movedAwbs: string[];
  rejected: { awb: string; reason: string }[];
  /** Declared but never scanned — the shortfall the merchant must be shown. */
  missingAwbs: string[];
}

/**
 * Two-party handover (§5): the merchant's representative releases, the rider
 * receives. Only scanned items move to PickedUp; a declared-but-unscanned parcel
 * stays Booked and is reported as a shortfall rather than silently assumed.
 */
export async function handoverManifest(
  input: {
    manifestId: string;
    /** Who released the parcels on the merchant's side. */
    handoverByName: string;
    /** Storage key of the captured signature, if any. */
    signatureUrl?: string | null;
    lat?: number | null;
    lng?: number | null;
  },
  actor: Principal,
): Promise<HandoverResult> {
  const row = await getManifest(input.manifestId);
  if (!row) errors.notFound("Manifest");
  assertManifestVisible(row!, actor);
  if (row!.status === "handed_over") {
    errors.conflict(`Manifest ${row!.code} is already handed over.`, { code: row!.code });
  }

  const items = await db
    .select()
    .from(manifestItem)
    .where(eq(manifestItem.manifestId, input.manifestId));

  const scanned = items.filter((i) => i.scannedAt !== null);
  if (scanned.length === 0) {
    errors.badRequest("Nothing has been scanned on this manifest yet.", {
      manifestCode: row!.code,
    });
  }

  const movedAwbs: string[] = [];
  const rejected: { awb: string; reason: string }[] = [];

  for (const item of scanned) {
    try {
      // Custody moves only here, and only through the parcels choke point.
      await transitionParcel(
        {
          awbOrId: item.parcelId,
          to: "PickedUp",
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          notes: `Collected on manifest ${row!.code}, released by ${input.handoverByName}.`,
          clientId: `handover:${row!.id}:${item.parcelId}`,
        },
        actor,
      );
      movedAwbs.push(item.awb);
    } catch (err) {
      rejected.push({
        awb: item.awb,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const [updated] = await db
    .update(manifest)
    .set({
      status: "handed_over",
      handedOverAt: new Date(),
      handoverByName: input.handoverByName,
      signatureUrl: input.signatureUrl ?? null,
      scannedCount: scanned.length,
    })
    .where(eq(manifest.id, input.manifestId))
    .returning();

  await enqueue("manifest.handed_over", {
    manifestId: row!.id,
    code: row!.code,
    merchantId: row!.merchantId,
    movedCount: movedAwbs.length,
  });

  return {
    manifest: updated!,
    movedAwbs,
    rejected,
    missingAwbs: items.filter((i) => i.scannedAt === null).map((i) => i.awb),
  };
}

/** Ops-side hub receipt: parcels a rider brings in move PickedUp → AtOriginHub. */
export async function scanIntoHub(
  input: { awbs: string[]; lat?: number | null; lng?: number | null },
  actor: Principal,
) {
  const received: string[] = [];
  const rejected: { awb: string; reason: string }[] = [];

  for (const awb of input.awbs) {
    try {
      const result = await transitionParcel(
        {
          awbOrId: awb,
          to: "AtOriginHub",
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          notes: "Received at origin hub.",
        },
        actor,
      );
      received.push(result.parcel.awb);
    } catch (err) {
      rejected.push({
        awb,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }
  return { received, rejected };
}

export async function manifestCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(manifest);
  return row?.value ?? 0;
}

/** Seed-only: build a manifest around already-existing parcels. */
export async function seedManifest(input: {
  id: string;
  code: string;
  merchantId: string;
  branchId: string;
  riderId: string;
  pickupDate: string;
  status: string;
  items: { parcelId: string; awb: string; scannedAt: Date | null }[];
}) {
  await db.insert(manifest).values({
    id: input.id,
    code: input.code,
    merchantId: input.merchantId,
    branchId: input.branchId,
    riderId: input.riderId,
    pickupDate: input.pickupDate,
    status: input.status,
    expectedCount: input.items.length,
    scannedCount: input.items.filter((i) => i.scannedAt !== null).length,
  });
  if (input.items.length) {
    await db.insert(manifestItem).values(
      input.items.map((i) => ({
        id: prefixedId("mfi"),
        manifestId: input.id,
        parcelId: i.parcelId,
        awb: i.awb,
        scannedAt: i.scannedAt,
      })),
    );
  }
}

export { inArray };
