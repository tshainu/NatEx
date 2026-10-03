import { count, eq } from "drizzle-orm";
import { db } from "../../database";
import { geocodeCache, zone } from "../../database/schema/routing";
import { prefixedId } from "../../shared/ulid";
import { errors } from "../../shared/errors";
import {
  addressKey,
  bboxContains,
  parseRing,
  ringContains,
  toE6,
} from "../../shared/geo";
import { nearestBranch } from "../identity/service";

/**
 * MODULE: routing — serviceability and nearest-branch.
 * The ONLY file that reads routing_* tables (§4).
 *
 * KNOWN DEVIATION (§2, §5 specify PostgreSQL 16 + PostGIS 3.4):
 * There is no PostGIS on the managed stack. `ST_Contains` is approximated by a
 * bounding-box pre-filter followed by a JS ray-casting test against an optional
 * polygon ring, and the `<->` geography operator by Haversine distance. There is
 * no GiST index — the pre-filter scans the zone table, which is fine at pilot
 * scale (tens of zones) and would need revisiting at national scale.
 */

export type ZoneRow = typeof zone.$inferSelect;

export async function listZones(branchId?: string): Promise<ZoneRow[]> {
  if (branchId) return db.select().from(zone).where(eq(zone.branchId, branchId));
  return db.select().from(zone);
}

export interface ServiceabilityResult {
  serviceable: boolean;
  zone: { id: string; name: string; branchId: string } | null;
  nearestBranch: { id: string; code: string; name: string; distanceMetres: number } | null;
  /** How the answer was reached — surfaced so the approximation is never invisible. */
  method: "ring" | "bbox" | "none";
  reason: string;
}

/**
 * Point-in-zone containment. Two-stage, exactly as a PostGIS query would be
 * planned (index pre-filter, then exact test) minus the spatial index:
 *   1 bbox containment rejects almost every zone cheaply
 *   2 if the surviving zone carries a polygon ring, ray-cast against it
 */
export async function checkServiceability(params: {
  lat: number;
  lng: number;
}): Promise<ServiceabilityResult> {
  const latE6 = toE6(params.lat);
  const lngE6 = toE6(params.lng);
  const zones = await db.select().from(zone);

  for (const z of zones) {
    const inBox = bboxContains(
      { minLat: z.minLat, minLng: z.minLng, maxLat: z.maxLat, maxLng: z.maxLng },
      latE6,
      lngE6,
    );
    if (!inBox) continue;

    const ring = parseRing(z.ring);
    if (ring && !ringContains(ring, latE6, lngE6)) continue;

    // identity.nearestBranch returns the ranked wrapper { branch, metres }.
    const ranked = await nearestBranch(latE6, lngE6);
    return {
      serviceable: z.serviceable,
      zone: { id: z.id, name: z.name, branchId: z.branchId },
      nearestBranch: ranked
        ? {
            id: ranked.branch.id,
            code: ranked.branch.code,
            name: ranked.branch.name,
            distanceMetres: Math.round(ranked.metres),
          }
        : null,
      method: ring ? "ring" : "bbox",
      reason: z.serviceable
        ? `Inside zone ${z.name}.`
        : `Inside zone ${z.name}, which is marked not serviceable.`,
    };
  }

  const ranked = await nearestBranch(latE6, lngE6);
  return {
    serviceable: false,
    zone: null,
    nearestBranch: ranked
      ? {
          id: ranked.branch.id,
          code: ranked.branch.code,
          name: ranked.branch.name,
          distanceMetres: Math.round(ranked.metres),
        }
      : null,
    method: "none",
    reason: "This location is outside every configured serviceability zone.",
  };
}

/** Nearest branch by Haversine — the `<->` geography operator's stand-in. */
export async function findNearestBranch(params: { lat: number; lng: number }) {
  const latE6 = toE6(params.lat);
  const lngE6 = toE6(params.lng);
  // identity.nearestBranch returns the ranked wrapper { branch, metres } —
  // the distance is already computed there, so it is not recomputed here.
  const ranked = await nearestBranch(latE6, lngE6);
  if (!ranked) errors.notFound("Branch");
  const { branch: row, metres } = ranked!;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    type: row.type,
    distanceMetres: Math.round(metres),
    distanceKm: Math.round(metres / 10) / 100,
  };
}

/**
 * Geocode-once cache (§5: "the same address is never sent to Google Maps
 * twice"). No Maps key is configured in M1, so a cache miss returns null rather
 * than calling out — the caller decides whether to proceed without coordinates.
 */
export async function lookupGeocode(address: string) {
  const key = addressKey(address);
  const [hit] = await db
    .select()
    .from(geocodeCache)
    .where(eq(geocodeCache.addressKey, key));
  return hit ?? null;
}

export async function cacheGeocode(params: {
  address: string;
  latE6: number;
  lngE6: number;
  provider?: string;
}) {
  await db
    .insert(geocodeCache)
    .values({
      addressKey: addressKey(params.address),
      address: params.address,
      lat: params.latE6,
      lng: params.lngE6,
      provider: params.provider ?? "manual",
    })
    .onConflictDoNothing();
}

export async function createZone(input: {
  name: string;
  branchId: string;
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  ring?: [number, number][] | null;
  serviceable: boolean;
}): Promise<ZoneRow> {
  const [row] = await db
    .insert(zone)
    .values({
      id: prefixedId("zon"),
      name: input.name,
      branchId: input.branchId,
      minLat: toE6(input.minLat),
      minLng: toE6(input.minLng),
      maxLat: toE6(input.maxLat),
      maxLng: toE6(input.maxLng),
      ring: input.ring ? JSON.stringify(input.ring) : null,
      serviceable: input.serviceable,
    })
    .returning();
  return row!;
}

/**
 * Edit a zone (§10 M5 admin portal). Coordinates arrive in degrees and are
 * stored as microdegrees, like createZone. A box whose min is not below its max
 * is refused rather than stored as a zone that contains nothing.
 */
export async function updateZone(
  id: string,
  patch: {
    name?: string;
    branchId?: string;
    minLat?: number;
    minLng?: number;
    maxLat?: number;
    maxLng?: number;
    serviceable?: boolean;
  },
): Promise<{ before: ZoneRow; after: ZoneRow }> {
  const [before] = await db.select().from(zone).where(eq(zone.id, id));
  if (!before) errors.notFound("Zone");
  const next: Partial<typeof zone.$inferInsert> = {};
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.branchId !== undefined) next.branchId = patch.branchId;
  if (patch.minLat !== undefined) next.minLat = toE6(patch.minLat);
  if (patch.minLng !== undefined) next.minLng = toE6(patch.minLng);
  if (patch.maxLat !== undefined) next.maxLat = toE6(patch.maxLat);
  if (patch.maxLng !== undefined) next.maxLng = toE6(patch.maxLng);
  if (patch.serviceable !== undefined) next.serviceable = patch.serviceable;
  const merged = { ...before!, ...next };
  if (merged.minLat >= merged.maxLat || merged.minLng >= merged.maxLng) {
    errors.badRequest("The zone's minimum latitude and longitude must be below its maximum.");
  }
  if (Object.keys(next).length === 0) return { before: before!, after: before! };
  const [after] = await db.update(zone).set(next).where(eq(zone.id, id)).returning();
  return { before: before!, after: after! };
}

export async function zoneCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(zone);
  return row?.value ?? 0;
}
