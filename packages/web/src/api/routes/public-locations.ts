import type { Hono } from "hono";
import { toPublicLocations, type BranchLocationSource } from "../shared/public-locations";

/** Register the public, read-only location feed used by the NatEx company website. */
export function registerPublicLocationsRoute(
  app: Hono,
  loadBranches: () => Promise<readonly BranchLocationSource[]>,
): void {
  app.get("/api/public/locations", async (c) => {
    const branches = await loadBranches();
    return c.json(
      { locations: toPublicLocations(branches) },
      200,
      { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" },
    );
  });
}

export const publicLocations = registerPublicLocationsRoute;
