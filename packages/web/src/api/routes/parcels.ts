import { z } from "zod";
import {
  authedProc,
  mutate,
  opsProc,
  publicProc,
  publicRead,
  readProc,
} from "../middleware/pipeline";
import * as parcelsService from "../modules/parcels/service";
import { BULK_ROW_LIMIT, bulkCreateParcels, type BulkReport } from "../modules/parcels/bulk";
import {
  ENABLED_STATUSES,
  EXPOSED_MILESTONE,
  SHIPPED_MILESTONE,
  PARCEL_STATUSES,
  TRANSITIONS,
  TRANSITION_ROLES,
  type ParcelStatus,
} from "../modules/parcels/state-machine";
import { errors } from "../shared/errors";
import { isGlobalScope } from "../shared/auth";

const statusEnum = z.enum(PARCEL_STATUSES as unknown as [string, ...string[]]);

/** Only the transitions this milestone exposes are accepted at the edge (§10). */
const enabledStatusEnum = z.enum(ENABLED_STATUSES as unknown as [string, ...string[]]);

export const list = readProc
  .input(
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      status: z.array(statusEnum).optional(),
      merchantId: z.string().optional(),
      branchId: z.string().optional(),
      search: z.string().max(60).optional(),
    }),
  )
  .handler(({ input, context }) =>
    parcelsService.listParcels(
      {
        page: input.page,
        pageSize: input.pageSize,
        status: input.status as ParcelStatus[] | undefined,
        merchantId: input.merchantId,
        branchId: input.branchId,
        search: input.search,
      },
      context.principal,
    ),
  );

export const get = readProc
  .input(z.object({ awbOrId: z.string().min(3) }))
  .handler(({ input, context }) =>
    parcelsService.getParcelDetail(input.awbOrId, context.principal),
  );

export const board = readProc.handler(async ({ context }) => {
  const [counts, events] = await Promise.all([
    parcelsService.statusCounts(context.principal),
    parcelsService.recentEvents(context.principal, 25),
  ]);
  return { counts, events, generatedAt: new Date().toISOString() };
});

/** Dashboard tallies, aggregated in SQL under the caller's §5 scope. */
export const summary = readProc.handler(({ context }) => parcelsService.parcelSummary(context.principal));

/**
 * Daily throughput (booked, delivered, failed attempts, RTO) for the dashboard
 * charts — same §5 scope as `summary`: a merchant its own account, ops its
 * branch, admin and finance the network.
 */
export const trends = readProc
  .input(z.object({ days: z.number().int().min(7).max(90).default(30) }))
  .handler(({ input, context }) => parcelsService.parcelTrends(context.principal, input.days));

export const create = authedProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      branchId: z.string().min(1).optional(),
      weightGrams: z.number().int().min(1).max(200_000),
      lengthCm: z.number().int().min(1).max(500).nullish(),
      widthCm: z.number().int().min(1).max(500).nullish(),
      heightCm: z.number().int().min(1).max(500).nullish(),
      /** MONEY: integer cents. The API refuses anything else (§9). */
      declaredValueCents: z.number().int().min(0).default(0),
      codAmountCents: z.number().int().min(0).default(0),
      originAddress: z.string().min(4),
      originLat: z.number().int().nullish(),
      originLng: z.number().int().nullish(),
      consigneeName: z.string().min(2).max(160),
      consigneePhone: z.string().min(9).max(20),
      destAddress: z.string().min(4),
      destLat: z.number().int().nullish(),
      destLng: z.number().int().nullish(),
      destZoneId: z.string().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "parcels.create",
        entity: "parcels_parcel",
        entityId: (r) => (r as parcelsService.ParcelDetail).parcel.id,
        action: "parcel.booked",
      },
      () =>
        parcelsService.createParcel(
          {
            ...input,
            branchId: isGlobalScope(context.principal.role)
              ? (input.branchId ?? context.principal.branchId)
              : context.principal.branchId,
          },
          context.principal,
        ),
    ),
  );

/**
 * The single transition endpoint. Every status change the clients make comes
 * through here, and it delegates to the one choke point in the parcels service.
 */
export const transition = authedProc
  .input(
    z.object({
      awbOrId: z.string().min(3),
      to: enabledStatusEnum,
      lat: z.number().int().nullish(),
      lng: z.number().int().nullish(),
      notes: z.string().max(500).nullish(),
      /** Client-minted ULID: an offline replay dedupes instead of duplicating (§7). */
      clientId: z.string().max(64).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "parcels.transition",
        entity: "parcels_parcel",
        entityId: (r) => (r as parcelsService.TransitionResult).parcel.id,
        action: `parcel.${input.to}`,
      },
      () =>
        parcelsService.transitionParcel(
          {
            awbOrId: input.awbOrId,
            to: input.to as ParcelStatus,
            lat: input.lat,
            lng: input.lng,
            notes: input.notes,
            clientId: input.clientId,
          },
          context.principal,
        ),
    ),
  );

/**
 * Bulk CSV booking. Rows are validated one by one and booked through the same
 * `createParcel()` choke point as `create`; the response is a per-row report.
 * `dryRun: true` validates without booking — the portal's preview step.
 * A merchant principal must pass its own merchantId (403 otherwise, §5).
 */
export const bulkCreate = authedProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      dryRun: z.boolean().default(false),
      // Rows stay loosely typed at the edge on purpose: one malformed row must
      // become a line in the report, not a 400 that rejects the whole file.
      rows: z.array(z.record(z.string(), z.unknown())).min(1).max(BULK_ROW_LIMIT),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "parcels.bulkCreate",
        entity: "parcels_parcel",
        entityId: (r) => {
          const report = r as BulkReport;
          return `bulk:${report.merchantId}:${report.accepted.length}/${report.total}`;
        },
        action: input.dryRun ? "parcel.bulk.validated" : "parcel.bulk.booked",
      },
      () => bulkCreateParcels(input, context.principal),
    ),
  );

/** Bulk transition, used by the ops hub-receipt screen. */
export const transitionMany = opsProc
  .input(
    z.object({
      awbs: z.array(z.string().min(3)).min(1).max(200),
      to: enabledStatusEnum,
      notes: z.string().max(500).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "parcels.transitionMany",
        entity: "parcels_parcel",
        entityId: () => `bulk:${input.to}:${input.awbs.length}`,
        action: `parcel.bulk.${input.to}`,
      },
      async () => {
        const result = await parcelsService.transitionMany(
          input.awbs,
          input.to as ParcelStatus,
          context.principal,
          { notes: input.notes },
        );
        return {
          moved: result.moved.map((m) => ({ awb: m.parcel.awb, status: m.parcel.status })),
          rejected: result.rejected,
        };
      },
    ),
  );

/**
 * The state machine, served to the clients so the UI never hardcodes a second
 * copy of the transition table. Includes which transitions this milestone
 * exposes and which role may command each.
 */
export const stateMachine = authedProc.handler(({ context }) => ({
  statuses: PARCEL_STATUSES,
  transitions: TRANSITIONS,
  roles: TRANSITION_ROLES,
  enabled: ENABLED_STATUSES,
  // Two numbers, deliberately: what the API accepts vs what is shipped
  // end-to-end. See state-machine.ts for why they differ.
  exposedMilestone: EXPOSED_MILESTONE,
  shippedMilestone: SHIPPED_MILESTONE,
  myRole: context.principal.role,
}));

/**
 * Public consignee tracking (§10 M2, `/track/:awb`). UNAUTHENTICATED by design:
 * a consignee has no NatEx account, only the AWB from the tracking SMS.
 *
 * PDPA No. 9 of 2022 (§9) purpose limitation: an AWB is guessable, so this
 * returns the minimum a consignee needs to know where their parcel is and
 * nothing more. Deliberately NOT returned: consignee name, phone, full address,
 * COD amount, declared value, merchant identity, actor names, device ids, GPS.
 * The staff-scoped `parcels.get` remains the only route with the full record.
 *
 * Rate limited per IP because it is unauthenticated and enumerable.
 */
export const track = publicProc
  .input(z.object({ awb: z.string().min(3).max(24) }))
  .handler(async ({ input, context }) => {
    await publicRead(context, "parcels.track");
    const found = await parcelsService.publicTracking(input.awb);
    if (!found) errors.notFound("Parcel");
    return found;
  });

/** Router namespace — composed into the root router in api/index.ts. */
export const parcels = {
  list,
  get,
  board,
  summary,
  trends,
  create,
  bulkCreate,
  transition,
  transitionMany,
  stateMachine,
  track,
};
