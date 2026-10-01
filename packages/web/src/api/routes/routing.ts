import { z } from "zod";
import { adminProc, mutate, staffProc } from "../middleware/pipeline";
import * as routingService from "../modules/routing/service";

/**
 * routing routes — serviceability and nearest branch.
 * Every response carries the `method` field so the PostGIS approximation
 * (bbox + ray-cast instead of ST_Contains) is visible to the caller, not hidden.
 */

export const checkServiceability = staffProc
  .input(
    z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
  )
  .handler(({ input }) => routingService.checkServiceability(input));

export const nearestBranch = staffProc
  .input(
    z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
  )
  .handler(({ input }) => routingService.findNearestBranch(input));

export const listZones = staffProc
  .input(z.object({ branchId: z.string().optional() }))
  .handler(({ input }) => routingService.listZones(input.branchId));

export const createZone = adminProc
  .input(
    z.object({
      name: z.string().min(2).max(120),
      branchId: z.string().min(1),
      minLat: z.number().min(-90).max(90),
      minLng: z.number().min(-180).max(180),
      maxLat: z.number().min(-90).max(90),
      maxLng: z.number().min(-180).max(180),
      serviceable: z.boolean().default(true),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "routing.createZone",
        entity: "routing_zone",
        entityId: (r) => (r as routingService.ZoneRow).id,
        action: "zone.created",
      },
      () => routingService.createZone({ ...input, ring: null }),
    ),
  );

/** Router namespace — composed into the root router in api/index.ts. */
export const routing = {
  checkServiceability,
  nearestBranch,
  listZones,
  createZone,
};
