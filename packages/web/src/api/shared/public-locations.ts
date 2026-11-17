export interface BranchLocationSource {
  code: string;
  name: string;
  address: string;
  type: string;
  status: string;
  lat: number | null;
  lng: number | null;
  id?: string;
  phone?: string | null;
  counterRateCardId?: string | null;
}

/** Whitelist the location data intended for the public NatEx company website. */
export function toPublicLocations(rows: readonly BranchLocationSource[]) {
  return rows
    .filter((row) => row.status === "active")
    .map(({ code, name, address, type, lat, lng }) => ({
      code,
      name,
      address,
      type: type === "hub" ? "hub" as const : "branch" as const,
      latitude: lat === null ? null : lat / 1_000_000,
      longitude: lng === null ? null : lng / 1_000_000,
    }));
}
