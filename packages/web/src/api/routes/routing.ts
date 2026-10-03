import { z } from "zod";
import { adminProc, mutate, staffProc } from "../middleware/pipeline";
import { getBranch } from "../modules/identity/service";
import * as routingService from "../modules/routing/service";
import { errors } from "../shared/errors";

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

export const updateZone = adminProc
  .input(
    z.object({
      id: z.string().min(1),
      name: z.string().min(2).max(120).optional(),
      branchId: z.string().min(1).optional(),
      minLat: z.number().min(-90).max(90).optional(),
      minLng: z.number().min(-180).max(180).optional(),
      maxLat: z.number().min(-90).max(90).optional(),
      maxLng: z.number().min(-180).max(180).optional(),
      serviceable: z.boolean().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const { id, ...patch } = input;
    if (patch.branchId && !(await getBranch(patch.branchId))) {
      errors.badRequest(`Branch ${patch.branchId} does not exist.`);
    }
    return mutate(
      context,
      input,
      { route: "routing.updateZone", entity: "routing_zone", entityId: () => id, action: "zone.updated" },
      () => routingService.updateZone(id, patch),
    );
  });

/** Router namespace — composed into the root router in api/index.ts. */
export const routing = {
  checkServiceability,
  nearestBranch,
  listZones,
  createZone,
  updateZone,
};
