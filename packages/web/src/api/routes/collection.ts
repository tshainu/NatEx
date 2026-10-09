import { z } from "zod";
import { authedProc, mutate, opsProc, readProc, riderProc } from "../middleware/pipeline";
import { requireRole } from "../middleware/auth";
import * as collectionService from "../modules/collection/service";
import * as pickups from "../modules/collection/pickups";

/** A pickup is asked for by the merchant, or by ops on the merchant's behalf. */
const pickupDeskProc = authedProc.use(requireRole("merchant", "ops", "admin"));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * collection routes — pickup manifests and the two-party handover.
 * M1's whole point: parcels actually enter NatEx custody here.
 */

/**
 * readProc: a merchant reads its own manifests (the service scopes it and
 * refuses a merchant naming another merchant with 403, §5).
 */
export const list = readProc
  .input(
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      pickupDate: isoDate.optional(),
      riderId: z.string().optional(),
      merchantId: z.string().optional(),
    }),
  )
  .handler(({ input, context }) => collectionService.listManifests(input, context.principal));

export const get = readProc
  .input(z.object({ id: z.string().min(1) }))
  .handler(({ input, context }) =>
    collectionService.getManifestDetail(input.id, context.principal),
  );

/** The rider app's home screen. */
export const riderToday = riderProc
  .input(
    z.object({
      pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  )
  .handler(({ input, context }) =>
    collectionService.riderToday(context.principal, input.pickupDate),
  );

export const create = opsProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      riderId: z.string().min(1),
      pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      awbs: z.array(z.string().min(3)).min(1).max(300),
      pickupRequestId: z.string().min(1).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "collection.create",
        entity: "collection_manifest",
        entityId: (r) => (r as collectionService.ManifestDetail).manifest.id,
        action: "manifest.created",
      },
      () => collectionService.createManifest(input, context.principal),
    ),
  );

/**
 * A scan records presence on the manifest. It deliberately does NOT move
 * custody — that happens once, at handover (§5, two-party handover).
 */
export const scan = riderProc
  .input(
    z.object({
      manifestId: z.string().min(1),
      awb: z.string().min(3),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "collection.scan",
        entity: "collection_manifest_item",
        entityId: (r) => (r as collectionService.ScanItemResult).item.id,
        action: "manifest.item_scanned",
        bucket: { capacity: 300, refillPerMinute: 300 },
      },
      () => collectionService.scanItem(input, context.principal),
    ),
  );

export const handover = riderProc
  .input(
    z.object({
      manifestId: z.string().min(1),
      handoverByName: z.string().min(2).max(120),
      signatureUrl: z.string().max(500).nullish(),
      lat: z.number().int().nullish(),
      lng: z.number().int().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "collection.handover",
        entity: "collection_manifest",
        entityId: () => input.manifestId,
        action: "manifest.handed_over",
      },
      () => collectionService.handoverManifest(input, context.principal),
    ),
  );

/** Ops receives a rider's bag at the hub: PickedUp → AtOriginHub. */
export const receiveAtHub = opsProc
  .input(
    z.object({
      awbs: z.array(z.string().min(3)).min(1).max(300),
      lat: z.number().int().nullish(),
      lng: z.number().int().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "collection.receiveAtHub",
        entity: "parcels_parcel",
        entityId: () => `hub-receipt:${input.awbs.length}`,
        action: "parcel.received_at_hub",
      },
      () => collectionService.scanIntoHub(input, context.principal),
    ),
  );

/** Riders hand in at the hub from the app too — same service, rider-scoped. */
export const riderHandIn = riderProc
  .input(
    z.object({
      awbs: z.array(z.string().min(3)).min(1).max(300),
      lat: z.number().int().nullish(),
      lng: z.number().int().nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "collection.riderHandIn",
        entity: "parcels_parcel",
        entityId: () => `hub-handin:${input.awbs.length}`,
        action: "parcel.handed_in_at_hub",
      },
      () => collectionService.scanIntoHub(input, context.principal),
    ),
  );

/** Router namespace — composed into the root router in api/index.ts. */
// ------------------------------------------------------- pickup requests

const pickupStatus = z.enum(["requested", "scheduled", "cancelled"]);

export const pickupRequests = readProc
  .input(
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      status: z.array(pickupStatus).optional(),
      merchantId: z.string().optional(),
      pickupDate: isoDate.optional(),
    }),
  )
  .handler(({ input, context }) => pickups.listPickupRequests(input, context.principal));

export const pickupRequestCounts = readProc
  .input(z.object({ merchantId: z.string().optional() }))
  .handler(({ input, context }) => pickups.pickupRequestCounts(input, context.principal));

export const pickupRequestGet = readProc
  .input(z.object({ id: z.string().min(1) }))
  .handler(({ input, context }) => pickups.getPickupRequest(input.id, context.principal));

export const requestPickup = pickupDeskProc
  .input(
    z.object({
      merchantId: z.string().min(1),
      pickupDate: isoDate,
      window: z.enum(["morning", "afternoon"]),
      awbs: z.array(z.string().min(3)).min(1).max(300),
      notes: z.string().max(500).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "collection.requestPickup",
        entity: "collection_pickup_request",
        entityId: (r) => (r as pickups.PickupRequestView).id,
        action: "pickup.requested",
      },
      () => pickups.requestPickup(input, context.principal),
    ),
  );

export const cancelPickupRequest = pickupDeskProc
  .input(z.object({ id: z.string().min(1), reason: z.string().trim().min(5).max(300) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "collection.cancelPickupRequest",
        entity: "collection_pickup_request",
        entityId: () => input.id,
        action: "pickup.cancelled",
      },
      () => pickups.cancelPickupRequest(input, context.principal),
    ),
  );

export const collection = {
  list,
  get,
  pickupRequests,
  pickupRequestCounts,
  pickupRequestGet,
  requestPickup,
  cancelPickupRequest,
  riderToday,
  create,
  scan,
  handover,
  receiveAtHub,
  riderHandIn,
};
