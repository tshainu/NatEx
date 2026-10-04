import { z } from "zod";
import { mutate, staffProc, transportProc } from "../middleware/pipeline";
import * as transportService from "../modules/transport/service";
import { POD_PHOTO_TYPES, presignGet, presignPut } from "../shared/storage";
import { errors } from "../shared/errors";
import { ulid } from "../shared/ulid";

/**
 * transport routes — Milestone 2: bagging, linehaul trips, two-party hub
 * receipt with variance detection, the hub scan log and the Ops exception
 * queue (PROJECT.md §5 transport module, §7 custody rules, §10 M2).
 *
 * Reads are `staffProc` (the service row-scopes to the caller's branch unless
 * the role is global). Every mutation is `transportProc` and goes through
 * `mutate()` so it inherits idempotency, rate limiting and the audit row —
 * scanners retry constantly, so a replayed scan must never double-count.
 */

const awb = z.string().min(3).max(24);
const geo = {
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  clientId: z.string().max(64).nullish(),
};

// ---------------------------------------------------------------------- bags

export const bagList = staffProc
  .input(
    z.object({
      status: z
        .array(
          z.enum(["open", "sealed", "in_transit", "received", "reconciled", "cancelled"]),
        )
        .optional(),
      destHubId: z.string().optional(),
      tripId: z.string().optional(),
    }),
  )
  .handler(({ input, context }) => transportService.listBags(context.principal, input));

export const bagGet = staffProc
  .input(z.object({ bagId: z.string().min(1) }))
  .handler(({ input, context }) => transportService.getBagDetail(input.bagId, context.principal));

export const bagCreate = transportProc
  .input(
    z.object({
      destHubId: z.string().min(1),
      originHubId: z.string().min(1).optional(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagCreate",
        entity: "transport_bag",
        entityId: (r) => (r as transportService.BagRow).id,
        action: "bag.created",
      },
      () => transportService.createBag(input, context.principal),
    ),
  );

/**
 * The bulk scan. One call carries the whole burst of labels and comes back with
 * a verdict per label (§10 M2) rather than failing the batch on the first stray.
 */
export const bagScan = transportProc
  .input(
    z.object({
      bagId: z.string().min(1),
      awbs: z.array(awb).min(1).max(300),
      ...geo,
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagScan",
        entity: "transport_bag",
        entityId: (r) => (r as transportService.BulkScanResult).bag.id,
        action: "bag.scanned",
      },
      () => transportService.bulkScanIntoBag(input, context.principal),
    ),
  );

export const bagRemove = transportProc
  .input(z.object({ bagId: z.string().min(1), awb }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagRemove",
        entity: "transport_bag",
        entityId: (r) => (r as transportService.BulkScanResult).bag.id,
        action: "bag.item_removed",
      },
      () => transportService.removeFromBag(input, context.principal),
    ),
  );

export const bagSeal = transportProc
  .input(z.object({ bagId: z.string().min(1), sealNumber: z.string().min(3).max(32) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagSeal",
        entity: "transport_bag",
        entityId: (r) => (r as transportService.BagRow).id,
        action: "bag.sealed",
      },
      () => transportService.sealBag(input, context.principal),
    ),
  );

/** Breaking a seal is always an exception, never a quiet correction (§7). */
export const bagBreakSeal = transportProc
  .input(z.object({ bagId: z.string().min(1), reason: z.string().min(5).max(400) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagBreakSeal",
        entity: "transport_bag",
        entityId: (r) => (r as transportService.BagRow).id,
        action: "bag.seal_broken",
      },
      () => transportService.breakSeal(input, context.principal),
    ),
  );

export const baggable = staffProc
  .input(z.object({}))
  .handler(({ context }) => transportService.baggableParcels(context.principal));

// --------------------------------------------------------------------- trips

export const tripList = staffProc
  .input(z.object({}))
  .handler(({ context }) => transportService.linehaulBoard(context.principal));

export const tripGet = staffProc
  .input(z.object({ tripId: z.string().min(1) }))
  .handler(({ input, context }) => transportService.getTripDetail(input.tripId, context.principal));

/**
 * Round 6 vehicle fields are optional here so older clients and scripts keep
 * working; the web form requires them. The service enforces the one hard rule —
 * a bus always names its operator.
 */
export const tripCreate = transportProc
  .input(
    z.object({
      vehicleRegistration: z.string().min(3).max(24),
      destHubId: z.string().min(1),
      driverId: z.string().min(1).nullish(),
      route: z.string().max(120).nullish(),
      originHubId: z.string().min(1).optional(),
      vehicleType: z.enum(transportService.TRIP_VEHICLE_TYPES).nullish(),
      busOperator: z.enum(transportService.BUS_OPERATORS).nullish(),
      contactName: z.string().trim().min(2).max(80).nullish(),
      contactPhone: z.string().trim().min(9).max(16).nullish(),
      expectedArrivalAt: z.coerce.date().nullish(),
      arrivalStation: z.string().trim().min(2).max(120).nullish(),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.tripCreate",
        entity: "transport_trip",
        entityId: (r) => (r as transportService.TripRow).id,
        action: "trip.created",
      },
      () => transportService.createTrip(input, context.principal),
    ),
  );

// ---------------------------------------------------------------- bag photo

/**
 * An upload slot for the optional photo of one bag. The browser PUTs the image
 * straight to object storage, then names the returned ref on bagPhotoAttach.
 */
export const bagPhotoUpload = transportProc
  .input(z.object({ bagId: z.string().min(1), contentType: z.enum(POD_PHOTO_TYPES) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagPhotoUpload",
        entity: "transport_bag",
        entityId: () => input.bagId,
        action: "bag_photo.upload_slot",
        bucket: { capacity: 30, refillPerMinute: 15 },
        idempotency: false,
      },
      async () => {
        const row = await transportService.bagForPhoto(input.bagId, context.principal);
        const sub = input.contentType.split("/")[1]!;
        const ext = sub === "jpeg" ? "jpg" : sub;
        return presignPut(`${transportService.bagPhotoPrefix(row.code)}${ulid()}.${ext}`, input.contentType);
      },
    ),
  );

export const bagPhotoAttach = transportProc
  .input(z.object({ bagId: z.string().min(1), storageRef: z.string().min(4).max(200) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagPhotoAttach",
        entity: "transport_bag",
        entityId: () => input.bagId,
        action: "bag.photo_attached",
      },
      () => transportService.attachBagPhoto(input, context.principal),
    ),
  );

/** A five-minute read link for a bag's photo. Same scope as reading the bag. */
export const bagPhotoView = staffProc
  .input(z.object({ bagId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const row = await transportService.bagForPhoto(input.bagId, context.principal);
    if (!row.photoRef) errors.notFound("Bag photo");
    return presignGet(row.photoRef!);
  });

export const tripLoad = transportProc
  .input(z.object({ tripId: z.string().min(1), bagId: z.string().min(1) }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.tripLoad",
        entity: "transport_trip",
        entityId: () => input.tripId,
        action: "trip.bag_loaded",
      },
      () => transportService.loadBagOntoTrip(input, context.principal),
    ),
  );

/**
 * Departure is the Bagged → InTransit moment for every parcel aboard, and §6
 * refuses it outright while any loaded bag is unsealed.
 */
export const tripDepart = transportProc
  .input(
    z.object({
      tripId: z.string().min(1),
      seal: z.string().min(3).max(32),
      lat: geo.lat,
      lng: geo.lng,
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.tripDepart",
        entity: "transport_trip",
        entityId: () => input.tripId,
        action: "trip.departed",
      },
      () => transportService.departTrip(input, context.principal),
    ),
  );

/** Arrival moves the vehicle, not the parcels — those move on hub receipt. */
export const tripArrive = transportProc
  .input(z.object({ tripId: z.string().min(1), lat: geo.lat, lng: geo.lng }))
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.tripArrive",
        entity: "transport_trip",
        entityId: (r) => (r as transportService.TripRow).id,
        action: "trip.arrived",
      },
      () => transportService.arriveTrip(input, context.principal),
    ),
  );

// -------------------------------------------------------------- hub receipt

export const inbound = staffProc
  .input(z.object({}))
  .handler(({ context }) => transportService.inboundBags(context.principal));

/**
 * Two-party hub receipt (§7). The presented seal and the physically scanned
 * AWBs are both inputs, and both named parties are recorded; any disagreement
 * with the origin hub's manifest becomes an exception in the response.
 */
export const bagReceive = transportProc
  .input(
    z.object({
      bagId: z.string().min(1),
      scannedAwbs: z.array(awb).max(300),
      sealNumber: z.string().max(32).nullish(),
      releasedByName: z.string().min(2).max(120),
      receivedByName: z.string().max(120).nullish(),
      ...geo,
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.bagReceive",
        entity: "transport_bag",
        entityId: (r) => (r as transportService.ReceiveBagResult).bag.id,
        action: "bag.received",
      },
      () => transportService.receiveBag(input, context.principal),
    ),
  );

// ------------------------------------------------- scan log, chain, queues

export const scans = staffProc
  .input(
    z.object({
      kind: z
        .enum(["bag_in", "bag_out", "parcel_in", "parcel_out", "bag_receive", "trip_load"])
        .optional(),
      outcome: z.enum(["accepted", "duplicate", "rejected"]).optional(),
      search: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  )
  .handler(({ input, context }) => transportService.scanLog(context.principal, input));

/** The full chain of custody for one AWB: timeline + bag + trip + scans. */
export const custody = staffProc
  .input(z.object({ awb }))
  .handler(({ input, context }) => transportService.custodyChain(input.awb, context.principal));

export const exceptions = staffProc
  .input(
    z.object({
      status: z
        .array(z.enum(["open", "investigating", "resolved", "written_off"]))
        .optional(),
      kind: z.string().max(40).optional(),
      search: z.string().max(40).optional(),
    }),
  )
  .handler(({ input, context }) => transportService.listExceptions(context.principal, input));

export const exceptionResolve = transportProc
  .input(
    z.object({
      exceptionId: z.string().min(1),
      status: z.enum(["investigating", "resolved", "written_off"]),
      resolution: z.string().min(5).max(800),
    }),
  )
  .handler(({ input, context }) =>
    mutate(
      context,
      input,
      {
        route: "transport.exceptionResolve",
        entity: "transport_exception",
        entityId: (r) => (r as transportService.ExceptionRow).id,
        action: "exception.resolved",
      },
      () => transportService.resolveException(input, context.principal),
    ),
  );

export const counts = staffProc
  .input(z.object({}))
  .handler(({ context }) => transportService.transportCounts(context.principal));

/** Router namespace — composed into the root router in api/index.ts. */
export const transport = {
  bagList,
  bagGet,
  bagCreate,
  bagScan,
  bagRemove,
  bagSeal,
  bagBreakSeal,
  baggable,
  bagPhotoUpload,
  bagPhotoAttach,
  bagPhotoView,
  tripList,
  tripGet,
  tripCreate,
  tripLoad,
  tripDepart,
  tripArrive,
  inbound,
  bagReceive,
  scans,
  custody,
  exceptions,
  exceptionResolve,
  counts,
};
