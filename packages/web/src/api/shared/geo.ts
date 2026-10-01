/**
 * Geometry helpers.
 *
 * KNOWN DEVIATION (PROJECT.md §5 mandates PostGIS 3.4 + GiST):
 * SQLite/Turso has no PostGIS, so containment and distance run in JS.
 *   ST_Contains  → bbox pre-filter + ray-casting on an optional polygon ring
 *   <-> / ST_Distance(geography) → Haversine metres
 * Coordinates are stored as integer microdegrees (1e-6 deg) to avoid float
 * drift; these helpers convert at the boundary.
 */

export const E6 = 1_000_000;

export function toE6(deg: number): number {
  return Math.round(deg * E6);
}

export function fromE6(e6: number): number {
  return e6 / E6;
}

export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** Microdegree bbox containment — the ST_Contains pre-filter. */
export function bboxContains(box: BBox, latE6: number, lngE6: number): boolean {
  return (
    latE6 >= box.minLat && latE6 <= box.maxLat && lngE6 >= box.minLng && lngE6 <= box.maxLng
  );
}

/** Ray-casting point-in-polygon on a ring of [latE6, lngE6] pairs. */
export function ringContains(ring: [number, number][], latE6: number, lngE6: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const intersects =
      latI > latE6 !== latJ > latE6 &&
      lngE6 < ((lngJ - lngI) * (latE6 - latI)) / (latJ - latI) + lngI;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function parseRing(json: string | null): [number, number][] | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed as [number, number][];
  } catch {
    return null;
  }
}

/** Haversine distance in metres between two microdegree points. */
export function distanceMetres(
  aLatE6: number,
  aLngE6: number,
  bLatE6: number,
  bLngE6: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(fromE6(aLatE6));
  const lat2 = toRad(fromE6(bLatE6));
  const dLat = lat2 - lat1;
  const dLng = toRad(fromE6(bLngE6) - fromE6(aLngE6));
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Normalised key for the geocode cache — "geocode once, store forever" (§5). */
export function addressKey(address: string): string {
  return address.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
